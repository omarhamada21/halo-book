import jwt from 'jsonwebtoken';
import { JWT_SECRET, isRootUser, isAdminEmail } from '../config/env.js';
import { db } from '../db/client.js';

// ----------------- AUTHENTICATION & ACCESS CONTROL -----------------
// Verifies JWT signature from cookie/header, loads fresh DB user state, and enforces active authorization.
// Auto-promotes configured ROOT_EMAIL and ADMIN_EMAILS so designated admins retain elevated privileges across redeploys.
async function authenticateToken(req, res, next) {
  const token = req.cookies.halo_token || (req.headers['authorization'] && req.headers['authorization'].split(' ')[1]);
  const isApi = (req.originalUrl && req.originalUrl.startsWith('/api/')) || req.path.startsWith('/api/');

  if (!token) {
    if (isApi) return res.status(401).json({ success: false, error: 'Authentication required. Please log in.' });
    return res.redirect('/login.html');
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const result = await db.execute({
      sql: 'SELECT id, name, email, status, role FROM users WHERE id = ?',
      args: [Number(decoded.id)]
    });

    const dbUser = result.rows[0];
    if (!dbUser) {
      res.clearCookie('halo_token');
      if (isApi) return res.status(401).json({ success: false, error: 'Authentication required. Please log in.' });
      return res.redirect('/login.html');
    }

    const userObj = {
      id: Number(dbUser.id),
      name: dbUser.name,
      email: dbUser.email,
      status: dbUser.status,
      role: dbUser.role
    };

    // Auto-promotes users matching ROOT_EMAIL / ADMIN_EMAILS to maintain authority without requiring manual DB interventions
    if (isRootUser(userObj.email) && userObj.role !== 'root') {
      await db.execute({ sql: "UPDATE users SET role = 'root', status = 'approved' WHERE id = ?", args: [userObj.id] });
      userObj.role = 'root';
      userObj.status = 'approved';
    } else if (isAdminEmail(userObj.email) && userObj.role === 'teacher') {
      await db.execute({ sql: "UPDATE users SET role = 'admin', status = 'approved' WHERE id = ?", args: [userObj.id] });
      userObj.role = 'admin';
      userObj.status = 'approved';
    }

    req.user = userObj;
    next();
  } catch (err) {
    if (isApi) return res.status(403).json({ success: false, error: 'Session expired. Please log in again.' });
    return res.redirect('/login.html');
  }
}

function requireApprovedUser(req, res, next) {
  if (['root', 'admin'].includes(req.user?.role) || req.user?.status === 'approved') return next();
  const isApi = (req.originalUrl && req.originalUrl.startsWith('/api/')) || req.path.startsWith('/api/');
  if (isApi) {
    return res.status(403).json({ success: false, error: 'Your account is pending approval.' });
  }
  return res.status(403).json({ error: 'Access Denied: Your account is pending authorization by an administrator.' });
}

function requireAdmin(req, res, next) {
  if (!req.user || !['root', 'admin'].includes(req.user.role)) {
    const isApi = (req.originalUrl && req.originalUrl.startsWith('/api/')) || req.path.startsWith('/api/');
    if (isApi) {
      return res.status(403).json({ success: false, error: 'Administrator authorization required.' });
    }
    return res.status(403).json({ error: 'Administrator authorization required.' });
  }
  next();
}

export { authenticateToken, requireApprovedUser, requireAdmin };
