import { supabaseConfigured } from './_supabase.js';
import { EMAIL_RE, signIn, setSessionCookies } from './_auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!supabaseConfigured) {
    console.error('[auth-login] Supabase not configured');
    return res.status(500).json({ error: 'Database not configured' });
  }

  const { email, password } = req.body || {};
  const normalizedEmail = (email || '').trim().toLowerCase();

  if (!EMAIL_RE.test(normalizedEmail) || !password) {
    return res.status(400).json({ error: 'Please enter your email and password' });
  }

  try {
    const session = await signIn(normalizedEmail, password);
    // Same generic error whether the email is unknown or the password is
    // wrong — don't let a login attempt reveal which accounts exist.
    if (!session) return res.status(401).json({ error: 'Invalid email or password' });

    setSessionCookies(res, req, session);

    const username = (session.user.user_metadata && session.user.user_metadata.username) || '';
    console.log('[auth-login] logged in', normalizedEmail);
    return res.status(200).json({ username, email: normalizedEmail });
  } catch (err) {
    console.error('[auth-login] error:', err.message);
    return res.status(500).json({ error: 'Login failed' });
  }
}
