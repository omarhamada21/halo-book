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
import { OAuth2Client } from 'google-auth-library';
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

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
const isProduction = process.env.NODE_ENV === 'production' || !!process.env.RENDER;

// Refuse startup if JWT_SECRET is unset in production; generate ephemeral secret in dev
const JWT_SECRET = (() => {
  if (process.env.JWT_SECRET) {
    return process.env.JWT_SECRET;
  }
  if (isProduction) {
    throw new Error('FATAL CONFIGURATION ERROR: JWT_SECRET environment variable is missing in production. App startup aborted.');
  }
  console.warn('[SECURITY NOTICE] JWT_SECRET not set. Using an ephemeral development secret generated from crypto.randomBytes.');
  return crypto.randomBytes(32).toString('hex');
})();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const googleOAuthClient = new OAuth2Client(GOOGLE_CLIENT_ID);

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
  return /[0-9]/.test(password) &&
         /[A-Z]/.test(password) &&
         /[a-z]/.test(password) &&
         /[^A-Za-z0-9]/.test(password);
}

// In-Memory Rate Limiting Guard with Proxy IP Resolution
const rateLimitMap = new Map();
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function rateLimit({ windowMs = 60 * 1000, max = 30 } = {}) {
  return (req, res, next) => {
    const ip = getClientIp(req);
    const now = Date.now();
    const entry = rateLimitMap.get(ip) || { count: 0, resetTime: now + windowMs };

    if (now > entry.resetTime) {
      entry.count = 1;
      entry.resetTime = now + windowMs;
    } else {
      entry.count += 1;
    }

    rateLimitMap.set(ip, entry);

    if (entry.count > max) {
      return res.status(429).json({ error: 'Too many requests. Please slow down and try again shortly.' });
    }
    next();
  };
}

// Periodic cleanup of expired rate limiter entries
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap.entries()) {
    if (now > entry.resetTime) rateLimitMap.delete(ip);
  }
}, 5 * 60 * 1000);

// Database Initialization
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
        bundle_code TEXT,
        group_title TEXT,
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
        ip_address TEXT,
        possible_duplicate INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (assignment_id) REFERENCES assignments(id)
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS submission_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_name TEXT NOT NULL,
        assignment_code TEXT,
        assignment_title TEXT,
        teacher_name TEXT,
        submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS mcq_tests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        teacher_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        audio_path TEXT,
        deadline TEXT,
        status TEXT DEFAULT 'draft',
        code TEXT UNIQUE NOT NULL,
        max_plays INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (teacher_id) REFERENCES users(id)
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS mcq_questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        test_id INTEGER NOT NULL,
        question_text TEXT NOT NULL,
        options TEXT NOT NULL,
        correct_index INTEGER NOT NULL,
        points REAL DEFAULT 1,
        order_index INTEGER DEFAULT 0,
        FOREIGN KEY (test_id) REFERENCES mcq_tests(id)
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS mcq_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        test_id INTEGER NOT NULL,
        student_name TEXT NOT NULL,
        device_id TEXT,
        ip_address TEXT,
        answers TEXT,
        score REAL DEFAULT 0,
        possible_duplicate INTEGER DEFAULT 0,
        submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (test_id) REFERENCES mcq_tests(id)
      );
    `);

    const autoMigrations = [
      'ALTER TABLE assignments ADD COLUMN bundle_code TEXT;',
      'ALTER TABLE assignments ADD COLUMN group_title TEXT;',
      'ALTER TABLE submissions ADD COLUMN teacher_name TEXT;',
      'ALTER TABLE submissions ADD COLUMN device_id TEXT;',
      'ALTER TABLE submissions ADD COLUMN essay_text TEXT;',
      'ALTER TABLE submissions ADD COLUMN similarity_score INTEGER DEFAULT 0;',
      'ALTER TABLE submissions ADD COLUMN similarity_details TEXT;',
      'ALTER TABLE submissions ADD COLUMN ai_score INTEGER DEFAULT 0;',
      'ALTER TABLE submissions ADD COLUMN ai_details TEXT;',
      'ALTER TABLE submissions ADD COLUMN web_score INTEGER DEFAULT 0;',
      'ALTER TABLE submissions ADD COLUMN ip_address TEXT;',
      'ALTER TABLE submissions ADD COLUMN possible_duplicate INTEGER DEFAULT 0;',
      'ALTER TABLE mcq_tests ADD COLUMN max_plays INTEGER DEFAULT 0;',
      `CREATE TABLE IF NOT EXISTS mcq_tests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        teacher_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        audio_path TEXT,
        deadline TEXT,
        status TEXT DEFAULT 'draft',
        code TEXT UNIQUE NOT NULL,
        max_plays INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (teacher_id) REFERENCES users(id)
      );`,
      `CREATE TABLE IF NOT EXISTS mcq_questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        test_id INTEGER NOT NULL,
        question_text TEXT NOT NULL,
        options TEXT NOT NULL,
        correct_index INTEGER NOT NULL,
        points REAL DEFAULT 1,
        order_index INTEGER DEFAULT 0,
        FOREIGN KEY (test_id) REFERENCES mcq_tests(id)
      );`,
      `CREATE TABLE IF NOT EXISTS mcq_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        test_id INTEGER NOT NULL,
        student_name TEXT NOT NULL,
        device_id TEXT,
        ip_address TEXT,
        answers TEXT,
        score REAL DEFAULT 0,
        possible_duplicate INTEGER DEFAULT 0,
        submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (test_id) REFERENCES mcq_tests(id)
      );`
    ];

    for (const sql of autoMigrations) {
      try { await db.execute(sql); } catch (_) {}
    }

    console.log('Connected to Database successfully.');
    cleanExpiredAssignments();
  } catch (err) {
    console.error('Database initialization error:', err.message);
  }
}
initDatabase();

// ----------------- ASSIGNMENT CLEANUP LIFECYCLE -----------------
// 2-day grace period gives teachers time to review scores and handle dispute edge cases before permanent deletion.
// Hourly schedule balances timely disk/DB reclamation against avoiding unnecessary database connection overhead.
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

// Middleware
app.use(cors());
app.use(express.json({ limit: '30mb' }));
app.use(cookieParser());

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

const mcqUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB per file to safely accommodate .wav / high-bitrate audio
    fieldSize: 10 * 1024 * 1024
  }
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// ----------------- GEMINI AI EVALUATION ENGINE -----------------
// Falls back from gemini-3.6-flash (primary, high speed & quality) to gemini-3.5-flash to prevent outages if the primary model degrades.
// Retries only on transient capacity/rate errors (500, 503, high demand, quota) where backoff helps, skipping non-recoverable 4xx errors.
async function callGemini(inputPayload, configOverride = null) {
  const models = ['gemini-3.6-flash', 'gemini-3.5-flash'];
  let lastErr;

  const defaultConfig = {
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
  };

  const activeConfig = configOverride || defaultConfig;

  for (const modelName of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: inputPayload,
          config: activeConfig
        });
        return response.text;
      } catch (err) {
        const errMsg = err.message || '';
        console.warn(`[${modelName} attempt ${attempt + 1}] Notice: ${errMsg}`);
        lastErr = err;
        
        if (errMsg.includes('500') || errMsg.includes('503') || errMsg.includes('high demand') || errMsg.includes('quota')) {
          await delay(800 * (attempt + 1));
          continue;
        }
        break;
      }
    }
  }
  throw lastErr;
}

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

// Admin Password Reset with Server-Side Validation
app.post('/api/admin/users/:id/reset-password', authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { newPassword } = req.body;

  if (!newPassword || typeof newPassword !== 'string' || !newPassword.trim()) {
    return res.status(400).json({ error: 'Please provide a valid new password.' });
  }

  const cleanPassword = newPassword.trim();
  if (!isStrongPassword(cleanPassword)) {
    return res.status(400).json({ 
      error: 'Password must be at least 8 characters and include uppercase, lowercase, a number, and a special character.' 
    });
  }

  const hashedPassword = await bcrypt.hash(cleanPassword, 10);
  await db.execute({ 
    sql: 'UPDATE users SET password = ? WHERE id = ?', 
    args: [hashedPassword, Number(id)] 
  });
  
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

// ----------------- ASSIGNMENTS & EVALUATIONS -----------------
app.post(
  '/api/assignments/create-bundle',
  authenticateToken,
  requireApprovedUser,
  upload.any(),
  async (req, res) => {
    try {
      const { deadline, groupTitle } = req.body;
      let tasks = [];
      try {
        tasks = JSON.parse(req.body.tasks || '[]');
      } catch (e) {
        return res.status(400).json({ error: 'Invalid tasks configuration.' });
      }

      if (!tasks.length) {
        return res.status(400).json({ error: 'Please configure at least one assignment task.' });
      }

      const bundleCode = crypto.randomBytes(4).toString('hex');
      const deadlineVal = deadline && deadline.trim() ? deadline.trim() : null;
      const finalGroupTitle = (groupTitle && groupTitle.trim()) ? groupTitle.trim() : (tasks[0].title + ' Bundle');
      const createdTasks = [];

      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        const taskCode = crypto.randomBytes(4).toString('hex');
        const schemeFiles = (req.files || []).filter(f => f.fieldname === `scheme_${i}`);

        const resolvedTitle = (task.title && task.title.trim()) ? task.title.trim() : `Task ${i + 1}`;
        let extractedSchemeText = task.schemeText || '';
        const cachedSchemePayload = [];

        for (const sFile of schemeFiles) {
          if (isPdf(sFile)) {
            const pdfTxt = await extractText(sFile);
            if (pdfTxt && pdfTxt.trim()) {
              extractedSchemeText += `\n[Rubric Content]:\n${pdfTxt}\n`;
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
                mimeType,
                data: sFile.buffer.toString('base64')
              }
            });
          } else {
            const txt = await extractText(sFile);
            if (txt.trim()) extractedSchemeText += `\n[Rubric File: ${sFile.originalname}]\n${txt}\n`;
          }
        }

        await db.execute({
          sql: `INSERT INTO assignments 
                (code, bundle_code, group_title, teacher_id, title, deadline, scheme_text, scheme_files_json) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            taskCode,
            bundleCode,
            finalGroupTitle,
            req.user.id,
            resolvedTitle,
            deadlineVal,
            extractedSchemeText,
            JSON.stringify(cachedSchemePayload)
          ]
        });

        createdTasks.push({ code: taskCode, title: resolvedTitle });
      }

      return res.json({
        success: true,
        bundleCode,
        groupTitle: finalGroupTitle,
        tasks: createdTasks,
        link: `${req.protocol}://${req.get('host')}/submit.html?bundle=${bundleCode}`
      });
    } catch (err) {
      console.error('Bundle creation error:', err);
      return res.status(500).json({ error: err.message || 'Failed to create assignment bundle.' });
    }
  }
);

app.post('/api/assignments/bundle/:bundleCode/tasks', authenticateToken, requireApprovedUser, upload.any(), async (req, res) => {
  try {
    const { bundleCode } = req.params;
    const { title, schemeText } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, error: 'Task title is required.' });
    }

    const check = await db.execute({
      sql: 'SELECT teacher_id, group_title, deadline FROM assignments WHERE bundle_code = ? LIMIT 1',
      args: [bundleCode]
    });

    if (!check.rows || check.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Bundle package not found.' });
    }

    const parent = check.rows[0];
    const isElevated = ['root', 'admin'].includes(req.user.role);
    if (!isElevated && parent.teacher_id !== req.user.id) {
      return res.status(403).json({ success: false, error: 'Unauthorized.' });
    }

    const newTaskCode = crypto.randomBytes(4).toString('hex');
    const schemeFiles = (req.files || []).filter(f => f.fieldname === 'scheme');
    let extractedSchemeText = schemeText || '';
    const cachedSchemePayload = [];

    for (const sFile of schemeFiles) {
      if (isPdf(sFile)) {
        const pdfTxt = await extractText(sFile);
        if (pdfTxt && pdfTxt.trim()) {
          extractedSchemeText += `\n[Rubric Content]:\n${pdfTxt}\n`;
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
            mimeType,
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

    await db.execute({
      sql: `INSERT INTO assignments (code, bundle_code, group_title, teacher_id, title, deadline, scheme_text, scheme_files_json) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        newTaskCode,
        bundleCode,
        parent.group_title,
        parent.teacher_id,
        title.trim(),
        parent.deadline,
        extractedSchemeText,
        JSON.stringify(cachedSchemePayload)
      ]
    });

    res.json({ success: true, message: 'Task added successfully with rubric criteria.', code: newTaskCode });
  } catch (err) {
    console.error('Add Task Error:', err);
    res.status(500).json({ success: false, error: 'Failed to add task.' });
  }
});

app.patch('/api/assignments/tasks/:code/rename', authenticateToken, requireApprovedUser, async (req, res) => {
  try {
    const { code } = req.params;
    const { title } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, error: 'Task title cannot be empty.' });
    }

    const isElevated = ['root', 'admin'].includes(req.user.role);
    const check = await db.execute({
      sql: 'SELECT id FROM assignments WHERE code = ?' + (isElevated ? '' : ' AND teacher_id = ?'),
      args: isElevated ? [code] : [code, req.user.id]
    });

    if (!check.rows || check.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Task not found or unauthorized.' });
    }

    await db.execute({
      sql: 'UPDATE assignments SET title = ? WHERE code = ?',
      args: [title.trim(), code]
    });

    res.json({ success: true, message: 'Task renamed successfully.', title: title.trim() });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to rename task.' });
  }
});

app.delete('/api/assignments/tasks/:code', authenticateToken, requireApprovedUser, async (req, res) => {
  try {
    const { code } = req.params;
    const isElevated = ['root', 'admin'].includes(req.user.role);

    const check = await db.execute({
      sql: 'SELECT id, teacher_id, bundle_code FROM assignments WHERE code = ?' + (isElevated ? '' : ' AND teacher_id = ?'),
      args: isElevated ? [code] : [code, req.user.id]
    });

    const task = check.rows[0];
    if (!task) return res.status(404).json({ success: false, error: 'Task not found or unauthorized.' });

    if (task.bundle_code) {
      const countCheck = await db.execute({
        sql: 'SELECT COUNT(*) as cnt FROM assignments WHERE bundle_code = ?',
        args: [task.bundle_code]
      });
      if (countCheck.rows[0].cnt <= 1) {
        return res.status(400).json({ success: false, error: 'Cannot delete the only remaining task in a package. Delete the entire form instead.' });
      }
    }

    await db.execute({ sql: 'DELETE FROM submissions WHERE assignment_id = ?', args: [task.id] });
    await db.execute({ sql: 'DELETE FROM assignments WHERE id = ?', args: [task.id] });

    res.json({ success: true, message: 'Task removed successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to delete task.' });
  }
});

app.get('/api/public/bundle/:bundleCode', async (req, res) => {
  try {
    const { bundleCode } = req.params;
    const result = await db.execute({
      sql: `SELECT a.id, a.code, a.bundle_code, a.group_title, a.title, a.deadline, u.name as teacher_name 
            FROM assignments a 
            JOIN users u ON a.teacher_id = u.id 
            WHERE a.bundle_code = ? OR a.code = ? 
            ORDER BY a.id ASC`,
      args: [bundleCode, bundleCode]
    });

    if (!result.rows || result.rows.length === 0) {
      return res.status(404).json({ error: 'Assignment bundle not found or expired.' });
    }

    const first = result.rows[0];
    let isPastDeadline = false;
    if (first.deadline) {
      const ddl = new Date(first.deadline).getTime();
      isPastDeadline = !isNaN(ddl) && Date.now() > ddl;
    }

    res.json({
      success: true,
      teacherName: first.teacher_name,
      groupTitle: first.group_title || first.title,
      deadline: first.deadline,
      isPastDeadline,
      tasks: result.rows.map(r => ({ code: r.code, title: r.title }))
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve assignment bundle.' });
  }
});

app.get('/api/assignments', authenticateToken, requireApprovedUser, async (req, res) => {
  try {
    const result = await db.execute({
      sql: `SELECT id, code, bundle_code, group_title, title, deadline, created_at,
            (SELECT COUNT(*) FROM submissions WHERE assignment_id = assignments.id) as submission_count
            FROM assignments WHERE teacher_id = ? ORDER BY id DESC`,
      args: [req.user.id]
    });
    res.json({ success: true, assignments: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch assignments.' });
  }
});

app.get('/api/assignments/:code/submissions', authenticateToken, requireApprovedUser, async (req, res) => {
  try {
    const { code } = req.params;
    const isElevated = ['root', 'admin'].includes(req.user.role);
    const assignResult = await db.execute({
      sql: 'SELECT id, title, deadline FROM assignments WHERE code = ?' + (isElevated ? '' : ' AND teacher_id = ?'),
      args: isElevated ? [code] : [code, req.user.id]
    });

    const assignment = assignResult.rows[0];
    if (!assignment) return res.status(404).json({ error: 'Assignment not found.' });

    const subsResult = await db.execute({
      sql: `SELECT id, student_name as name, student_name, teacher_name, page_count as pageCount, total_score, 
            category_breakdown, mistakes, weaknesses, similarity_score, similarity_details, ai_score, ai_details, web_score, 
            possible_duplicate, ip_address, created_at 
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
    res.status(500).json({ error: 'Failed to update deadline.' });
  }
});

// DELETE a single student submission strictly by numeric ID
app.delete('/api/assignments/:code/submissions/:submissionId', authenticateToken, requireApprovedUser, async (req, res) => {
  const { code, submissionId } = req.params;
  const numId = parseInt(submissionId, 10);

  if (isNaN(numId) || numId <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid submission ID format. Numeric ID is required.' });
  }

  try {
    const isElevated = ['root', 'admin'].includes(req.user.role);

    const assignResult = await db.execute({
      sql: 'SELECT id FROM assignments WHERE code = ?' + (isElevated ? '' : ' AND teacher_id = ?'),
      args: isElevated ? [code] : [code, req.user.id]
    });

    if (!assignResult.rows || assignResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Assignment not found or unauthorized.' });
    }

    const assignmentId = assignResult.rows[0].id;

    const subResult = await db.execute({
      sql: 'SELECT id, student_name FROM submissions WHERE assignment_id = ? AND id = ?',
      args: [assignmentId, numId]
    });

    if (!subResult.rows || subResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Submission record not found for this assignment.' });
    }

    const studentName = subResult.rows[0].student_name;

    await db.execute({
      sql: 'DELETE FROM submissions WHERE id = ?',
      args: [numId]
    });

    return res.json({ 
      success: true, 
      message: `Submission for "${studentName}" (ID: ${numId}) permanently deleted. Student can now resubmit.` 
    });
  } catch (err) {
    console.error('Error deleting submission by ID:', err);
    return res.status(500).json({ success: false, error: 'Failed to remove submission.' });
  }
});

// PATCH update student submission feedback, scores, or student name
app.patch('/api/assignments/:code/submissions/:submissionId', authenticateToken, requireApprovedUser, async (req, res) => {
  const { code, submissionId } = req.params;
  const numId = parseInt(submissionId, 10);

  if (isNaN(numId) || numId <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid submission ID format. Numeric ID is required.' });
  }

  try {
    const isElevated = ['root', 'admin'].includes(req.user.role);

    const assignResult = await db.execute({
      sql: 'SELECT id FROM assignments WHERE code = ?' + (isElevated ? '' : ' AND teacher_id = ?'),
      args: isElevated ? [code] : [code, req.user.id]
    });

    if (!assignResult.rows || assignResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Assignment not found or unauthorized.' });
    }

    const assignmentId = assignResult.rows[0].id;

    const subCheck = await db.execute({
      sql: 'SELECT id FROM submissions WHERE assignment_id = ? AND id = ?',
      args: [assignmentId, numId]
    });

    if (!subCheck.rows || subCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Submission record not found for this assignment.' });
    }

    const updates = [];
    const args = [];

    const nameVal = req.body.student_name !== undefined ? req.body.student_name : req.body.name;
    if (nameVal !== undefined) {
      updates.push('student_name = ?');
      args.push(String(nameVal).trim());
    }

    for (const field of ['total_score', 'category_breakdown', 'mistakes', 'weaknesses']) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        args.push(String(req.body[field]).trim());
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, error: 'No valid update fields provided.' });
    }

    args.push(numId);
    await db.execute({
      sql: `UPDATE submissions SET ${updates.join(', ')} WHERE id = ?`,
      args
    });

    return res.json({ success: true, message: 'Submission updated successfully.' });
  } catch (err) {
    console.error('Error updating submission by ID:', err);
    return res.status(500).json({ success: false, error: 'Failed to update submission.' });
  }
});


app.get('/api/assignments/:code/logs', authenticateToken, requireApprovedUser, async (req, res) => {
  const { code } = req.params;
  try {
    const result = await db.execute({
      sql: `SELECT student_name, assignment_title, teacher_name, submitted_at 
            FROM submission_logs 
            WHERE assignment_code = ? 
            ORDER BY submitted_at DESC`,
      args: [code]
    });

    res.json({ success: true, logs: result.rows || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch submission logs.' });
  }
});

app.delete('/api/assignments/:code', authenticateToken, requireApprovedUser, async (req, res) => {
  try {
    const { code } = req.params;
    const isElevated = ['root', 'admin'].includes(req.user.role);

    const assignResult = await db.execute({
      sql: 'SELECT id, bundle_code, title FROM assignments WHERE code = ?' + (isElevated ? '' : ' AND teacher_id = ?'),
      args: isElevated ? [code] : [code, req.user.id]
    });

    const assignment = assignResult.rows[0];
    if (!assignment) {
      return res.status(404).json({ success: false, error: 'Assignment not found or unauthorized.' });
    }

    const targetBundleCode = assignment.bundle_code;
    let assignmentIdsToDelete = [assignment.id];

    if (targetBundleCode) {
      const bundleMembers = await db.execute({
        sql: 'SELECT id FROM assignments WHERE bundle_code = ?',
        args: [targetBundleCode]
      });
      assignmentIdsToDelete = bundleMembers.rows.map(r => r.id);
    }

    for (const id of assignmentIdsToDelete) {
      await db.execute({ sql: 'DELETE FROM submissions WHERE assignment_id = ?', args: [id] });
      await db.execute({ sql: 'DELETE FROM assignments WHERE id = ?', args: [id] });
    }

    return res.json({ success: true, message: `Assignment successfully deleted from the database.` });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to delete assignment.' });
  }
});

app.get('/api/public/assignment/:code/status', async (req, res) => {
  try {
    const { code } = req.params;
    const { deviceId } = req.query;

    const assignResult = await db.execute({
      sql: 'SELECT id FROM assignments WHERE code = ?',
      args: [code]
    });

    if (!assignResult.rows || assignResult.rows.length === 0) {
      return res.status(404).json({ error: 'Assignment not found.' });
    }

    const assignmentId = assignResult.rows[0].id;
    const subCheck = await db.execute({
      sql: 'SELECT id FROM submissions WHERE assignment_id = ? AND device_id = ?',
      args: [assignmentId, deviceId || '']
    });

    return res.json({ success: true, hasSubmitted: subCheck.rows.length > 0 });
  } catch (err) {
    return res.status(500).json({ error: 'Status check failed.' });
  }
});

// Student Public Upload
app.post(
  '/api/public/submit/:code',
  rateLimit({ windowMs: 60 * 1000, max: 10 }),
  upload.fields([{ name: 'pages', maxCount: 20 }]),
  async (req, res) => {
    try {
      const { code } = req.params;
      const studentNameInput = (req.body.studentName || '').trim();
      const deviceIdInput = (req.body.deviceId || '').trim();
      const clientIp = getClientIp(req);

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
          sql: 'SELECT id FROM submissions WHERE assignment_id = ? AND device_id = ?',
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

      let promptText = `You are a professional teacher evaluating a student writing assessment.
Examine the student's attached work strictly against the provided marking scheme rubric.

CRITICAL SCORING & MULTI-PAGE RULES:
- The student's attached pages are CONTINUATION PAGES of the SAME single assessment/essay, NOT separate assessments.
- DO NOT increase, multiply, or alter the total achievable marks based on the number of pages attached.
- STRICT MARKING SCHEME ADHERENCE: Read the rubric carefully to find the EXACT total possible marks (e.g., out of 20, 25, 40, etc.). 
- The denominator in "total_score" and the sum of category maximums in "category_breakdown" MUST MATCH the total maximum score specified in the rubric exactly. NEVER invent or expand the total score beyond what the rubric states.

INSTRUCTIONS:
1. Extract and transcribe the student's entire essay text across all pages in sequential order into "extracted_essay".
2. Grade strictly according to the rubric criteria.
3. In "total_score", provide the awarded marks over the rubric's exact total maximum (e.g., "awarded_score/rubric_max").
4. In "category_breakdown", list each individual marking category with its score and category maximum on a new line starting with a hyphen (e.g., "- Structure: X/Y\\n- Content: X/Y"). The sum of all Y's must equal the rubric's exact total.
5. In "mistakes", list line-by-line errors starting with hyphens with quoted excerpts and corrections.
6. In "weaknesses", suggest actionable revision points starting with hyphens.
7. Perform an integrity check:
   - "ai_probability_score": integer (0 to 100) rating likelihood of AI generation.
   - "ai_detection_notes": brief summary of language patterns.
   - "web_similarity_score": integer (0 to 100) estimating similarity to known web articles or Wikipedia.

Respond ONLY with valid JSON matching the schema.`;

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
              mimeType,
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
        console.error('Gemini evaluation error:', aiErr);
      }

      if (!parsedFeedback) {
        parsedFeedback = {
          student_name: studentNameInput,
          extracted_essay: '',
          total_score: '—',
          category_breakdown: '- Structure: 0/6\n- Content: 0/6\n- SPaG: 0/4',
          mistakes: '- Please review image legibility manually',
          weaknesses: '- Needs manual review',
          ai_probability_score: 0,
          ai_detection_notes: 'Analysis unverified',
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

      // Secondary duplicate check: flag if another submission for the same assignment and IP occurred within the last 10 minutes
      let isPossibleDuplicate = false;
      if (clientIp && clientIp !== 'unknown') {
        const dupCheck = await db.execute({
          sql: `SELECT id FROM submissions 
                WHERE assignment_id = ? 
                  AND ip_address = ? 
                  AND created_at >= datetime('now', '-10 minutes') 
                LIMIT 1`,
          args: [assignment.id, clientIp]
        });
        isPossibleDuplicate = dupCheck.rows && dupCheck.rows.length > 0;
      }

      const finalName = studentNameInput || parsedFeedback.student_name || 'Student';
      const teacherName = assignment.teacher_name || 'Teacher';

      await db.execute({
        sql: `INSERT INTO submissions 
              (assignment_id, student_name, teacher_name, device_id, ip_address, possible_duplicate, essay_text, page_count, total_score, category_breakdown, mistakes, weaknesses, similarity_score, similarity_details, ai_score, ai_details, web_score)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          assignment.id,
          finalName,
          teacherName,
          deviceIdInput || null,
          clientIp || null,
          isPossibleDuplicate ? 1 : 0,
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

      try {
        await db.execute({
          sql: `INSERT INTO submission_logs (student_name, assignment_code, assignment_title, teacher_name, submitted_at)
                VALUES (?, ?, ?, ?, datetime('now'))`,
          args: [finalName, assignment.code, assignment.title, teacherName || 'Teacher']
        });
      } catch (logErr) {
        console.error('Audit log notice:', logErr.message);
      }

      return res.json({
        success: true,
        message: 'Your work has been received and evaluated successfully!',
        studentName: finalName,
        possible_duplicate: isPossibleDuplicate
      });
    } catch (err) {
      console.error('Student Upload Error:', err);
      return res.status(500).json({ error: err.message || 'Error processing submission.' });
    }
  }
);

// Manual Direct Batch Marking
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
      const extraNotes = req.body.schemeText || '';

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
              mimeType,
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

        let promptText = `You are a professional exam evaluator reviewing a student's writing assessment.
Extract the student's handwritten name from the header if visible, or fallback to: "${job.assignedName}".
Grade strictly against the marking scheme criteria.

CRITICAL SCORING RULES:
- The attached files/pages for this student are continuation pages of ONE single assessment. Do not expand or multiply the maximum marks for multiple pages.
- The total achievable marks (denominator) in "total_score" and the sum of all category maximums in "category_breakdown" MUST EXACTLY equal the maximum possible marks established by the rubric.

INSTRUCTIONS:
- Transcribe the essay in full across all pages into 'extracted_essay'.
- Format 'total_score' as "awarded_score/rubric_max".
- In 'category_breakdown', 'mistakes', and 'weaknesses', list EVERY bullet on a new line starting with a hyphen '-'.
- Format mistakes line-by-line with exact quoted snippets (e.g. Paragraph 1: 'word' -> 'correction').
- Rate 'ai_probability_score' (0-100) and 'web_similarity_score' (0-100).
Respond ONLY with valid JSON matching the schema.`;

        if (allSchemeText.trim()) promptText += `\n\nMARKING SCHEME CRITERIA:\n${allSchemeText}`;
        if (extraNotes.trim()) promptText += `\n\nTEACHER NOTES & GUIDELINES:\n${extraNotes}`;

        for (let p = 0; p < job.files.length; p++) {
          const file = job.files[p];
          if (isImage(file)) {
            let mimeType = file.mimetype || 'image/png';
            if (!mimeType.startsWith('image/')) mimeType = 'image/png';
            inputPayload.push({
              inlineData: {
                mimeType,
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
            similarity_details: 'Batch manual mode'
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

// ----------------- MCQ TESTS (FILEBASE S3 & GEMINI GENERATION) -----------------

function getMissingFilebaseEnvVars() {
  const required = ['FILEBASE_ACCESS_KEY', 'FILEBASE_SECRET_KEY', 'FILEBASE_BUCKET_NAME', 'FILEBASE_ENDPOINT'];
  return required.filter((v) => !process.env[v] || !process.env[v].trim());
}

function getFilebaseEndpoint() {
  const rawEndpoint = (process.env.FILEBASE_ENDPOINT || 'https://s3.filebase.io').trim();
  const endpoint = rawEndpoint.startsWith('http://') || rawEndpoint.startsWith('https://')
    ? rawEndpoint
    : `https://${rawEndpoint}`;
  return endpoint.replace('s3.filebase.com', 's3.filebase.io').replace(/\/+$/, '');
}

async function uploadAudioToFilebase(audioFile) {
  const missing = getMissingFilebaseEnvVars();
  if (missing.length > 0) {
    throw new Error(`Filebase storage configuration error: Missing required environment variable(s): ${missing.join(', ')}`);
  }

  const endpoint = getFilebaseEndpoint();
  const s3Client = new S3Client({
    endpoint,
    region: 'us-east-1',
    credentials: {
      accessKeyId: process.env.FILEBASE_ACCESS_KEY.trim(),
      secretAccessKey: process.env.FILEBASE_SECRET_KEY.trim()
    },
    forcePathStyle: true
  });

  const fileExt = path.extname(audioFile.originalname || '') || '.mp3';
  const safeExt = fileExt.toLowerCase().startsWith('.') ? fileExt.toLowerCase() : `.${fileExt.toLowerCase()}`;
  const objectKey = `mcq-audio/${Date.now()}_${crypto.randomBytes(6).toString('hex')}${safeExt}`;
  const bucketName = process.env.FILEBASE_BUCKET_NAME.trim();

  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: objectKey,
      Body: audioFile.buffer,
      ContentType: audioFile.mimetype || 'audio/mpeg'
    })
  );

  // Return ONLY the object key (e.g. "mcq-audio/12345_abc.wav")
  return objectKey;
}

async function generateSignedAudioUrl(objectKey) {
  if (!objectKey) return null;
  const missing = getMissingFilebaseEnvVars();
  if (missing.length > 0) return null;

  try {
    const endpoint = getFilebaseEndpoint();
    const s3Client = new S3Client({
      endpoint,
      region: 'us-east-1',
      credentials: {
        accessKeyId: process.env.FILEBASE_ACCESS_KEY.trim(),
        secretAccessKey: process.env.FILEBASE_SECRET_KEY.trim()
      },
      forcePathStyle: true
    });

    const command = new GetObjectCommand({
      Bucket: process.env.FILEBASE_BUCKET_NAME.trim(),
      Key: objectKey
    });

    // Valid for 1 hour (3600 seconds)
    return await getSignedUrl(s3Client, command, { expiresIn: 3600 });
  } catch (err) {
    console.warn(`[Filebase Pre-sign Warning] Failed to generate signed URL for ${objectKey}:`, err.message);
    return null;
  }
}

async function deleteAudioFromFilebase(objectKey) {
  try {
    const missing = getMissingFilebaseEnvVars();
    if (missing.length > 0 || !objectKey) return;

    const endpoint = getFilebaseEndpoint();
    const s3Client = new S3Client({
      endpoint,
      region: 'us-east-1',
      credentials: {
        accessKeyId: process.env.FILEBASE_ACCESS_KEY.trim(),
        secretAccessKey: process.env.FILEBASE_SECRET_KEY.trim()
      },
      forcePathStyle: true
    });

    await s3Client.send(
      new DeleteObjectCommand({
        Bucket: process.env.FILEBASE_BUCKET_NAME.trim(),
        Key: objectKey
      })
    );
    console.log(`[Filebase Cleanup] Successfully deleted orphaned audio: ${objectKey}`);
  } catch (delErr) {
    console.warn(`[Filebase Cleanup Notice] Failed to delete orphaned audio ${objectKey}:`, delErr.message);
  }
}

async function generateUniqueMcqCode() {
  for (let i = 0; i < 10; i++) {
    const code = crypto.randomBytes(4).toString('hex');
    const existing = await db.execute({
      sql: 'SELECT id FROM mcq_tests WHERE code = ? LIMIT 1',
      args: [code]
    });
    if (existing.rows.length === 0) return code;
  }
  return crypto.randomBytes(6).toString('hex');
}

app.post(
  '/api/mcq/generate',
  authenticateToken,
  requireApprovedUser,
  (req, res, next) => {
    mcqUpload.any()(req, res, (err) => {
      if (err) {
        console.error('Multer file upload error on /api/mcq/generate:', err);
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ success: false, error: 'File too large. Maximum allowed file size is 100MB.' });
        }
        return res.status(400).json({ success: false, error: `File upload error: ${err.message}` });
      }
      next();
    });
  },
  async (req, res) => {
    let uploadedAudioKey = null;
    try {
      const { title, deadline } = req.body;
      const maxPlays = Math.max(0, parseInt(req.body.maxPlays || req.body.max_plays, 10) || 0);
      const files = req.files || [];

      if (!title || !title.trim()) {
        return res.status(400).json({ success: false, error: 'Test title is required.' });
      }

      const pdfFile = files.find((f) => f.fieldname === 'pdf');
      if (!pdfFile || !isPdf(pdfFile)) {
        return res.status(400).json({ success: false, error: 'A test PDF file is required (fieldname "pdf").' });
      }

      const markingSchemeFile = files.find((f) => f.fieldname === 'markingScheme' || f.fieldname === 'marking_scheme');
      const markingSchemeText = (req.body.markingScheme || req.body.marking_scheme || '').toString().trim();

      if (!markingSchemeFile && !markingSchemeText) {
        return res.status(400).json({ success: false, error: 'A marking scheme is required as either a file ("markingScheme") or text.' });
      }

      const audioFile = files.find((f) => f.fieldname === 'audio');
      let audioPath = null;

      // Handle audio upload to Filebase S3 if audio file is present
      if (audioFile) {
        const missing = getMissingFilebaseEnvVars();
        if (missing.length > 0) {
          return res.status(500).json({
            success: false,
            error: `Filebase S3 configuration is incomplete. Missing required environment variable(s): ${missing.join(', ')}`
          });
        }

        try {
          const objectKey = await uploadAudioToFilebase(audioFile);
          audioPath = objectKey;
          uploadedAudioKey = objectKey;
        } catch (uploadErr) {
          console.error('Filebase upload failed:', uploadErr);
          return res.status(500).json({ success: false, error: `Failed to upload audio to Filebase: ${uploadErr.message}` });
        }
      }

      // Build Gemini Input Payload
      const inputPayload = [];

      // 1. Attach test PDF
      inputPayload.push({
        inlineData: {
          mimeType: 'application/pdf',
          data: pdfFile.buffer.toString('base64')
        }
      });

      // 2. Attach marking scheme
      let markingSchemePromptAddon = '';
      if (markingSchemeFile) {
        if (isPdf(markingSchemeFile)) {
          inputPayload.push({
            inlineData: {
              mimeType: 'application/pdf',
              data: markingSchemeFile.buffer.toString('base64')
            }
          });
        } else if (isImage(markingSchemeFile)) {
          let mimeType = markingSchemeFile.mimetype || 'image/png';
          if (!mimeType.startsWith('image/')) mimeType = 'image/png';
          inputPayload.push({
            inlineData: {
              mimeType,
              data: markingSchemeFile.buffer.toString('base64')
            }
          });
        } else {
          const extractedText = await extractText(markingSchemeFile);
          if (extractedText && extractedText.trim()) {
            markingSchemePromptAddon += `\n\nMARKING SCHEME / ANSWER KEY:\n${extractedText.trim()}`;
          } else {
            markingSchemePromptAddon += `\n\nMARKING SCHEME / ANSWER KEY:\n${markingSchemeFile.buffer.toString('utf-8')}`;
          }
        }
      }

      if (markingSchemeText) {
        markingSchemePromptAddon += `\n\nMARKING SCHEME / ANSWER KEY (TEXT):\n${markingSchemeText}`;
      }

      // 3. Prompt instructing Gemini to convert PDF questions into MCQ JSON array
      const promptText = `You are an expert exam creator and assessor.
You are provided with an examination/test PDF document and its official marking scheme / answer key.
Your task is to convert each question from the test PDF into multiple-choice format (MCQ).

CRITICAL INSTRUCTIONS:
1. For every question in the test PDF:
   - "question": Extract or formulate the clear question text as a string.
   - "options": An array of EXACTLY 4 strings representing plausible options. One must be the correct answer, and the remaining 3 must be plausible distractors.
   - "correct_index": An integer (0, 1, 2, or 3) indicating which option in "options" is the correct answer. You MUST use the marking scheme/answer key to determine the correct option.
   - "points": A positive number representing the awarded marks/points for this question as indicated in the marking scheme. If unspecified in the marking scheme, default to 1.
2. Maintain the natural sequence of questions as presented in the test PDF.
3. Return ONLY a JSON array matching the schema:
   [
     {
       "question": "string",
       "options": ["string", "string", "string", "string"],
       "correct_index": 0,
       "points": 1
     }
   ]
${markingSchemePromptAddon}`;

      inputPayload.push(promptText);

      // Define Gemini JSON Array Schema
      const mcqConfig = {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              question: { type: 'STRING' },
              options: {
                type: 'ARRAY',
                items: { type: 'STRING' }
              },
              correct_index: { type: 'INTEGER' },
              points: { type: 'NUMBER' }
            },
            required: ['question', 'options', 'correct_index', 'points']
          }
        }
      };

      let rawOutput;
      try {
        rawOutput = await callGemini(inputPayload, mcqConfig);
      } catch (aiErr) {
        if (uploadedAudioKey) {
          try { await deleteAudioFromFilebase(uploadedAudioKey); } catch (_) {}
        }
        console.error('Gemini MCQ generation call error:', aiErr);
        return res.status(502).json({ success: false, error: `AI question generation failed: ${aiErr.message || 'Gemini service error.'}` });
      }

      // Parse and Validate JSON
      let parsedQuestions = null;
      try {
        let cleanText = (rawOutput || '').trim();
        if (cleanText.startsWith('```')) {
          cleanText = cleanText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        }
        parsedQuestions = JSON.parse(cleanText);
      } catch (parseErr) {
        if (uploadedAudioKey) {
          try { await deleteAudioFromFilebase(uploadedAudioKey); } catch (_) {}
        }
        console.error('MCQ JSON parse error:', parseErr, 'Raw output:', rawOutput);
        return res.status(422).json({ success: false, error: 'Failed to parse AI output into valid JSON questions.' });
      }

      if (!Array.isArray(parsedQuestions) || parsedQuestions.length === 0) {
        if (uploadedAudioKey) {
          try { await deleteAudioFromFilebase(uploadedAudioKey); } catch (_) {}
        }
        return res.status(422).json({ success: false, error: 'AI returned an empty or invalid question set. Expected a non-empty array of questions.' });
      }

      const validatedQuestions = [];
      for (let i = 0; i < parsedQuestions.length; i++) {
        const item = parsedQuestions[i];
        if (!item || typeof item.question !== 'string' || !item.question.trim()) {
          if (uploadedAudioKey) {
            try { await deleteAudioFromFilebase(uploadedAudioKey); } catch (_) {}
          }
          return res.status(422).json({ success: false, error: `Question #${i + 1} has missing or empty question text.` });
        }

        if (!Array.isArray(item.options) || item.options.length !== 4) {
          if (uploadedAudioKey) {
            try { await deleteAudioFromFilebase(uploadedAudioKey); } catch (_) {}
          }
          return res.status(422).json({ success: false, error: `Question #${i + 1} must have exactly 4 options.` });
        }

        const cleanOptions = item.options.map((opt) => (opt !== null && opt !== undefined ? String(opt).trim() : ''));
        if (cleanOptions.some((opt) => !opt)) {
          if (uploadedAudioKey) {
            try { await deleteAudioFromFilebase(uploadedAudioKey); } catch (_) {}
          }
          return res.status(422).json({ success: false, error: `Question #${i + 1} contains empty or invalid option strings.` });
        }

        const correctIdx = Number(item.correct_index);
        if (!Number.isInteger(correctIdx) || correctIdx < 0 || correctIdx > 3) {
          if (uploadedAudioKey) {
            try { await deleteAudioFromFilebase(uploadedAudioKey); } catch (_) {}
          }
          return res.status(422).json({ success: false, error: `Question #${i + 1} has an invalid correct_index (${item.correct_index}). Must be 0, 1, 2, or 3.` });
        }

        const rawPoints = Number(item.points);
        const points = !isNaN(rawPoints) && rawPoints > 0 ? rawPoints : 1;

        validatedQuestions.push({
          question: item.question.trim(),
          options: cleanOptions,
          correct_index: correctIdx,
          points
        });
      }

      // Generate unique shareable code with DB collision retry
      const deadlineVal = deadline && deadline.trim() ? deadline.trim() : null;
      let testId = null;
      let testCode = null;

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          testCode = await generateUniqueMcqCode();
          const testInsert = await db.execute({
            sql: `INSERT INTO mcq_tests (teacher_id, title, audio_path, deadline, status, code, max_plays)
                  VALUES (?, ?, ?, ?, 'draft', ?, ?)`,
            args: [req.user.id, title.trim(), audioPath, deadlineVal, testCode, maxPlays]
          });
          testId = Number(testInsert.lastInsertRowid);
          break;
        } catch (insertErr) {
          if (insertErr.message && insertErr.message.includes('UNIQUE constraint failed') && attempt < 2) {
            console.warn(`[MCQ Insert] Code collision on ${testCode}. Retrying...`);
            continue;
          }
          throw insertErr;
        }
      }

      const insertedQuestions = [];

      for (let i = 0; i < validatedQuestions.length; i++) {
        const q = validatedQuestions[i];
        const qInsert = await db.execute({
          sql: `INSERT INTO mcq_questions (test_id, question_text, options, correct_index, points, order_index)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [testId, q.question, JSON.stringify(q.options), q.correct_index, q.points, i]
        });

        insertedQuestions.push({
          id: Number(qInsert.lastInsertRowid),
          test_id: testId,
          question_text: q.question,
          options: q.options,
          correct_index: q.correct_index,
          points: q.points,
          order_index: i
        });
      }

      const testRowRes = await db.execute({
        sql: 'SELECT id, teacher_id, title, audio_path, deadline, status, code, created_at, max_plays FROM mcq_tests WHERE id = ?',
        args: [testId]
      });

      const fullTest = testRowRes.rows[0];
      const signedAudioUrl = fullTest.audio_path ? await generateSignedAudioUrl(fullTest.audio_path) : null;

      return res.json({
        success: true,
        test: {
          ...fullTest,
          audio_url: signedAudioUrl
        },
        questions: insertedQuestions
      });
    } catch (err) {
      if (uploadedAudioKey) {
        try {
          await deleteAudioFromFilebase(uploadedAudioKey);
        } catch (_) {}
      }
      console.error('MCQ Generation Endpoint Error:', err);
      return res.status(500).json({ success: false, error: err.message || 'MCQ generation failed.' });
    }
  }
);

// ----------------- STAGE 5: TEACHER RESULTS & SUBMISSIONS ENDPOINTS -----------------

// 1. GET /api/mcq/teacher/tests - List all MCQ tests for teacher with attempt counts
// NOTE: Registered BEFORE /api/mcq/:testId so Express does not parse 'teacher' as a testId
app.get('/api/mcq/teacher/tests', authenticateToken, requireApprovedUser, async (req, res) => {
  try {
    const isElevated = ['root', 'admin'].includes(req.user.role);
    const query = isElevated
      ? `SELECT t.id, t.code, t.title, t.deadline, t.status, t.created_at,
                (SELECT COUNT(*) FROM mcq_attempts WHERE test_id = t.id) as attempt_count
         FROM mcq_tests t
         ORDER BY t.id DESC`
      : `SELECT t.id, t.code, t.title, t.deadline, t.status, t.created_at,
                (SELECT COUNT(*) FROM mcq_attempts WHERE test_id = t.id) as attempt_count
         FROM mcq_tests t
         WHERE t.teacher_id = ?
         ORDER BY t.id DESC`;

    const args = isElevated ? [] : [req.user.id];
    const testsRes = await db.execute({ sql: query, args });

    return res.json({
      success: true,
      tests: testsRes.rows
    });
  } catch (err) {
    console.error('Error fetching teacher MCQ tests:', err);
    return res.status(500).json({ error: 'Failed to fetch MCQ tests.' });
  }
});

// 2. GET /api/mcq/:code/attempts - View all student attempts and question key for an MCQ test
app.get('/api/mcq/:code/attempts', authenticateToken, requireApprovedUser, async (req, res) => {
  try {
    const code = (req.params.code || '').trim();
    if (!code) {
      return res.status(400).json({ error: 'Test code is required.' });
    }

    const testRes = await db.execute({
      sql: 'SELECT id, code, title, deadline, status, teacher_id FROM mcq_tests WHERE code = ?',
      args: [code]
    });
    const test = testRes.rows[0];
    if (!test) {
      return res.status(404).json({ error: 'MCQ test not found.' });
    }

    const isElevated = ['root', 'admin'].includes(req.user.role);
    if (Number(test.teacher_id) !== Number(req.user.id) && !isElevated) {
      return res.status(403).json({ error: 'Unauthorized to view attempts for this test.' });
    }

    const attemptsRes = await db.execute({
      sql: `SELECT id, student_name, device_id, ip_address, answers, score, possible_duplicate, submitted_at
            FROM mcq_attempts
            WHERE test_id = ?
            ORDER BY submitted_at ASC, id ASC`,
      args: [test.id]
    });

    const attempts = attemptsRes.rows.map((att) => {
      let parsedAnswers = att.answers;
      if (typeof parsedAnswers === 'string') {
        try {
          parsedAnswers = JSON.parse(parsedAnswers);
        } catch (_) {
          parsedAnswers = {};
        }
      }
      return {
        ...att,
        answers: parsedAnswers && typeof parsedAnswers === 'object' ? parsedAnswers : {}
      };
    });

    const questionsRes = await db.execute({
      sql: `SELECT id, question_text, options, correct_index, points, order_index
            FROM mcq_questions
            WHERE test_id = ?
            ORDER BY order_index ASC, id ASC`,
      args: [test.id]
    });

    const questions = questionsRes.rows.map((q) => {
      let opts = q.options;
      if (typeof opts === 'string') {
        try {
          opts = JSON.parse(opts);
        } catch (_) {
          opts = [];
        }
      }
      return {
        ...q,
        options: Array.isArray(opts) ? opts : []
      };
    });

    return res.json({
      success: true,
      test,
      attempts,
      questions
    });
  } catch (err) {
    console.error('Error fetching MCQ attempts:', err);
    return res.status(500).json({ error: 'Failed to fetch MCQ attempts.' });
  }
});

// 3. DELETE /api/mcq/:code/attempts/:attemptId - Delete single student attempt strictly by numeric ID
app.delete('/api/mcq/:code/attempts/:attemptId', authenticateToken, requireApprovedUser, async (req, res) => {
  try {
    const code = (req.params.code || '').trim();
    const attemptId = parseInt(req.params.attemptId, 10);
    if (!code || isNaN(attemptId) || attemptId <= 0) {
      return res.status(400).json({ error: 'Invalid test code or attempt ID.' });
    }

    const testRes = await db.execute({
      sql: 'SELECT id, teacher_id FROM mcq_tests WHERE code = ?',
      args: [code]
    });
    const test = testRes.rows[0];
    if (!test) {
      return res.status(404).json({ error: 'MCQ test not found.' });
    }

    const isElevated = ['root', 'admin'].includes(req.user.role);
    if (Number(test.teacher_id) !== Number(req.user.id) && !isElevated) {
      return res.status(403).json({ error: 'Unauthorized to delete attempts for this test.' });
    }

    const delRes = await db.execute({
      sql: 'DELETE FROM mcq_attempts WHERE id = ? AND test_id = ?',
      args: [attemptId, test.id]
    });

    if (delRes.rowsAffected === 0) {
      return res.status(404).json({ error: 'Attempt record not found for this test.' });
    }

    return res.json({
      success: true,
      message: 'Student attempt deleted. Student may now retake the test.'
    });
  } catch (err) {
    console.error('Error deleting MCQ attempt:', err);
    return res.status(500).json({ error: 'Failed to delete student attempt.' });
  }
});

// ----------------- STAGE 2: TEACHER REVIEW & PUBLISH ENDPOINTS -----------------

// 1. GET /api/mcq/:testId - Teacher view of test, questions, and fresh signed audio URL
app.get('/api/mcq/:testId', authenticateToken, requireApprovedUser, async (req, res) => {
  try {
    const testId = parseInt(req.params.testId, 10);
    if (isNaN(testId) || testId <= 0) {
      return res.status(400).json({ error: 'Invalid test ID format.' });
    }

    const testRes = await db.execute({
      sql: 'SELECT id, teacher_id, title, audio_path, deadline, status, code, created_at, max_plays FROM mcq_tests WHERE id = ?',
      args: [testId]
    });

    const test = testRes.rows[0];
    if (!test) {
      return res.status(404).json({ error: 'MCQ test not found.' });
    }

    const isElevated = ['root', 'admin'].includes(req.user.role);
    if (Number(test.teacher_id) !== Number(req.user.id) && !isElevated) {
      return res.status(403).json({ error: 'Unauthorized to view this MCQ test.' });
    }

    const qRes = await db.execute({
      sql: 'SELECT id, test_id, question_text, options, correct_index, points, order_index FROM mcq_questions WHERE test_id = ? ORDER BY order_index ASC, id ASC',
      args: [testId]
    });

    const questions = qRes.rows.map((q) => {
      let opts = q.options;
      if (typeof opts === 'string') {
        try {
          opts = JSON.parse(opts);
        } catch (_) {
          opts = [];
        }
      }
      return {
        id: q.id,
        test_id: q.test_id,
        question_text: q.question_text,
        options: Array.isArray(opts) ? opts : [],
        correct_index: q.correct_index,
        points: q.points,
        order_index: q.order_index
      };
    });

    let audioUrl = null;
    if (test.audio_path) {
      audioUrl = await generateSignedAudioUrl(test.audio_path);
    }

    return res.json({
      success: true,
      test: {
        ...test,
        audio_url: audioUrl
      },
      questions,
      audioUrl
    });
  } catch (err) {
    console.error('Error fetching MCQ test:', err);
    return res.status(500).json({ error: 'Failed to fetch MCQ test.' });
  }
});

// 2. PATCH /api/mcq/:testId/questions/:questionId - Edit question details
app.patch('/api/mcq/:testId/questions/:questionId', authenticateToken, requireApprovedUser, async (req, res) => {
  try {
    const testId = parseInt(req.params.testId, 10);
    const questionId = parseInt(req.params.questionId, 10);
    if (isNaN(testId) || isNaN(questionId) || testId <= 0 || questionId <= 0) {
      return res.status(400).json({ error: 'Invalid test ID or question ID format.' });
    }

    const testRes = await db.execute({
      sql: 'SELECT id, teacher_id FROM mcq_tests WHERE id = ?',
      args: [testId]
    });
    const test = testRes.rows[0];
    if (!test) {
      return res.status(404).json({ error: 'MCQ test not found.' });
    }

    const isElevated = ['root', 'admin'].includes(req.user.role);
    if (Number(test.teacher_id) !== Number(req.user.id) && !isElevated) {
      return res.status(403).json({ error: 'Unauthorized to edit questions for this test.' });
    }

    const qRes = await db.execute({
      sql: 'SELECT id, test_id, question_text, options, correct_index, points, order_index FROM mcq_questions WHERE id = ? AND test_id = ?',
      args: [questionId, testId]
    });
    const question = qRes.rows[0];
    if (!question) {
      return res.status(404).json({ error: 'Question not found for this test.' });
    }

    let existingOptions = [];
    try {
      existingOptions = typeof question.options === 'string' ? JSON.parse(question.options) : question.options;
    } catch (_) {
      existingOptions = [];
    }

    const { question_text, options, correct_index, points } = req.body;

    let updatedQuestionText = question.question_text;
    if (question_text !== undefined) {
      if (typeof question_text !== 'string') {
        return res.status(400).json({ error: 'Question text must be a string.' });
      }
      updatedQuestionText = question_text.trim();
    }

    let updatedOptions = existingOptions;
    if (options !== undefined) {
      if (!Array.isArray(options) || options.length < 2) {
        return res.status(400).json({ error: 'Options must be an array with at least 2 options.' });
      }
      const cleanOptions = options.map((opt) => (opt !== null && opt !== undefined ? String(opt).trim() : ''));
      if (cleanOptions.some((opt) => !opt)) {
        return res.status(400).json({ error: 'All options must be non-empty strings.' });
      }
      updatedOptions = cleanOptions;
    }

    let updatedCorrectIndex = question.correct_index;
    if (correct_index !== undefined) {
      const cIdx = Number(correct_index);
      if (!Number.isInteger(cIdx) || cIdx < 0 || cIdx >= updatedOptions.length) {
        return res.status(400).json({ error: `correct_index must be an integer between 0 and ${updatedOptions.length - 1}.` });
      }
      updatedCorrectIndex = cIdx;
    } else if (options !== undefined && (updatedCorrectIndex < 0 || updatedCorrectIndex >= updatedOptions.length)) {
      updatedCorrectIndex = 0;
    }

    let updatedPoints = question.points;
    if (points !== undefined) {
      const pNum = Number(points);
      if (isNaN(pNum) || pNum < 0) {
        return res.status(400).json({ error: 'Points must be a positive number or zero.' });
      }
      updatedPoints = pNum;
    }

    await db.execute({
      sql: `UPDATE mcq_questions 
            SET question_text = ?, options = ?, correct_index = ?, points = ?
            WHERE id = ? AND test_id = ?`,
      args: [updatedQuestionText, JSON.stringify(updatedOptions), updatedCorrectIndex, updatedPoints, questionId, testId]
    });

    return res.json({ success: true, message: 'Question updated.' });
  } catch (err) {
    console.error('Error updating MCQ question:', err);
    return res.status(500).json({ error: 'Failed to update question.' });
  }
});

// 3. POST /api/mcq/:testId/questions - Add a blank question to test
app.post('/api/mcq/:testId/questions', authenticateToken, requireApprovedUser, async (req, res) => {
  try {
    const testId = parseInt(req.params.testId, 10);
    if (isNaN(testId) || testId <= 0) {
      return res.status(400).json({ error: 'Invalid test ID format.' });
    }

    const testRes = await db.execute({
      sql: 'SELECT id, teacher_id FROM mcq_tests WHERE id = ?',
      args: [testId]
    });
    const test = testRes.rows[0];
    if (!test) {
      return res.status(404).json({ error: 'MCQ test not found.' });
    }

    const isElevated = ['root', 'admin'].includes(req.user.role);
    if (Number(test.teacher_id) !== Number(req.user.id) && !isElevated) {
      return res.status(403).json({ error: 'Unauthorized to add questions to this test.' });
    }

    const maxOrderRes = await db.execute({
      sql: 'SELECT MAX(order_index) as max_order FROM mcq_questions WHERE test_id = ?',
      args: [testId]
    });
    const maxOrder = maxOrderRes.rows[0]?.max_order;
    const nextOrder = (maxOrder !== null && maxOrder !== undefined && !isNaN(maxOrder)) ? Number(maxOrder) + 1 : 0;

    const defaultOptions = ['Option A', 'Option B', 'Option C', 'Option D'];
    const insertRes = await db.execute({
      sql: `INSERT INTO mcq_questions (test_id, question_text, options, correct_index, points, order_index)
            VALUES (?, ?, ?, 0, 1, ?)`,
      args: [testId, 'New Question', JSON.stringify(defaultOptions), nextOrder]
    });

    const newQuestionId = Number(insertRes.lastInsertRowid);
    return res.json({
      success: true,
      question: {
        id: newQuestionId,
        test_id: testId,
        question_text: 'New Question',
        options: defaultOptions,
        correct_index: 0,
        points: 1,
        order_index: nextOrder
      }
    });
  } catch (err) {
    console.error('Error adding MCQ question:', err);
    return res.status(500).json({ error: 'Failed to add question.' });
  }
});

// 4. DELETE /api/mcq/:testId/questions/:questionId - Delete question from test
app.delete('/api/mcq/:testId/questions/:questionId', authenticateToken, requireApprovedUser, async (req, res) => {
  try {
    const testId = parseInt(req.params.testId, 10);
    const questionId = parseInt(req.params.questionId, 10);
    if (isNaN(testId) || isNaN(questionId) || testId <= 0 || questionId <= 0) {
      return res.status(400).json({ error: 'Invalid test ID or question ID format.' });
    }

    const testRes = await db.execute({
      sql: 'SELECT id, teacher_id FROM mcq_tests WHERE id = ?',
      args: [testId]
    });
    const test = testRes.rows[0];
    if (!test) {
      return res.status(404).json({ error: 'MCQ test not found.' });
    }

    const isElevated = ['root', 'admin'].includes(req.user.role);
    if (Number(test.teacher_id) !== Number(req.user.id) && !isElevated) {
      return res.status(403).json({ error: 'Unauthorized to delete questions from this test.' });
    }

    const delRes = await db.execute({
      sql: 'DELETE FROM mcq_questions WHERE id = ? AND test_id = ?',
      args: [questionId, testId]
    });

    if (delRes.rowsAffected === 0) {
      return res.status(404).json({ error: 'Question not found for this test.' });
    }

    return res.json({ success: true, message: 'Question deleted.' });
  } catch (err) {
    console.error('Error deleting MCQ question:', err);
    return res.status(500).json({ error: 'Failed to delete question.' });
  }
});

// 5. POST /api/mcq/:testId/publish - Integrity check and publish test
app.post('/api/mcq/:testId/publish', authenticateToken, requireApprovedUser, async (req, res) => {
  try {
    const testId = parseInt(req.params.testId, 10);
    if (isNaN(testId) || testId <= 0) {
      return res.status(400).json({ error: 'Invalid test ID format.' });
    }

    const testRes = await db.execute({
      sql: 'SELECT id, teacher_id, title, code, status FROM mcq_tests WHERE id = ?',
      args: [testId]
    });
    const test = testRes.rows[0];
    if (!test) {
      return res.status(404).json({ error: 'MCQ test not found.' });
    }

    const isElevated = ['root', 'admin'].includes(req.user.role);
    if (Number(test.teacher_id) !== Number(req.user.id) && !isElevated) {
      return res.status(403).json({ error: 'Unauthorized to publish this test.' });
    }

    const qRes = await db.execute({
      sql: 'SELECT id, question_text, options, correct_index, points, order_index FROM mcq_questions WHERE test_id = ? ORDER BY order_index ASC',
      args: [testId]
    });

    const questions = qRes.rows;
    if (!questions || questions.length === 0) {
      return res.status(400).json({ error: 'Cannot publish a test with no questions. Add at least 1 question.' });
    }

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q.question_text || !q.question_text.trim()) {
        return res.status(400).json({ error: `Cannot publish: Question #${i + 1} has empty question text.` });
      }

      let opts = q.options;
      if (typeof opts === 'string') {
        try {
          opts = JSON.parse(opts);
        } catch (_) {
          opts = [];
        }
      }

      if (!Array.isArray(opts) || opts.length < 2) {
        return res.status(400).json({ error: `Cannot publish: Question #${i + 1} must have at least 2 options.` });
      }

      if (opts.some((opt) => !opt || !String(opt).trim())) {
        return res.status(400).json({ error: `Cannot publish: Question #${i + 1} contains empty options.` });
      }

      const cIdx = Number(q.correct_index);
      if (q.correct_index === null || q.correct_index === undefined || !Number.isInteger(cIdx) || cIdx < 0 || cIdx >= opts.length) {
        return res.status(400).json({ error: `Cannot publish: Question #${i + 1} does not have a valid correct option selected.` });
      }
    }

    await db.execute({
      sql: "UPDATE mcq_tests SET status = 'published' WHERE id = ?",
      args: [testId]
    });

    const link = `${req.protocol}://${req.get('host')}/mcq-test.html?code=${test.code}`;
    return res.json({
      success: true,
      code: test.code,
      link
    });
  } catch (err) {
    console.error('Error publishing MCQ test:', err);
    return res.status(500).json({ error: 'Failed to publish MCQ test.' });
  }
});

// 6. DELETE /api/mcq/:testId - Complete deletion of MCQ test, related rows, and S3 audio
app.delete('/api/mcq/:testId', authenticateToken, requireApprovedUser, async (req, res) => {
  try {
    const testId = parseInt(req.params.testId, 10);
    if (isNaN(testId) || testId <= 0) {
      return res.status(400).json({ error: 'Invalid test ID format.' });
    }

    const testRes = await db.execute({
      sql: 'SELECT id, teacher_id, audio_path FROM mcq_tests WHERE id = ?',
      args: [testId]
    });
    const test = testRes.rows[0];
    if (!test) {
      return res.status(404).json({ error: 'MCQ test not found.' });
    }

    const isElevated = ['root', 'admin'].includes(req.user.role);
    if (Number(test.teacher_id) !== Number(req.user.id) && !isElevated) {
      return res.status(403).json({ error: 'Unauthorized to delete this MCQ test.' });
    }

    // S3 Storage cleanup
    if (test.audio_path) {
      try {
        await deleteAudioFromFilebase(test.audio_path);
      } catch (s3Err) {
        console.warn(`[MCQ Delete] S3 audio cleanup error for ${test.audio_path}:`, s3Err.message);
      }
    }

    // Manual cascade deletion because foreign_keys pragma is OFF
    await db.execute({
      sql: 'DELETE FROM mcq_attempts WHERE test_id = ?',
      args: [testId]
    });

    await db.execute({
      sql: 'DELETE FROM mcq_questions WHERE test_id = ?',
      args: [testId]
    });

    await db.execute({
      sql: 'DELETE FROM mcq_tests WHERE id = ?',
      args: [testId]
    });

    return res.json({
      success: true,
      message: 'MCQ test and all associated submissions deleted successfully.'
    });
  } catch (err) {
    console.error('Error deleting MCQ test:', err);
    return res.status(500).json({ error: 'Failed to delete MCQ test.' });
  }
});

// ----------------- STAGES 3 & 4: PUBLIC STUDENT-FACING MCQ ENDPOINTS -----------------

// 1. GET /api/public/mcq/:code - Public test details with anti-cheat answer stripping
app.get('/api/public/mcq/:code', async (req, res) => {
  try {
    const code = (req.params.code || '').trim();
    if (!code) {
      return res.status(400).json({ error: 'Test code is required.' });
    }

    const testRes = await db.execute({
      sql: `SELECT t.id, t.title, t.teacher_id, t.audio_path, t.deadline, t.status, t.code, t.max_plays, u.name as teacher_name
            FROM mcq_tests t
            LEFT JOIN users u ON t.teacher_id = u.id
            WHERE t.code = ? AND t.status = 'published'`,
      args: [code]
    });

    const test = testRes.rows[0];
    if (!test) {
      return res.status(404).json({ error: 'MCQ test not found or not published.' });
    }

    const isPastDeadline = Boolean(test.deadline && Date.now() > new Date(test.deadline).getTime());

    const qRes = await db.execute({
      sql: `SELECT id, question_text, options, order_index
            FROM mcq_questions
            WHERE test_id = ?
            ORDER BY order_index ASC, id ASC`,
      args: [test.id]
    });

    // CRITICAL: Anti-cheat stripping of correct_index and points
    const questions = qRes.rows.map((q) => {
      let opts = q.options;
      if (typeof opts === 'string') {
        try {
          opts = JSON.parse(opts);
        } catch (_) {
          opts = [];
        }
      }
      return {
        id: q.id,
        question_text: q.question_text,
        options: Array.isArray(opts) ? opts : []
      };
    });

    let audioUrl = null;
    if (test.audio_path) {
      audioUrl = await generateSignedAudioUrl(test.audio_path);
    }

    return res.json({
      success: true,
      test: {
        title: test.title,
        teacher_name: test.teacher_name || 'Teacher',
        deadline: test.deadline,
        isPastDeadline,
        max_plays: test.max_plays || 0
      },
      audioUrl,
      questions
    });
  } catch (err) {
    console.error('Error fetching public MCQ test:', err);
    return res.status(500).json({ error: 'Failed to load MCQ test.' });
  }
});

// 2. GET /api/public/mcq/:code/audio-refresh - Refresh pre-signed URL for prolonged student sessions
app.get('/api/public/mcq/:code/audio-refresh', async (req, res) => {
  try {
    const code = (req.params.code || '').trim();
    if (!code) {
      return res.status(400).json({ error: 'Test code is required.' });
    }

    const testRes = await db.execute({
      sql: "SELECT audio_path FROM mcq_tests WHERE code = ? AND status = 'published'",
      args: [code]
    });

    const test = testRes.rows[0];
    if (!test || !test.audio_path) {
      return res.status(404).json({ error: 'Audio track not found for this test.' });
    }

    const audioUrl = await generateSignedAudioUrl(test.audio_path);
    return res.json({ success: true, audioUrl });
  } catch (err) {
    console.error('Error refreshing audio URL:', err);
    return res.status(500).json({ error: 'Failed to refresh audio stream.' });
  }
});

// 3. GET /api/public/mcq/:code/status - Device duplicate submission check
app.get('/api/public/mcq/:code/status', async (req, res) => {
  try {
    const code = (req.params.code || '').trim();
    const deviceId = (req.query.deviceId || '').toString().trim();

    if (!code) {
      return res.status(400).json({ error: 'Test code is required.' });
    }

    const testRes = await db.execute({
      sql: "SELECT id FROM mcq_tests WHERE code = ? AND status = 'published'",
      args: [code]
    });

    const test = testRes.rows[0];
    if (!test) {
      return res.status(404).json({ error: 'Test not found.' });
    }

    if (!deviceId) {
      return res.json({ success: true, hasSubmitted: false });
    }

    const attemptRes = await db.execute({
      sql: 'SELECT id FROM mcq_attempts WHERE test_id = ? AND device_id = ? LIMIT 1',
      args: [test.id, deviceId]
    });

    return res.json({ success: true, hasSubmitted: attemptRes.rows.length > 0 });
  } catch (err) {
    console.error('Error checking MCQ status:', err);
    return res.status(500).json({ error: 'Failed to check submission status.' });
  }
});

// 4. POST /api/public/mcq/:code/submit - Server-side auto-grading and duplicate audit
app.post(
  '/api/public/mcq/:code/submit',
  rateLimit({ windowMs: 60 * 1000, max: 10 }),
  async (req, res) => {
    try {
      const code = (req.params.code || '').trim();
      const { studentName, deviceId, answers } = req.body;
      const clientIp = getClientIp(req);

      if (!studentName || typeof studentName !== 'string' || !studentName.trim()) {
        return res.status(400).json({ error: 'Please provide your full name before submitting.' });
      }

      const testRes = await db.execute({
        sql: `SELECT t.id, t.title, t.teacher_id, t.deadline, t.status, t.code, u.name as teacher_name
              FROM mcq_tests t
              LEFT JOIN users u ON t.teacher_id = u.id
              WHERE t.code = ? AND t.status = 'published'`,
        args: [code]
      });

      const test = testRes.rows[0];
      if (!test) {
        return res.status(404).json({ error: 'MCQ test not found or submissions are closed.' });
      }

      // Check deadline
      if (test.deadline && Date.now() > new Date(test.deadline).getTime()) {
        return res.status(403).json({ error: 'The submission deadline has passed. Submissions are closed.' });
      }

      const cleanDeviceId = (deviceId || '').toString().trim();
      if (cleanDeviceId) {
        const existingDevice = await db.execute({
          sql: 'SELECT id FROM mcq_attempts WHERE test_id = ? AND device_id = ? LIMIT 1',
          args: [test.id, cleanDeviceId]
        });
        if (existingDevice.rows.length > 0) {
          return res.status(409).json({ error: 'An assessment attempt from this device has already been recorded.' });
        }
      }

      // Server-Side Auto-Grading (Query mcq_questions)
      const qRes = await db.execute({
        sql: 'SELECT id, correct_index, points FROM mcq_questions WHERE test_id = ? ORDER BY order_index ASC, id ASC',
        args: [test.id]
      });

      const questions = qRes.rows;
      let totalScore = 0;
      let earnedScore = 0;
      const cleanAnswers = (answers && typeof answers === 'object') ? answers : {};

      for (const q of questions) {
        const qPoints = Number(q.points) > 0 ? Number(q.points) : 1;
        totalScore += qPoints;

        const studentChoice = cleanAnswers[q.id] !== undefined ? Number(cleanAnswers[q.id]) : -1;
        if (studentChoice === Number(q.correct_index)) {
          earnedScore += qPoints;
        }
      }

      // Format clean score string (e.g., "3/5" or "2.5/5")
      const scoreString = `${earnedScore}/${totalScore}`;

      // Scoped 10-Minute Duplicate Audit
      // Rule 5: WHERE test_id = ? AND ip_address = ? AND submitted_at >= datetime('now', '-10 minutes')
      const dupCheck = await db.execute({
        sql: `SELECT id FROM mcq_attempts 
              WHERE test_id = ? AND ip_address = ? AND submitted_at >= datetime('now', '-10 minutes') 
              LIMIT 1`,
        args: [test.id, clientIp]
      });
      const possibleDuplicate = dupCheck.rows.length > 0 ? 1 : 0;

      // Insert attempt into database
      await db.execute({
        sql: `INSERT INTO mcq_attempts (test_id, student_name, device_id, ip_address, answers, score, possible_duplicate, submitted_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        args: [
          test.id,
          studentName.trim(),
          cleanDeviceId || null,
          clientIp,
          JSON.stringify(cleanAnswers),
          scoreString,
          possibleDuplicate
        ]
      });

      // Insert audit log into central submission_logs
      try {
        await db.execute({
          sql: `INSERT INTO submission_logs (student_name, assignment_code, assignment_title, teacher_name, submitted_at)
                VALUES (?, ?, ?, ?, datetime('now'))`,
          args: [
            studentName.trim(),
            test.code,
            test.title,
            test.teacher_name || 'Teacher'
          ]
        });
      } catch (logErr) {
        console.warn('Central audit log notice for MCQ:', logErr.message);
      }

      return res.json({
        success: true,
        message: 'Assessment completed and submitted!',
        score: scoreString
      });
    } catch (err) {
      console.error('Error submitting MCQ assessment:', err);
      return res.status(500).json({ error: 'Failed to process assessment submission.' });
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
app.get('/mcq-test', (req, res) => res.sendFile(path.join(publicDir, 'mcq-test.html')));
app.get('/mcq-test.html', (req, res) => res.sendFile(path.join(publicDir, 'mcq-test.html')));
app.get('/', authenticateToken, (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get('/index.html', authenticateToken, (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

// 404 Catch-All
app.use((req, res) => {
  const isApi = (req.originalUrl && req.originalUrl.startsWith('/api/')) || req.path.startsWith('/api/');
  if (isApi) {
    return res.status(404).json({ success: false, error: 'API route not found' });
  }
  if (req.accepts('html')) return res.redirect('/login.html');
  return res.status(404).json({ success: false, error: 'Not found' });
});

// Global Error Handler (guarantees unhandled errors on /api/* return JSON)
app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err);
  const isApi = (req.originalUrl && req.originalUrl.startsWith('/api/')) || req.path.startsWith('/api/');
  if (isApi) {
    return res.status(err.status || 500).json({
      success: false,
      error: err.message || 'Internal server error.'
    });
  }
  if (req.accepts('html')) return res.redirect('/login.html');
  return res.status(500).json({ success: false, error: 'Internal server error.' });
});

app.listen(port, () => {
  console.log(`Mimir Marking Server running on port ${port}`);
});