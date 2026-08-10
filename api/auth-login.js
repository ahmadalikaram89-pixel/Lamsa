import { redis } from './_db.js';
import { resolveLoginEmail, getUser, verifyPassword, createSession, setSessionCookie } from './_auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!redis) {
    console.error('[auth-login] Upstash Redis not configured');
    return res.status(500).json({ error: 'Database not configured' });
  }

  // The `email` field accepts either an email address or a username — kept
  // as `email` for frontend/API compatibility, resolved below.
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: 'Please enter your email or username and password' });
  }

  try {
    // Same generic error whether the identifier is unknown or the password
    // is wrong — don't let a login attempt reveal which accounts exist.
    const genericError = () => res.status(401).json({ error: 'Invalid email/username or password' });

    const resolvedEmail = await resolveLoginEmail(email);
    if (!resolvedEmail) return genericError();

    const user = await getUser(resolvedEmail);
    if (!user) return genericError();

    const valid = await verifyPassword(password, user.passwordSalt, user.passwordHash);
    if (!valid) return genericError();

    const token = await createSession(resolvedEmail);
    setSessionCookie(res, req, token);

    console.log('[auth-login] logged in', resolvedEmail);
    return res.status(200).json({ username: user.username, email: user.email });
  } catch (err) {
    console.error('[auth-login] error:', err.message);
    return res.status(500).json({ error: 'Login failed' });
  }
}
