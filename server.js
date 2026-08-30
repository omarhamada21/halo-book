import express from 'express';
import multer from 'multer';
import mammoth from 'mammoth';
import { GoogleGenAI } from '@google/genai';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import { createClient } from '@libsql/client';
import crypto from 'crypto';

const require = createRequire(import.meta.url);

let pdfParse;
try {
  const pdfModule = require('pdf-parse');
  pdfParse = typeof pdfModule === 'function' ? pdfModule : pdfModule.default;
} catch (e) {
  console.warn('pdf-parse module load warning:', e.message);
}

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', 1);

const port = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'mimir-marking-secret-key-2026-eduplanet';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const isProduction = process.env.NODE_ENV === 'production' || !!process.env.RENDER;

// Root & Admin Configuration
const ROOT_EMAIL = (process.env.ROOT_EMAIL || 'ohamada2117@gmail.com').toLowerCase().trim();
const ADMIN_EMAILS = (process.env.ADMIN_EMAIL || '')
  .toLowerCase()
  .split(',')
  .map((e) => e.trim())
  .filter(Boolean);

function isRootUser(email) {
  return email && email.toLowerCase().trim() === ROOT_EMAIL;
}

function isAdminEmail(email) {
  return email && (isRootUser(email) || ADMIN_EMAILS.includes(email.toLowerCase().trim()));
}

function isStrongPassword(password) {
  if (!password || password.length < 8) return false;
  const hasNumber = /[0-9]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasSpecial = /[^A-Za-z0-9]/.test(password);
  return hasNumber && hasUpper && hasLower && hasSpecial;
}

// Database Configuration
const tursoUrl = process.env.TURSO_DATABASE_URL || 'file:mimirmarking.db';
const tursoAuthToken = process.env.TURSO_AUTH_TOKEN || '';

const db = createClient({
  url: tursoUrl,
  authToken: tursoAuthToken
});

async function initDatabase() {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT,
        google_id TEXT,
        status TEXT DEFAULT 'pending',
        role TEXT DEFAULT 'teacher',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        teacher_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        deadline TEXT,
        scheme_text TEXT,
        scheme_files_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (teacher_id) REFERENCES users(id)
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        assignment_id INTEGER NOT NULL,
        student_name TEXT NOT NULL,
        page_count INTEGER DEFAULT 1,
        total_score TEXT,
        category_breakdown TEXT,
        mistakes TEXT,
        weaknesses TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (assignment_id) REFERENCES assignments(id)
      );
    `);

    console.log('Connected to Database successfully.');
    cleanExpiredAssignments();
  } catch (err) {
    console.error('Database initialization error:', err.message);
  }
}
initDatabase();

// Auto-delete records 2 days after assignment deadline
async function cleanExpiredAssignments() {
  try {
    const assignmentsRes = await db.execute('SELECT id, deadline FROM assignments WHERE deadline IS NOT NULL');
    const now = Date.now();
    const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

    for (const row of assignmentsRes.rows) {
      if (row.deadline) {
        const ddlTime = new Date(row.deadline).getTime();
        if (!isNaN(ddlTime) && now > (ddlTime + TWO_DAYS_MS)) {
          await db.execute({ sql: 'DELETE FROM submissions WHERE assignment_id = ?', args: [row.id] });
          await db.execute({ sql: 'DELETE FROM assignments WHERE id = ?', args: [row.id] });
          console.log(`[Auto-Cleanup] Purged expired assignment ID ${row.id} (> 2 days past deadline).`);
        }
      }
    }
  } catch (err) {
    console.error('[Auto-Cleanup Notice]:', err.message);
  }
}

setInterval(cleanExpiredAssignments, 60 * 60 * 1000);

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(cookieParser());

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function authenticateToken(req, res, next) {
  const token = req.cookies.halo_token || (req.headers['authorization'] && req.headers['authorization'].split(' ')[1]);

  if (!token) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Unauthorized. Please login.' });
    }
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
      return res.redirect('/login.html');
    }

    const userObj = {
      id: Number(dbUser.id),
      name: dbUser.name,
      email: dbUser.email,
      status: dbUser.status,
      role: dbUser.role
    };

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
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ error: 'Session expired. Please login again.' });
    }
    return res.redirect('/login.html');
  }
}

function requireApprovedUser(req, res, next) {
  if (['root', 'admin'].includes(req.user.role) || req.user.status === 'approved') {
    return next();
  }
  return res.status(403).json({ 
    error: 'Access Denied: Your account is pending authorization by an administrator.' 
  });
}

function requireAdmin(req, res, next) {
  if (!req.user || !['root', 'admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Administrator authorization required.' });
  }
  next();
}

app.get('/api/auth/config', (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID });
});

// Registration
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Please provide all required fields.' });

    const cleanEmail = email.toLowerCase().trim();

    if (!isStrongPassword(password)) {
      return res.status(400).json({ 
        error: 'Password must be at least 8 characters and include uppercase, lowercase, a number, and a special character.' 
      });
    }

    const checkUser = await db.execute({
      sql: 'SELECT id FROM users WHERE email = ?',
      args: [cleanEmail]
    });

    if (checkUser.rows.length > 0) {
      return res.status(400).json({ error: 'An account with this email already exists.' });
    }

    let initialRole = 'teacher';
    let initialStatus = 'pending';

    if (isRootUser(cleanEmail)) {
      initialRole = 'root';
      initialStatus = 'approved';
    } else if (isAdminEmail(cleanEmail)) {
      initialRole = 'admin';
      initialStatus = 'approved';
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const insert = await db.execute({
      sql: 'INSERT INTO users (name, email, password, status, role) VALUES (?, ?, ?, ?, ?)',
      args: [name.trim(), cleanEmail, hashedPassword, initialStatus, initialRole]
    });

    const newUserId = Number(insert.lastInsertRowid);

    const token = jwt.sign(
      { id: newUserId, name: name.trim(), email: cleanEmail, status: initialStatus, role: initialRole },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.cookie('halo_token', token, { 
      httpOnly: true, 
      secure: isProduction,
      sameSite: 'lax', 
      path: '/', 
      maxAge: 7 * 24 * 60 * 60 * 1000 
    });

    return res.json({ 
      success: true, 
      user: { name: name.trim(), email: cleanEmail, status: initialStatus, role: initialRole }
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Server error during registration.' });
  }
});

// Manual Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Please provide email and password.' });

    const cleanEmail = email.toLowerCase().trim();
    const result = await db.execute({
      sql: 'SELECT * FROM users WHERE email = ?',
      args: [cleanEmail]
    });

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

    res.cookie('halo_token', token, { 
      httpOnly: true, 
      secure: isProduction,
      sameSite: 'lax', 
      path: '/', 
      maxAge: 7 * 24 * 60 * 60 * 1000 
    });

    return res.json({ success: true, user: { name: user.name, email: user.email, status: userStatus, role: userRole } });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Server error during login.' });
  }
});

// Google Auth
app.post('/api/auth/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: 'Missing Google credential token.' });

    let payload;
    try {
      const base64Url = credential.split('.')[1];
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
      const jsonPayload = decodeURIComponent(
        Buffer.from(base64, 'base64')
          .toString('utf-8')
          .split('')
          .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
          .join('')
      );
      payload = JSON.parse(jsonPayload);
    } catch (parseErr) {
      return res.status(400).json({ error: 'Malformed Google credential token.' });
    }

    if (!payload || !payload.email) {
      return res.status(400).json({ error: 'Google token did not contain a valid email address.' });
    }

    const email = payload.email.toLowerCase().trim();
    const name = payload.name || email.split('@')[0];
    const googleId = payload.sub || '';

    const existingResult = await db.execute({
      sql: 'SELECT * FROM users WHERE email = ?',
      args: [email]
    });

    let user = existingResult.rows[0];

    if (!user) {
      let initialRole = 'teacher';
      let initialStatus = 'pending';

      if (isRootUser(email)) {
        initialRole = 'root';
        initialStatus = 'approved';
      } else if (isAdminEmail(email)) {
        initialRole = 'admin';
        initialStatus = 'approved';
      }

      const insert = await db.execute({
        sql: 'INSERT INTO users (name, email, password, google_id, status, role) VALUES (?, ?, ?, ?, ?, ?)',
        args: [name, email, 'GOOGLE_AUTH_ACCOUNT', googleId, initialStatus, initialRole]
      });

      user = { id: Number(insert.lastInsertRowid), name, email, status: initialStatus, role: initialRole };
    } else {
      let updatedRole = user.role;
      let updatedStatus = user.status;

      if (isRootUser(email) && user.role !== 'root') {
        await db.execute({ sql: "UPDATE users SET role = 'root', status = 'approved', google_id = ? WHERE id = ?", args: [googleId, Number(user.id)] });
        updatedRole = 'root';
        updatedStatus = 'approved';
      } else if (isAdminEmail(email) && user.role === 'teacher') {
        await db.execute({ sql: "UPDATE users SET role = 'admin', status = 'approved', google_id = ? WHERE id = ?", args: [googleId, Number(user.id)] });
        updatedRole = 'admin';
        updatedStatus = 'approved';
      } else if (!user.google_id && googleId) {
        await db.execute({ sql: 'UPDATE users SET google_id = ? WHERE id = ?', args: [googleId, Number(user.id)] });
      }

      user = { ...user, id: Number(user.id), role: updatedRole, status: updatedStatus };
    }

    const token = jwt.sign(
      { id: Number(user.id), name: user.name, email: user.email, status: user.status, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.cookie('halo_token', token, { 
      httpOnly: true, 
      secure: isProduction,
      sameSite: 'lax', 
      path: '/', 
      maxAge: 7 * 24 * 60 * 60 * 1000 
    });

    return res.json({ 
      success: true, 
      user: { name: user.name, email: user.email, status: user.status, role: user.role } 
    });
  } catch (error) {
    console.error('Google Auth Route Error:', error);
    return res.status(500).json({ error: error.message || 'Google sign-in processing failed.' });
  }
});

// Admin User Management Routes
app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await db.execute('SELECT id, name, email, status, role, created_at FROM users ORDER BY id DESC');
    res.json({ success: true, users: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users.' });
  }
});

app.post('/api/admin/users/:id/status', authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!['approved', 'pending', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });

  const targetResult = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [Number(id)] });
  const target = targetResult.rows[0];
  if (!target) return res.status(404).json({ error: 'User not found.' });

  if (target.role === 'root') return res.status(403).json({ error: 'The Root User account status cannot be modified.' });

  await db.execute({ sql: 'UPDATE users SET status = ? WHERE id = ?', args: [status, Number(id)] });
  res.json({ success: true, message: `Account updated to ${status}.` });
});

app.post('/api/admin/users/:id/role', authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { role } = req.body;
  if (!['admin', 'teacher'].includes(role)) return res.status(400).json({ error: 'Invalid role specified.' });

  const targetResult = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [Number(id)] });
  const target = targetResult.rows[0];
  if (!target) return res.status(404).json({ error: 'User not found.' });

  if (target.role === 'root') return res.status(403).json({ error: 'The Root User cannot be demoted.' });
  if (req.user.id === Number(id) && role !== 'admin') return res.status(400).json({ error: 'You cannot revoke your own admin rights.' });

  await db.execute({ sql: "UPDATE users SET role = ?, status = 'approved' WHERE id = ?", args: [role, Number(id)] });
  res.json({ success: true, message: `User role changed to ${role}.` });
});

app.post('/api/admin/users/:id/reset-password', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;

    if (!newPassword || newPassword.trim().length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters long.' });
    }

    const targetResult = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [Number(id)] });
    const target = targetResult.rows[0];
    if (!target) return res.status(404).json({ error: 'User not found.' });

    const hashedPassword = await bcrypt.hash(newPassword.trim(), 10);
    await db.execute({ sql: 'UPDATE users SET password = ? WHERE id = ?', args: [hashedPassword, Number(id)] });

    res.json({ success: true, message: `Password for ${target.email} updated.` });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to update password.' });
  }
});

app.delete('/api/admin/users/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const targetResult = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [Number(id)] });
  const target = targetResult.rows[0];
  if (!target) return res.status(404).json({ error: 'User not found.' });

  if (target.role === 'root') return res.status(403).json({ error: 'Root User cannot be deleted.' });
  if (req.user.id === Number(id)) return res.status(400).json({ error: 'You cannot delete your own account.' });

  await db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [Number(id)] });
  res.json({ success: true, message: 'Account deleted successfully.' });
});

app.get('/api/auth/me', authenticateToken, (req, res) => {
  res.json({ success: true, user: req.user });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('halo_token');
  res.json({ success: true, message: 'Logged out successfully.' });
});

function isImage(file) {
  if (!file) return false;
  const mime = file.mimetype || '';
  const name = file.originalname ? file.originalname.toLowerCase() : '';
  return mime.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif|bmp|heic|heif)$/.test(name);
}

function isPdf(file) {
  if (!file) return false;
  const mime = file.mimetype || '';
  const name = file.originalname ? file.originalname.toLowerCase() : '';
  return mime === 'application/pdf' || name.endsWith('.pdf');
}

async function extractText(file) {
  if (!file) return '';
  const mime = file.mimetype || '';
  const name = file.originalname ? file.originalname.toLowerCase() : '';

  if (isPdf(file)) {
    if (typeof pdfParse === 'function') {
      try {
        const data = await pdfParse(file.buffer);
        if (data && data.text && data.text.trim()) return data.text;
      } catch (err) {
        console.warn('PDF extraction notice:', err.message);
      }
    }
    return '';
  }

  if (
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    name.endsWith('.docx')
  ) {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return result.value;
  }

  return file.buffer.toString('utf-8');
}

// AI Model Caller
async function callGemini(inputPayload) {
  const models = ['gemini-3.6-flash', 'gemini-3.7-flash'];
  let lastErr;

  for (const modelName of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const interaction = await ai.interactions.create({
          model: modelName,
          input: inputPayload,
          response_format: [
            {
              type: 'text',
              mime_type: 'application/json',
              schema: {
                type: 'object',
                properties: {
                  student_name: { type: 'string' },
                  total_score: { type: 'string' },
                  category_breakdown: { type: 'string' },
                  mistakes: { type: 'string' },
                  weaknesses: { type: 'string' }
                },
                required: ['student_name', 'total_score', 'category_breakdown', 'mistakes', 'weaknesses']
              }
            }
          ]
        });
        return interaction.output_text;
      } catch (err) {
        const errMsg = err.message || '';
        console.warn(`[${modelName} attempt ${attempt + 1}] ${errMsg}`);
        lastErr = err;
        
        if (errMsg.includes('500') || errMsg.includes('503') || errMsg.includes('high demand')) {
          await delay(800 * (attempt + 1));
          continue;
        }
        break;
      }
    }
  }
  throw lastErr;
}

// 1. Teacher creates an assignment (Normalized ISO Deadline)
app.post(
  '/api/assignments/create',
  authenticateToken,
  requireApprovedUser,
  upload.fields([{ name: 'scheme', maxCount: 20 }]),
  async (req, res) => {
    try {
      const { title, deadline, schemeText } = req.body;
      if (!title || !title.trim()) {
        return res.status(400).json({ error: 'Please provide an assignment title.' });
      }

      const schemeFiles = (req.files && req.files['scheme']) || [];
      const cachedSchemePayload = [];
      let extractedSchemeText = schemeText || '';

      for (const sFile of schemeFiles) {
        if (isPdf(sFile)) {
          const pdfTxt = await extractText(sFile);
          if (pdfTxt && pdfTxt.trim()) {
            extractedSchemeText += `\n[Rubric Document Content]:\n${pdfTxt}\n`;
          } else {
            cachedSchemePayload.push({
              type: 'document',
              mime_type: 'application/pdf',
              data: sFile.buffer.toString('base64')
            });
          }
        } else if (isImage(sFile)) {
          let mimeType = sFile.mimetype || 'image/png';
          if (!mimeType.startsWith('image/')) mimeType = 'image/png';
          cachedSchemePayload.push({
            type: 'image',
            mime_type: mimeType,
            data: sFile.buffer.toString('base64')
          });
        } else {
          const txt = await extractText(sFile);
          if (txt.trim()) {
            extractedSchemeText += `\n[Rubric File: ${sFile.originalname}]\n${txt}\n`;
          }
        }
      }

      const code = crypto.randomBytes(4).toString('hex');
      let deadlineIso = null;
      if (deadline && deadline.trim()) {
        const parsedDdl = new Date(deadline.trim());
        if (!isNaN(parsedDdl.getTime())) {
          deadlineIso = parsedDdl.toISOString();
        }
      }

      await db.execute({
        sql: `INSERT INTO assignments (code, teacher_id, title, deadline, scheme_text, scheme_files_json) 
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [
          code,
          req.user.id,
          title.trim(),
          deadlineIso,
          extractedSchemeText,
          JSON.stringify(cachedSchemePayload)
        ]
      });

      return res.json({
        success: true,
        code,
        link: `${req.protocol}://${req.get('host')}/submit.html?code=${code}`
      });
    } catch (err) {
      console.error('Assignment Creation Error:', err);
      return res.status(500).json({ error: err.message || 'Failed to create assignment link.' });
    }
  }
);

// 2. Fetch Assignments
app.get('/api/assignments', authenticateToken, requireApprovedUser, async (req, res) => {
  try {
    const result = await db.execute({
      sql: `SELECT id, code, title, deadline, created_at,
            (SELECT COUNT(*) FROM submissions WHERE assignment_id = assignments.id) as submission_count
            FROM assignments WHERE teacher_id = ? ORDER BY id DESC`,
      args: [req.user.id]
    });
    res.json({ success: true, assignments: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch assignments.' });
  }
});

// 3. Fetch live submissions
app.get('/api/assignments/:code/submissions', authenticateToken, requireApprovedUser, async (req, res) => {
  try {
    const { code } = req.params;
    const assignResult = await db.execute({
      sql: 'SELECT id, title, deadline FROM assignments WHERE code = ? AND teacher_id = ?',
      args: [code, req.user.id]
    });

    const assignment = assignResult.rows[0];
    if (!assignment) return res.status(404).json({ error: 'Assignment not found.' });

    const subsResult = await db.execute({
      sql: `SELECT id, student_name as name, student_name, page_count as pageCount, total_score, 
            category_breakdown, mistakes, weaknesses, created_at 
            FROM submissions WHERE assignment_id = ? ORDER BY id ASC`,
      args: [assignment.id]
    });

    res.json({
      success: true,
      assignment,
      submissions: subsResult.rows
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch submissions.' });
  }
});

// 4. Public route to check assignment details (Accurate UTC Deadline check)
app.get('/api/public/assignment/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const result = await db.execute({
      sql: `SELECT a.code, a.title, a.deadline, u.name as teacher_name 
            FROM assignments a JOIN users u ON a.teacher_id = u.id 
            WHERE a.code = ?`,
      args: [code]
    });

    const assignment = result.rows[0];
    if (!assignment) return res.status(404).json({ error: 'Invalid or expired assignment link.' });

    let isPastDeadline = false;
    if (assignment.deadline) {
      const ddlTime = new Date(assignment.deadline).getTime();
      if (!isNaN(ddlTime)) {
        isPastDeadline = Date.now() > ddlTime;
      }
    }

    res.json({
      success: true,
      assignment: {
        code: assignment.code,
        title: assignment.title,
        deadline: assignment.deadline,
        teacherName: assignment.teacher_name,
        isPastDeadline
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Error loading assignment.' });
  }
});

// 5. Public student work submission (Strict Server-Side Deadline Enforcement)
app.post(
  '/api/public/submit/:code',
  upload.fields([{ name: 'pages', maxCount: 20 }]),
  async (req, res) => {
    try {
      const { code } = req.params;
      const studentNameInput = (req.body.studentName || '').trim();

      const assignResult = await db.execute({
        sql: 'SELECT * FROM assignments WHERE code = ?',
        args: [code]
      });

      const assignment = assignResult.rows[0];
      if (!assignment) return res.status(404).json({ error: 'Assignment not found.' });

      // Immediate Server-Side Deadline Gate
      if (assignment.deadline) {
        const ddlTime = new Date(assignment.deadline).getTime();
        if (!isNaN(ddlTime) && Date.now() > ddlTime) {
          return res.status(403).json({ error: 'Submission deadline has passed. Work is no longer accepted.' });
        }
      }

      const files = (req.files && req.files['pages']) || [];
      if (!files.length) {
        return res.status(400).json({ error: 'Please upload at least one photo or document of your work.' });
      }

      const cachedSchemePayload = JSON.parse(assignment.scheme_files_json || '[]');
      const inputPayload = [...cachedSchemePayload];

      let promptText = `You are a meticulous exam evaluator reviewing a student's handwritten writing assessment / essay.

INSTRUCTIONS:
- The verified student name submitted is: "${studentNameInput || 'Student'}". Always use this name in 'student_name'.
- Grade against the provided marking scheme criteria.
- In 'category_breakdown', 'mistakes', and 'weaknesses', list EVERY bullet on a new line starting with a hyphen '-'.
- Format mistakes line-by-line with quoted snippets and clear corrections (e.g. Paragraph 1: 'word' -> 'correction').

Respond ONLY with valid JSON:
{
  "student_name": "${studentNameInput || 'Student'}",
  "total_score": "12/25",
  "category_breakdown": "- Structure: 3/6\\n- Content: 3/6\\n- Linking Words: 2/5\\n- Vocabulary: 2/4\\n- SPaG: 2/4",
  "mistakes": "- Spelling: 'freinds' should be spelled 'friends'.\\n- Line 1: 'was going' should be 'were going'",
  "weaknesses": "- Practice paragraph structure\\n- Review past tense rules"
}`;

      if (assignment.scheme_text && assignment.scheme_text.trim()) {
        promptText += `\n\nMARKING SCHEME CRITERIA:\n${assignment.scheme_text}`;
      }

      for (let p = 0; p < files.length; p++) {
        const file = files[p];
        if (isImage(file)) {
          let mimeType = file.mimetype || 'image/png';
          if (!mimeType.startsWith('image/')) mimeType = 'image/png';
          inputPayload.push({
            type: 'image',
            mime_type: mimeType,
            data: file.buffer.toString('base64')
          });
        } else if (isPdf(file)) {
          inputPayload.push({
            type: 'document',
            mime_type: 'application/pdf',
            data: file.buffer.toString('base64')
          });
        } else {
          const essayText = await extractText(file);
          promptText += `\n\nSTUDENT ESSAY (Page ${p + 1}):\n${essayText}`;
        }
      }

      promptText += `\n\nSTUDENT WORK: ${files.length} attached document/image page(s).`;
      inputPayload.push({ type: 'text', text: promptText });

      let parsedFeedback = {
        student_name: studentNameInput || 'Student',
        total_score: '—',
        category_breakdown: '- Evaluated',
        mistakes: '- No major mistakes noted.',
        weaknesses: '- Well done'
      };

      try {
        const rawOutput = await callGemini(inputPayload);
        parsedFeedback = JSON.parse(rawOutput);
      } catch (aiErr) {
        console.warn('AI evaluation warning:', aiErr.message);
      }

      const finalName = studentNameInput || parsedFeedback.student_name || 'Student';

      await db.execute({
        sql: `INSERT INTO submissions 
              (assignment_id, student_name, page_count, total_score, category_breakdown, mistakes, weaknesses)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          assignment.id,
          finalName,
          files.length,
          parsedFeedback.total_score || '—',
          parsedFeedback.category_breakdown || '—',
          parsedFeedback.mistakes || '—',
          parsedFeedback.weaknesses || '—'
        ]
      });

      return res.json({
        success: true,
        message: 'Your work has been received and evaluated successfully!',
        studentName: finalName
      });
    } catch (err) {
      console.error('Student Upload Error:', err);
      return res.status(500).json({ error: err.message || 'Error processing submission.' });
    }
  }
);

// 6. Manual Direct Batch Marking
app.post(
  '/api/mark-batch',
  authenticateToken,
  requireApprovedUser,
  upload.fields([
    { name: 'scheme', maxCount: 20 },
    { name: 'essays', maxCount: 60 }
  ]),
  async (req, res) => {
    try {
      const schemeFiles = (req.files && req.files['scheme']) || [];
      let extraNotes = req.body.schemeText || '';

      if (schemeFiles.length === 0 && !extraNotes.trim()) {
        return res.status(400).json({ error: 'Please provide at least one marking scheme file or text criteria.' });
      }

      const allUploadedFiles = (req.files && req.files['essays']) || [];
      if (allUploadedFiles.length === 0) {
        return res.status(400).json({ error: 'No essay pages/files uploaded.' });
      }

      let submissionsMeta = [];
      try {
        submissionsMeta = JSON.parse(req.body.submissionsMetadata || '[]');
      } catch (err) {
        submissionsMeta = [];
      }

      if (!submissionsMeta.length) {
        submissionsMeta = allUploadedFiles.map((f) => ({
          name: f.originalname.replace(/\.[^/.]+$/, '').replace(/[_-]+/g, ' '),
          fileCount: 1
        }));
      }

      let allSchemeText = '';
      const cachedSchemePayload = [];

      for (const sFile of schemeFiles) {
        if (isPdf(sFile)) {
          const pdfTxt = await extractText(sFile);
          if (pdfTxt && pdfTxt.trim()) {
            allSchemeText += `\n[Rubric Document Content]:\n${pdfTxt}\n`;
          } else {
            cachedSchemePayload.push({
              type: 'document',
              mime_type: 'application/pdf',
              data: sFile.buffer.toString('base64')
            });
          }
        } else if (isImage(sFile)) {
          let mimeType = sFile.mimetype || 'image/png';
          if (!mimeType.startsWith('image/')) mimeType = 'image/png';
          cachedSchemePayload.push({
            type: 'image',
            mime_type: mimeType,
            data: sFile.buffer.toString('base64')
          });
        } else {
          const txt = await extractText(sFile);
          if (txt.trim()) {
            allSchemeText += `\n[Rubric File: ${sFile.originalname}]\n${txt}\n`;
          }
        }
      }

      const studentJobs = [];
      let fileCursor = 0;
      for (let sIdx = 0; sIdx < submissionsMeta.length; sIdx++) {
        const sub = submissionsMeta[sIdx];
        const pageCount = sub.fileCount || 1;
        const studentFiles = allUploadedFiles.slice(fileCursor, fileCursor + pageCount);
        fileCursor += pageCount;

        if (studentFiles.length > 0) {
          studentJobs.push({
            index: sIdx,
            assignedName: sub.name || `Student ${sIdx + 1}`,
            files: studentFiles
          });
        }
      }

      async function evaluateStudent(job) {
        const inputPayload = [...cachedSchemePayload];

        let promptText = `You are a meticulous exam evaluator reviewing a student's handwritten writing assessment / essay.

INSTRUCTIONS:
- Identify and extract the student's handwritten name from the top header of the paper. If unreadable or missing, fallback to: "${job.assignedName}".
- Grade strictly against the marking scheme criteria.
- In 'category_breakdown', 'mistakes', and 'weaknesses', list EVERY bullet on a new line starting with a hyphen '-'.
- Format mistakes line-by-line with exact quoted snippets (e.g. Paragraph 1: 'word' -> 'correction').

Respond ONLY with valid JSON:
{
  "student_name": "Extracted Student Name",
  "total_score": "12/25",
  "category_breakdown": "- Structure: 3/6\\n- Content: 3/6\\n- Linking Words: 2/5\\n- Vocabulary: 2/4\\n- SPaG: 2/4",
  "mistakes": "- Spelling: 'freinds' should be spelled 'friends'.\\n- Line 1: 'was going' should be 'were going'",
  "weaknesses": "- Practice paragraph structure\\n- Review past tense rules"
}`;

        if (allSchemeText.trim()) {
          promptText += `\n\nMARKING SCHEME CRITERIA:\n${allSchemeText}`;
        }
        if (extraNotes.trim()) {
          promptText += `\n\nTEACHER NOTES & GUIDELINES:\n${extraNotes}`;
        }

        for (let p = 0; p < job.files.length; p++) {
          const file = job.files[p];
          if (isImage(file)) {
            let mimeType = file.mimetype || 'image/png';
            if (!mimeType.startsWith('image/')) mimeType = 'image/png';
            inputPayload.push({
              type: 'image',
              mime_type: mimeType,
              data: file.buffer.toString('base64')
            });
          } else if (isPdf(file)) {
            inputPayload.push({
              type: 'document',
              mime_type: 'application/pdf',
              data: file.buffer.toString('base64')
            });
          } else {
            const essayText = await extractText(file);
            promptText += `\n\nSTUDENT ESSAY (Page ${p + 1}):\n${essayText}`;
          }
        }

        promptText += `\n\nSTUDENT WORK: ${job.files.length} attached document/image page(s).`;
        inputPayload.push({ type: 'text', text: promptText });

        try {
          const rawOutput = await callGemini(inputPayload);
          const parsedFeedback = JSON.parse(rawOutput);

          const finalStudentName =
            parsedFeedback.student_name && parsedFeedback.student_name.trim()
              ? parsedFeedback.student_name.trim()
              : job.assignedName;

          return {
            index: job.index,
            pageCount: job.files.length,
            name: finalStudentName,
            score: parsedFeedback.total_score,
            ...parsedFeedback
          };
        } catch (err) {
          console.error(`Evaluation failure for ${job.assignedName}:`, err.message);
          return {
            index: job.index,
            pageCount: job.files.length,
            name: job.assignedName,
            total_score: '—',
            category_breakdown: '- Evaluation error',
            mistakes: '- Check image clarity',
            weaknesses: '- Please review manually'
          };
        }
      }

      const CONCURRENCY = 2;
      const results = [];

      for (let i = 0; i < studentJobs.length; i += CONCURRENCY) {
        const chunk = studentJobs.slice(i, i + CONCURRENCY);
        const chunkResults = await Promise.all(chunk.map((job) => evaluateStudent(job)));
        results.push(...chunkResults);
      }

      results.sort((a, b) => a.index - b.index);
      return res.json({ success: true, count: results.length, data: results });
    } catch (error) {
      console.error('Server Processing Error:', error);
      return res.status(500).json({ error: error.message || 'Internal server error processing documents.' });
    }
  }
);

// Static assets
const publicDir = path.resolve(__dirname, 'public');
app.use(express.static(publicDir));

app.get('/login', (req, res) => res.sendFile(path.join(publicDir, 'login.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(publicDir, 'login.html')));
app.get('/submit', (req, res) => res.sendFile(path.join(publicDir, 'submit.html')));
app.get('/submit.html', (req, res) => res.sendFile(path.join(publicDir, 'submit.html')));
app.get('/', authenticateToken, (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get('/index.html', authenticateToken, (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

app.use((req, res) => {
  if (req.accepts('html')) res.redirect('/login.html');
  else res.status(404).json({ error: 'Not found' });
});

app.listen(port, () => {
  console.log(`Mimir Marking Server running on port ${port}`);
});