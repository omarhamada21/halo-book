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
        teacher_name TEXT,
        device_id TEXT,
        essay_text TEXT,
        page_count INTEGER DEFAULT 1,
        total_score TEXT,
        category_breakdown TEXT,
        mistakes TEXT,
        weaknesses TEXT,
        similarity_score INTEGER DEFAULT 0,
        similarity_details TEXT,
        ai_score INTEGER DEFAULT 0,
        ai_details TEXT,
        web_score INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (assignment_id) REFERENCES assignments(id)
      );
    `);

    const autoMigrations = [
      'ALTER TABLE submissions ADD COLUMN teacher_name TEXT;',
      'ALTER TABLE submissions ADD COLUMN device_id TEXT;',
      'ALTER TABLE submissions ADD COLUMN essay_text TEXT;',
      'ALTER TABLE submissions ADD COLUMN similarity_score INTEGER DEFAULT 0;',
      'ALTER TABLE submissions ADD COLUMN similarity_details TEXT;',
      'ALTER TABLE submissions ADD COLUMN ai_score INTEGER DEFAULT 0;',
      'ALTER TABLE submissions ADD COLUMN ai_details TEXT;',
      'ALTER TABLE submissions ADD COLUMN web_score INTEGER DEFAULT 0;'
    ];

    for (const sql of autoMigrations) {
      try {
        await db.execute(sql);
      } catch (e) {}
    }

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
          console.log(`[Auto-Cleanup] Purged expired assignment ID ${row.id}`);
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
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized. Please login.' });
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
    if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Session expired.' });
    return res.redirect('/login.html');
  }
}

function requireApprovedUser(req, res, next) {
  if (['root', 'admin'].includes(req.user.role) || req.user.status === 'approved') return next();
  return res.status(403).json({ error: 'Access Denied: Your account is pending authorization by an administrator.' });
}

function requireAdmin(req, res, next) {
  if (!req.user || !['root', 'admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Administrator authorization required.' });
  }
  next();
}

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

// Intra-Class Tri-gram Similarity Check
function calculateTextSimilarity(text1, text2) {
  if (!text1 || !text2) return { score: 0, sharedPhrases: [] };
  
  const clean1 = text1.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 2);
  const clean2 = text2.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 2);

  if (clean1.length < 5 || clean2.length < 5) return { score: 0, sharedPhrases: [] };

  const getTrigrams = (words) => {
    const set = new Set();
    for (let i = 0; i < words.length - 2; i++) {
      set.add(`${words[i]} ${words[i+1]} ${words[i+2]}`);
    }
    return set;
  };

  const set1 = getTrigrams(clean1);
  const set2 = getTrigrams(clean2);

  let matches = 0;
  const shared = [];
  for (const tri of set1) {
    if (set2.has(tri)) {
      matches++;
      if (shared.length < 3) shared.push(tri);
    }
  }

  const denominator = Math.min(set1.size, set2.size);
  const score = denominator > 0 ? Math.min(100, Math.round((matches / denominator) * 100)) : 0;

  return { score, sharedPhrases: shared };
}

// High-Reliability Gemini Evaluator
async function callGemini(inputPayload) {
  const models = ['gemini-2.5-flash', 'gemini-1.5-flash'];
  let lastErr;

  for (const modelName of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: inputPayload,
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'OBJECT',
              properties: {
                student_name: { type: 'STRING' },
                extracted_essay: { type: 'STRING' },
                total_score: { type: 'STRING' },
                category_breakdown: { type: 'STRING' },
                mistakes: { type: 'STRING' },
                weaknesses: { type: 'STRING' },
                ai_probability_score: { type: 'INTEGER' },
                ai_detection_notes: { type: 'STRING' },
                web_similarity_score: { type: 'INTEGER' }
              },
              required: [
                'student_name',
                'extracted_essay',
                'total_score',
                'category_breakdown',
                'mistakes',
                'weaknesses',
                'ai_probability_score',
                'ai_detection_notes',
                'web_similarity_score'
              ]
            }
          }
        });

        if (response && response.text) {
          return response.text;
        }
      } catch (err) {
        lastErr = err;
        console.warn(`[${modelName} Attempt ${attempt + 1}] Error:`, err.message);
        await delay(600 * (attempt + 1));
      }
    }
  }
  throw lastErr;
}

// ----------------- AUTH ROUTES -----------------
app.get('/api/auth/config', (req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID }));

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Please provide all required fields.' });

    const cleanEmail = email.toLowerCase().trim();
    if (!isStrongPassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters and include uppercase, lowercase, a number, and a special character.' });
    }

    const checkUser = await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [cleanEmail] });
    if (checkUser.rows.length > 0) return res.status(400).json({ error: 'An account with this email already exists.' });

    let initialRole = isRootUser(cleanEmail) ? 'root' : isAdminEmail(cleanEmail) ? 'admin' : 'teacher';
    let initialStatus = ['root', 'admin'].includes(initialRole) ? 'approved' : 'pending';

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

app.post('/api/auth/login', async (req, res) => {
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

app.post('/api/auth/google', async (req, res) => {
  try {
    const { credential } = req.body;
    const base64Url = credential.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(Buffer.from(base64, 'base64').toString('utf-8').split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
    const payload = JSON.parse(jsonPayload);

    const email = payload.email.toLowerCase().trim();
    const name = payload.name || email.split('@')[0];

    const existingResult = await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [email] });
    let user = existingResult.rows[0];

    if (!user) {
      let initialRole = isRootUser(email) ? 'root' : isAdminEmail(email) ? 'admin' : 'teacher';
      let initialStatus = ['root', 'admin'].includes(initialRole) ? 'approved' : 'pending';
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
    return res.status(500).json({ error: 'Google sign-in failed.' });
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
  const target = (await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [Number(id)] })).rows[0];
  if (!target || target.role === 'root') return res.status(403).json({ error: 'Cannot modify Root user.' });

  await db.execute({ sql: 'UPDATE users SET status = ? WHERE id = ?', args: [status, Number(id)] });
  res.json({ success: true, message: `Account updated to ${status}.` });
});

app.post('/api/admin/users/:id/role', authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { role } = req.body;
  const target = (await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [Number(id)] })).rows[0];
  if (!target || target.role === 'root') return res.status(403).json({ error: 'Cannot modify Root user.' });

  await db.execute({ sql: "UPDATE users SET role = ?, status = 'approved' WHERE id = ?", args: [role, Number(id)] });
  res.json({ success: true, message: `Role updated to ${role}.` });
});

app.post('/api/admin/users/:id/reset-password', authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { newPassword } = req.body;
  const hashedPassword = await bcrypt.hash(newPassword.trim(), 10);
  await db.execute({ sql: 'UPDATE users SET password = ? WHERE id = ?', args: [hashedPassword, Number(id)] });
  res.json({ success: true });
});

app.delete('/api/admin/users/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const target = (await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [Number(id)] })).rows[0];
  if (!target || target.role === 'root' || req.user.id === Number(id)) return res.status(403).json({ error: 'Action not allowed.' });
  await db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [Number(id)] });
  res.json({ success: true });
});

app.get('/api/auth/me', authenticateToken, (req, res) => res.json({ success: true, user: req.user }));
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('halo_token');
  res.json({ success: true });
});

// ----------------- ASSIGNMENT & EVALUATIONS -----------------
app.post(
  '/api/assignments/create',
  authenticateToken,
  requireApprovedUser,
  upload.fields([{ name: 'scheme', maxCount: 20 }]),
  async (req, res) => {
    try {
      const { title, deadline, schemeText } = req.body;
      if (!title || !title.trim()) return res.status(400).json({ error: 'Please provide an assignment title.' });

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
              inlineData: {
                mimeType: 'application/pdf',
                data: sFile.buffer.toString('base64')
              }
            });
          }
        } else if (isImage(sFile)) {
          let mimeType = sFile.mimetype || 'image/png';
          if (!mimeType.startsWith('image/')) mimeType = 'image/png';
          cachedSchemePayload.push({
            inlineData: {
              mimeType: mimeType,
              data: sFile.buffer.toString('base64')
            }
          });
        } else {
          const txt = await extractText(sFile);
          if (txt.trim()) {
            extractedSchemeText += `\n[Rubric File: ${sFile.originalname}]\n${txt}\n`;
          }
        }
      }

      const code = crypto.randomBytes(4).toString('hex');
      let deadlineVal = deadline && deadline.trim() ? deadline.trim() : null;

      await db.execute({
        sql: `INSERT INTO assignments (code, teacher_id, title, deadline, scheme_text, scheme_files_json) 
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [
          code,
          req.user.id,
          title.trim(),
          deadlineVal,
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

// Teacher Submissions Fetch (With Integrity Data For Dashboard ONLY)
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
      sql: `SELECT id, student_name as name, student_name, teacher_name, page_count as pageCount, total_score, 
            category_breakdown, mistakes, weaknesses, similarity_score, similarity_details, ai_score, ai_details, web_score, created_at 
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

app.post('/api/assignments/:code/update-deadline', authenticateToken, requireApprovedUser, async (req, res) => {
  try {
    const { code } = req.params;
    const { deadline } = req.body;

    const assignResult = await db.execute({
      sql: 'SELECT id FROM assignments WHERE code = ? AND teacher_id = ?',
      args: [code, req.user.id]
    });

    const assignment = assignResult.rows[0];
    if (!assignment) return res.status(404).json({ error: 'Assignment not found or unauthorized.' });

    const deadlineVal = deadline && deadline.trim() ? deadline.trim() : null;

    await db.execute({
      sql: 'UPDATE assignments SET deadline = ? WHERE id = ?',
      args: [deadlineVal, assignment.id]
    });

    res.json({
      success: true,
      message: 'Deadline updated successfully.',
      deadline: deadlineVal
    });
  } catch (err) {
    console.error('Update Deadline Error:', err);
    res.status(500).json({ error: 'Failed to update deadline.' });
  }
});

app.delete('/api/assignments/:code', authenticateToken, requireApprovedUser, async (req, res) => {
  try {
    const { code } = req.params;
    const isElevated = ['root', 'admin'].includes(req.user.role);

    const assignResult = await db.execute({
      sql: 'SELECT id, title FROM assignments WHERE code = ?' + (isElevated ? '' : ' AND teacher_id = ?'),
      args: isElevated ? [code] : [code, req.user.id]
    });

    const assignment = assignResult.rows[0];
    if (!assignment) return res.status(404).json({ error: 'Assignment not found or unauthorized.' });

    await db.execute({ sql: 'DELETE FROM submissions WHERE assignment_id = ?', args: [assignment.id] });
    await db.execute({ sql: 'DELETE FROM assignments WHERE id = ?', args: [assignment.id] });

    res.json({
      success: true,
      message: `Assignment "${assignment.title}" and all associated submissions were permanently deleted.`
    });
  } catch (err) {
    console.error('Delete Assignment Error:', err);
    res.status(500).json({ error: 'Failed to delete assignment.' });
  }
});

app.post('/api/submissions/:id/update', authenticateToken, requireApprovedUser, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, total_score, category_breakdown, mistakes, weaknesses } = req.body;

    await db.execute({
      sql: `UPDATE submissions 
            SET student_name = ?, total_score = ?, category_breakdown = ?, mistakes = ?, weaknesses = ? 
            WHERE id = ?`,
      args: [name, total_score, category_breakdown, mistakes, weaknesses, Number(id)]
    });

    res.json({ success: true, message: 'Submission updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update submission.' });
  }
});

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

// Student Public Upload
app.post(
  '/api/public/submit/:code',
  upload.fields([{ name: 'pages', maxCount: 20 }]),
  async (req, res) => {
    try {
      const { code } = req.params;
      const studentNameInput = (req.body.studentName || '').trim();
      const deviceIdInput = (req.body.deviceId || '').trim();

      if (!studentNameInput) {
        return res.status(400).json({ error: 'Please provide your full name before submitting.' });
      }

      const assignResult = await db.execute({
        sql: `SELECT a.*, u.name as teacher_name 
              FROM assignments a 
              JOIN users u ON a.teacher_id = u.id 
              WHERE a.code = ?`,
        args: [code]
      });

      const assignment = assignResult.rows[0];
      if (!assignment) return res.status(404).json({ error: 'Assignment not found.' });

      if (assignment.deadline) {
        const ddlTime = new Date(assignment.deadline).getTime();
        if (!isNaN(ddlTime) && Date.now() > ddlTime) {
          return res.status(403).json({ error: 'Submission deadline has passed. Work is no longer accepted.' });
        }
      }

      if (deviceIdInput) {
        const deviceCheck = await db.execute({
          sql: 'SELECT id, student_name FROM submissions WHERE assignment_id = ? AND device_id = ?',
          args: [assignment.id, deviceIdInput]
        });

        if (deviceCheck.rows.length > 0) {
          return res.status(409).json({ 
            error: 'This device has already submitted work for this assignment. Only one submission is permitted per device.' 
          });
        }
      }

      const files = (req.files && req.files['pages']) || [];
      if (!files.length) {
        return res.status(400).json({ error: 'Please upload at least one photo or document of your work.' });
      }

      const cachedSchemePayload = JSON.parse(assignment.scheme_files_json || '[]');
      const inputPayload = [...cachedSchemePayload];

      let promptText = `You are a meticulous exam evaluator reviewing a student's handwritten writing assessment / essay.
Grade against the provided marking scheme criteria.
Perform an academic integrity inspection:
1. Transcribe the entire student essay accurately into 'extracted_essay'.
2. In 'ai_probability_score', rate from 0 to 100 the likelihood that the essay was generated by ChatGPT/Claude/Gemini based on robotic cadence, burstiness, and uncharacteristic vocabulary.
3. In 'ai_detection_notes', summarize specific observations about phrasing or indicators (or 'Natural student writing').
4. In 'web_similarity_score', provide estimated score (0 to 100) if content appears to match publicly known web essays or Wikipedia.

In 'category_breakdown', 'mistakes', and 'weaknesses', list EVERY bullet on a new line starting with a hyphen '-'.
Format mistakes line-by-line with quoted snippets and clear corrections (e.g. Paragraph 1: 'word' -> 'correction').
Respond strictly in JSON matching the schema.`;

      if (assignment.scheme_text && assignment.scheme_text.trim()) {
        promptText += `\n\nMARKING SCHEME CRITERIA:\n${assignment.scheme_text}`;
      }

      for (let p = 0; p < files.length; p++) {
        const file = files[p];
        if (isImage(file)) {
          let mimeType = file.mimetype || 'image/png';
          if (!mimeType.startsWith('image/')) mimeType = 'image/png';
          inputPayload.push({
            inlineData: {
              mimeType: mimeType,
              data: file.buffer.toString('base64')
            }
          });
        } else if (isPdf(file)) {
          inputPayload.push({
            inlineData: {
              mimeType: 'application/pdf',
              data: file.buffer.toString('base64')
            }
          });
        } else {
          const essayText = await extractText(file);
          promptText += `\n\nSTUDENT ESSAY (Page ${p + 1}):\n${essayText}`;
        }
      }

      promptText += `\n\nSTUDENT WORK: ${files.length} attached document/image page(s).`;
      inputPayload.push(promptText);

      let parsedFeedback = null;
      try {
        const rawOutput = await callGemini(inputPayload);
        parsedFeedback = JSON.parse(rawOutput);
      } catch (aiErr) {
        console.error('Gemini evaluation critical error:', aiErr);
      }

      if (!parsedFeedback) {
        parsedFeedback = {
          student_name: studentNameInput,
          extracted_essay: '',
          total_score: '—',
          category_breakdown: '- Evaluation Pending / Processing Error',
          mistakes: '- Check image clarity and handwriting legibility',
          weaknesses: '- Please review paper manually',
          ai_probability_score: 0,
          ai_detection_notes: 'Could not process integrity check',
          web_similarity_score: 0
        };
      }

      let highestSimilarity = 0;
      let similarityDetails = 'No peer matches found.';

      const existingSubs = await db.execute({
        sql: 'SELECT student_name, essay_text FROM submissions WHERE assignment_id = ? AND essay_text IS NOT NULL',
        args: [assignment.id]
      });

      for (const row of existingSubs.rows) {
        if (row.essay_text && parsedFeedback.extracted_essay) {
          const comp = calculateTextSimilarity(parsedFeedback.extracted_essay, row.essay_text);
          if (comp.score > highestSimilarity) {
            highestSimilarity = comp.score;
            similarityDetails = `${comp.score}% match with ${row.student_name}: "${comp.sharedPhrases.join('", "')}"`;
          }
        }
      }

      const finalName = studentNameInput || parsedFeedback.student_name || 'Student';
      const teacherName = assignment.teacher_name || 'Teacher';

      await db.execute({
        sql: `INSERT INTO submissions 
              (assignment_id, student_name, teacher_name, device_id, essay_text, page_count, total_score, category_breakdown, mistakes, weaknesses, similarity_score, similarity_details, ai_score, ai_details, web_score)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          assignment.id,
          finalName,
          teacherName,
          deviceIdInput || null,
          parsedFeedback.extracted_essay || '',
          files.length,
          parsedFeedback.total_score || '—',
          parsedFeedback.category_breakdown || '—',
          parsedFeedback.mistakes || '—',
          parsedFeedback.weaknesses || '—',
          highestSimilarity,
          similarityDetails,
          parsedFeedback.ai_probability_score || 0,
          parsedFeedback.ai_detection_notes || 'Clean',
          parsedFeedback.web_similarity_score || 0
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

// Manual Direct Batch
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
              inlineData: {
                mimeType: 'application/pdf',
                data: sFile.buffer.toString('base64')
              }
            });
          }
        } else if (isImage(sFile)) {
          let mimeType = sFile.mimetype || 'image/png';
          if (!mimeType.startsWith('image/')) mimeType = 'image/png';
          cachedSchemePayload.push({
            inlineData: {
              mimeType: mimeType,
              data: sFile.buffer.toString('base64')
            }
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
Identify and extract the student's handwritten name from the top header of the paper. If unreadable or missing, fallback to: "${job.assignedName}".
Grade strictly against the marking scheme criteria.
Transcribe the essay into 'extracted_essay'.
Rate 'ai_probability_score' (0-100) and 'web_similarity_score' (0-100).

In 'category_breakdown', 'mistakes', and 'weaknesses', list EVERY bullet on a new line starting with a hyphen '-'.
Format mistakes line-by-line with exact quoted snippets (e.g. Paragraph 1: 'word' -> 'correction').
Respond strictly in JSON matching the schema.`;

        if (allSchemeText.trim()) promptText += `\n\nMARKING SCHEME CRITERIA:\n${allSchemeText}`;
        if (extraNotes.trim()) promptText += `\n\nTEACHER NOTES & GUIDELINES:\n${extraNotes}`;

        for (let p = 0; p < job.files.length; p++) {
          const file = job.files[p];
          if (isImage(file)) {
            let mimeType = file.mimetype || 'image/png';
            if (!mimeType.startsWith('image/')) mimeType = 'image/png';
            inputPayload.push({
              inlineData: {
                mimeType: mimeType,
                data: file.buffer.toString('base64')
              }
            });
          } else if (isPdf(file)) {
            inputPayload.push({
              inlineData: {
                mimeType: 'application/pdf',
                data: file.buffer.toString('base64')
              }
            });
          } else {
            const essayText = await extractText(file);
            promptText += `\n\nSTUDENT ESSAY (Page ${p + 1}):\n${essayText}`;
          }
        }

        promptText += `\n\nSTUDENT WORK: ${job.files.length} attached document/image page(s).`;
        inputPayload.push(promptText);

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
            total_score: parsedFeedback.total_score,
            category_breakdown: parsedFeedback.category_breakdown,
            mistakes: parsedFeedback.mistakes,
            weaknesses: parsedFeedback.weaknesses,
            ai_score: parsedFeedback.ai_probability_score || 0,
            ai_details: parsedFeedback.ai_detection_notes || '',
            web_score: parsedFeedback.web_similarity_score || 0,
            similarity_score: 0,
            similarity_details: 'Batch evaluation mode'
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
            weaknesses: '- Please review manually',
            ai_score: 0,
            ai_details: '',
            web_score: 0,
            similarity_score: 0,
            similarity_details: ''
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