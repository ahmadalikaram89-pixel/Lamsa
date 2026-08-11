import { redis, deductCredit, addCredits, ensureWelcomeCredit } from './_db.js';
import { requireSessionEmail } from './_auth.js';

// Temporary QA bypass while the team tests the redesign-strength fix and
// other in-flight UI work without burning through the single free credit.
// Scoped to one account (rather than a global bypass) so it can't be
// abused by other users while active. Remove once testing is done.
const CREDIT_BYPASS_EMAILS = new Set(['team@smartordi.eu']);

// Every generation now compares two different AIs' takes on the same room
// instead of trusting a single model — Flux Kontext Pro (fast, cheap,
// consistent) alongside Nano Banana Pro (Gemini 3 Pro Image; better at
// reasoning about lighting/object relationships). The user picks whichever
// result looks best. Combined cost is still well under what a single credit
// sells for, so this runs unconditionally rather than as an opt-in.
const FLUX_SUBMIT_URL = 'https://queue.fal.run/fal-ai/flux-pro/kontext';
const NANO_SUBMIT_URL = 'https://queue.fal.run/fal-ai/nano-banana-pro/edit';

// Splits the requested image count across both models so every generation
// includes at least one result from each — even a single requested image
// becomes one from each model, guaranteeing a comparison — rather than ever
// coming back as one model's opinion alone.
function splitCounts(total) {
  const n = Math.max(1, Number(total) || 1);
  if (n === 1) return { flux: 1, nano: 1 };
  const nano = Math.floor(n / 2);
  return { flux: n - nano, nano };
}

function buildFluxBody({ prompt, image_url, count, guidance_scale, aspect_ratio, strength }) {
  const body = {
    prompt,
    image_url: image_url || undefined,
    num_images: count,
    guidance_scale,
    aspect_ratio,
    output_format: 'jpeg',
    safety_tolerance: '2'
  };
  // strength (0-1) caps how much the output is allowed to differ from
  // image_url, independent of guidance_scale (which only controls how
  // closely the model follows the prompt). fal.ai defaults this to 0.1 when
  // omitted — far too conservative for a full room redesign — so only the
  // caller's explicit choice is forwarded, and only when there's a source
  // image to edit.
  if (image_url && typeof strength === 'number') {
    body.strength = strength;
  }
  return body;
}

function buildNanoBody({ prompt, image_url, count }) {
  const body = {
    prompt,
    num_images: count,
    output_format: 'jpeg'
  };
  if (image_url) body.image_urls = [image_url];
  return body;
}

async function submitToFal(FAL_API_KEY, url, body) {
  const falRes = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Key ${FAL_API_KEY}`
    },
    body: JSON.stringify(body)
  });

  const rawText = await falRes.text();
  let data;
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch (parseErr) {
    throw new Error('Non-JSON response from fal.ai (' + falRes.status + '): ' + rawText.slice(0, 300));
  }

  if (!falRes.ok) {
    throw new Error('fal.ai submit failed (' + falRes.status + '): ' + rawText.slice(0, 300));
  }
  if (!data.request_id) {
    throw new Error('fal.ai submit response missing request_id: ' + rawText.slice(0, 300));
  }
  return data.request_id;
}

export default async function handler(req, res) {
  console.log('[api/generate] handler invoked, method:', req.method);

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const FAL_API_KEY = (process.env.FAL_API_KEY || '').trim().replace(/\s+/g, '');
  if (!FAL_API_KEY) {
    console.error('[api/generate] FAL_API_KEY not configured');
    return res.status(500).json({ error: 'FAL_API_KEY not configured' });
  }

  const { prompt, image_url, num_images = 1, guidance_scale = 3.5, aspect_ratio = '16:9', strength } = req.body;

  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  if (!redis) {
    console.error('[api/generate] Upstash Redis not configured');
    return res.status(500).json({ error: 'Database not configured' });
  }

  // The email that gets billed/credited comes only from the verified
  // session cookie, never from the request body — a client-supplied email
  // can't be trusted to spend or refund someone else's credits.
  const normalizedEmail = await requireSessionEmail(req);
  if (!normalizedEmail) {
    return res.status(401).json({ error: 'Please log in', code: 'not_logged_in' });
  }

  // Defensive fallback — the welcome credit is normally granted right at
  // registration, but this covers any account that predates that or was
  // created some other way. A no-op if the balance already exists.
  await ensureWelcomeCredit(normalizedEmail);

  if (CREDIT_BYPASS_EMAILS.has(normalizedEmail)) {
    // Top up by 1 right before the deduction below spends it — net zero
    // effect on the stored balance, just guarantees it's never 0.
    await addCredits(normalizedEmail, 1);
  }

  const newBalance = await deductCredit(normalizedEmail);
  if (newBalance === null) {
    console.log('[api/generate] blocked - no credits remaining for', normalizedEmail);
    return res.status(402).json({ error: 'No credits remaining', code: 'no_credits' });
  }
  console.log('[api/generate] deducted 1 credit from', normalizedEmail, '- remaining:', newBalance);

  // Wrapped separately from the main try/catch below so a failure in the
  // refund call itself can't fall into that catch block and trigger a
  // second refund attempt for the same failed request.
  async function refundCredit() {
    try {
      await addCredits(normalizedEmail, 1);
    } catch (refundErr) {
      console.error('[api/generate] refund failed for', normalizedEmail, '-', refundErr.message);
    }
  }

  // Submit to the fal.ai QUEUE instead of the synchronous endpoint. These
  // generations regularly take 15-30s+, which exceeds Vercel's serverless
  // function timeout on the sync endpoint (the function gets killed
  // mid-request and the frontend is left spinning forever). The queue
  // endpoint returns a request_id immediately; the frontend polls
  // /api/status for completion.
  const counts = splitCounts(num_images);

  const submissions = [];
  if (counts.flux > 0) {
    const fluxBody = buildFluxBody({ prompt, image_url, count: counts.flux, guidance_scale, aspect_ratio, strength });
    console.log('[api/generate] submitting to flux:', JSON.stringify(fluxBody));
    submissions.push(
      submitToFal(FAL_API_KEY, FLUX_SUBMIT_URL, fluxBody)
        .then((request_id) => ({ model: 'flux', request_id }))
        .catch((err) => {
          console.error('[api/generate] flux submit failed:', err.message);
          return { model: 'flux', error: err.message };
        })
    );
  }
  if (counts.nano > 0) {
    const nanoBody = buildNanoBody({ prompt, image_url, count: counts.nano });
    console.log('[api/generate] submitting to nano-banana-pro:', JSON.stringify(nanoBody));
    submissions.push(
      submitToFal(FAL_API_KEY, NANO_SUBMIT_URL, nanoBody)
        .then((request_id) => ({ model: 'nano', request_id }))
        .catch((err) => {
          console.error('[api/generate] nano-banana-pro submit failed:', err.message);
          return { model: 'nano', error: err.message };
        })
    );
  }

  let results;
  try {
    results = await Promise.all(submissions);
  } catch (err) {
    // Promise.all itself only rejects on a bug above (both branches already
    // catch their own errors into { error } objects) — treat it the same as
    // a total failure.
    console.error('[api/generate] unexpected submit error:', err.message);
    await refundCredit();
    return res.status(500).json({ error: err.message });
  }

  const requests = results.filter((r) => r.request_id);
  console.log('[api/generate] submit results:', JSON.stringify(results));

  if (requests.length === 0) {
    await refundCredit(); // neither job was actually queued
    return res.status(502).json({ error: 'Generation failed', details: results });
  }

  return res.status(200).json({ requests });
}
