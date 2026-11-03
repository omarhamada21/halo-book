import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { isProduction, JWT_SECRET, GOOGLE_CLIENT_ID, isRootUser, isAdminEmail, isStrongPassword } from '../../config/env.js';
import { db } from '../../db/client.js';
import { googleOAuthClient } from '../../integrations/googleOAuth.js';
import { authenticateToken } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rateLimit.js';

export function registerAuthRoutes(app) {

// ----------------- AUTH ROUTES -----------------
app.get('/api/auth/config', (req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID }));

app.post('/api/auth/register', rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }), async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Please provide all required fields.' });

    const cleanEmail = email.toLowerCase().trim();
    if (!isStrongPassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters and include uppercase, lowercase, a number, and a special character.' });
    }

    const checkUser = await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [cleanEmail] });
    if (checkUser.rows.length > 0) return res.status(400).json({ error: 'An account with this email already exists.' });

    const initialRole = isRootUser(cleanEmail) ? 'root' : isAdminEmail(cleanEmail) ? 'admin' : 'teacher';
    const initialStatus = ['root', 'admin'].includes(initialRole) ? 'approved' : 'pending';

    const hashedPassword = await bcrypt.hash(password, 10);
    const insert = await db.execute({
      sql: 'INSERT INTO users (name, email, password, status, role) VALUES (?, ?, ?, ?, ?)',
      args: [name.trim(), cleanEmail, hashedPassword, initialStatus, initialRole]
    });

    const token = jwt.sign(
      { id: Number(insert.lastInsertRowid), name: name.trim(), email: cleanEmail, status: initialStatus, role: initialRole },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.cookie('halo_token', token, { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/', maxAge: 7 * 24 * 60 * 60 * 1000 });
    return res.json({ success: true, user: { name: name.trim(), email: cleanEmail, status: initialStatus, role: initialRole } });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Server error during registration.' });
  }
});

app.post('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 15 }), async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Please provide email and password.' });

    const cleanEmail = email.toLowerCase().trim();
    const result = await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [cleanEmail] });
    const user = result.rows[0];

    if (!user || !user.password) return res.status(400).json({ error: 'Invalid credentials.' });
    const validPassword = await bcrypt.compare(password, String(user.password));
    if (!validPassword) return res.status(400).json({ error: 'Invalid credentials.' });

    let userRole = user.role;
    let userStatus = user.status;

    if (isRootUser(cleanEmail) && user.role !== 'root') {
      await db.execute({ sql: "UPDATE users SET role = 'root', status = 'approved' WHERE id = ?", args: [Number(user.id)] });
      userRole = 'root';
      userStatus = 'approved';
    } else if (isAdminEmail(cleanEmail) && user.role === 'teacher') {
      await db.execute({ sql: "UPDATE users SET role = 'admin', status = 'approved' WHERE id = ?", args: [Number(user.id)] });
      userRole = 'admin';
      userStatus = 'approved';
    }

    const token = jwt.sign(
      { id: Number(user.id), name: user.name, email: user.email, status: userStatus, role: userRole },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.cookie('halo_token', token, { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/', maxAge: 7 * 24 * 60 * 60 * 1000 });
    return res.json({ success: true, user: { name: user.name, email: user.email, status: userStatus, role: userRole } });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Server error during login.' });
  }
});

// Secure Google OAuth Verification
app.post('/api/auth/google', rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }), async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: 'Missing credential token.' });

    const ticket = await googleOAuthClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      return res.status(401).json({ error: 'Invalid Google credential.' });
    }

    const email = payload.email.toLowerCase().trim();
    const name = payload.name || email.split('@')[0];

    const existingResult = await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [email] });
    let user = existingResult.rows[0];

    if (!user) {
      const initialRole = isRootUser(email) ? 'root' : isAdminEmail(email) ? 'admin' : 'teacher';
      const initialStatus = ['root', 'admin'].includes(initialRole) ? 'approved' : 'pending';
      const insert = await db.execute({
        sql: 'INSERT INTO users (name, email, password, google_id, status, role) VALUES (?, ?, ?, ?, ?, ?)',
        args: [name, email, 'GOOGLE_AUTH_ACCOUNT', payload.sub || '', initialStatus, initialRole]
      });
      user = { id: Number(insert.lastInsertRowid), name, email, status: initialStatus, role: initialRole };
    }

    const token = jwt.sign(
      { id: Number(user.id), name: user.name, email: user.email, status: user.status, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.cookie('halo_token', token, { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/', maxAge: 7 * 24 * 60 * 60 * 1000 });
    return res.json({ success: true, user: { name: user.name, email: user.email, status: user.status, role: user.role } });
  } catch (error) {
    console.error('Google Verification Error:', error.message);
    return res.status(401).json({ error: 'Google authentication signature verification failed.' });
  }
});
}

export function registerAuthSessionRoutes(app) {

app.get('/api/auth/me', authenticateToken, (req, res) => res.json({ success: true, user: req.user }));
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('halo_token');
  res.json({ success: true });
});
}
