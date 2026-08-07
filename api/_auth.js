import { supabaseAdmin, supabaseAnon } from './_supabase.js';

const ACCESS_COOKIE = 'lamsa_at';
const REFRESH_COOKIE = 'lamsa_rt';
// Supabase refresh tokens are long-lived by default; 30 days matches the
// session lifetime the app had under the previous Redis-backed sessions.
const REFRESH_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Returns the created user, or null if the email is already registered.
export async function createUser({ username, email, password, country }) {
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // no separate email-verification step, matching the previous flow
    user_metadata: { username, country: country || null }
  });
  if (error) {
    if (error.code === 'email_exists') return null;
    throw error;
  }
  return data.user;
}

// Returns a Supabase session ({ access_token, refresh_token, expires_in, user })
// on success, or null on bad credentials.
export async function signIn(email, password) {
  const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });
  if (error) return null;
  return data.session;
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  header.split(';').forEach(function (pair) {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) cookies[k] = decodeURIComponent(v);
  });
  return cookies;
}

export function getSessionTokensFromRequest(req) {
  const cookies = parseCookies(req);
  return {
    accessToken: cookies[ACCESS_COOKIE] || null,
    refreshToken: cookies[REFRESH_COOKIE] || null
  };
}

function cookieAttrs(req) {
  const isLocal = !!(req && req.headers.host && req.headers.host.indexOf('localhost') !== -1);
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (!isLocal) attrs.push('Secure');
  return attrs;
}

export function setSessionCookies(res, req, session) {
  const attrs = cookieAttrs(req);
  const accessMaxAge = Math.max(session.expires_in || 3600, 60);
  res.setHeader('Set-Cookie', [
    [ACCESS_COOKIE + '=' + session.access_token, 'Max-Age=' + accessMaxAge].concat(attrs).join('; '),
    [REFRESH_COOKIE + '=' + session.refresh_token, 'Max-Age=' + REFRESH_COOKIE_MAX_AGE].concat(attrs).join('; ')
  ]);
}

export function clearSessionCookies(res, req) {
  const attrs = ['Max-Age=0'].concat(cookieAttrs(req));
  res.setHeader('Set-Cookie', [
    [ACCESS_COOKIE + '='].concat(attrs).join('; '),
    [REFRESH_COOKIE + '='].concat(attrs).join('; ')
  ]);
}

function toSessionUser(user) {
  return {
    id: user.id,
    email: user.email,
    username: (user.user_metadata && user.user_metadata.username) || ''
  };
}

// Resolves the authenticated session's user for a request — the only
// identity source api/generate.js, api/credits.js, api/create-checkout-session.js,
// and api/me.js should trust. A client-supplied email in the request
// body/query is never sufficient on its own.
//
// Transparently refreshes an expired access token using the refresh token
// cookie and re-issues both cookies on `res` when that happens, so callers
// don't need to think about token expiry themselves.
export async function requireSessionUser(req, res) {
  const { accessToken, refreshToken } = getSessionTokensFromRequest(req);
  if (!accessToken && !refreshToken) return null;

  if (accessToken) {
    const { data, error } = await supabaseAnon.auth.getUser(accessToken);
    if (!error && data.user) return toSessionUser(data.user);
  }

  if (!refreshToken) return null;

  const { data, error } = await supabaseAnon.auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session) return null;

  if (res) setSessionCookies(res, req, data.session);
  return toSessionUser(data.session.user);
}

// Best-effort: revokes the session's refresh token server-side (scope
// 'global' also invalidates any other active session for the account) so a
// leaked refresh token can't outlive an explicit logout. Never throws —
// the cookies are cleared by the caller regardless of this succeeding.
export async function destroySession(accessToken) {
  if (!accessToken) return;
  try {
    await supabaseAdmin.auth.admin.signOut(accessToken, 'global');
  } catch (err) {
    console.error('[auth] signOut failed:', err.message);
  }
}
