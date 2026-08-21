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
import Database from 'better-sqlite3';
import nodemailer from 'nodemailer';
import { Resend } from 'resend';

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
const JWT_SECRET = process.env.JWT_SECRET || 'halo-book-secret-key-2026-eduplanet';
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

// Password Strength Validator
function isStrongPassword(password) {
  if (!password || password.length < 8) return false;
  const hasNumber = /[0-9]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasSpecial = /[^A-Za-z0-9]/.test(password);
  return hasNumber && hasUpper && hasLower && hasSpecial;
}

// Resend HTTP Client (if configured)
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Gmail SMTP Transporter over SSL (Port 465)
const emailTransporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: (process.env.SMTP_EMAIL || '').trim(),
    pass: (process.env.SMTP_PASSWORD || '').replace(/\s+/g, '')
  },
  tls: {
    rejectUnauthorized: false
  },
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 15000
});

// Initialize SQLite database
const db = new Database('halobook.db');
db.pragma('journal_mode = WAL');

db.exec(`
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

  CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    token TEXT NOT NULL,
    expires_at DATETIME NOT NULL
  );
`);

try { db.exec("ALTER TABLE users ADD COLUMN google_id TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'pending'"); } catch(e) {}
try { db.exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'teacher'"); } catch(e) {}

app.use(cors());
app.use(express.json());
app.use(cookieParser());

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

// Supports multiple rubric sheets and student essays
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function authenticateToken(req, res, next) {
  const token = req.cookies.halo_token || (req.headers['authorization'] && req.headers['authorization'].split(' ')[1]);

  if (!token) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Unauthorized. Please login.' });
    }
    return res.redirect('/login.html');
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      if (req.path.startsWith('/api/')) {
        return res.status(403).json({ error: 'Session expired. Please login again.' });
      }
      return res.redirect('/login.html');
    }

    const dbUser = db.prepare('SELECT id, name, email, status, role FROM users WHERE id = ?').get(decoded.id);
    if (!dbUser) {
      res.clearCookie('halo_token');
      return res.redirect('/login.html');
    }

    if (isRootUser(dbUser.email) && dbUser.role !== 'root') {
      db.prepare("UPDATE users SET role = 'root', status = 'approved' WHERE id = ?").run(dbUser.id);
      dbUser.role = 'root';
      dbUser.status = 'approved';
    } else if (isAdminEmail(dbUser.email) && dbUser.role === 'teacher') {
      db.prepare("UPDATE users SET role = 'admin', status = 'approved' WHERE id = ?").run(dbUser.id);
      dbUser.role = 'admin';
      dbUser.status = 'approved';
    }

    req.user = dbUser;
    next();
  });
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

// Auth Routes
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

    const checkUser = db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail);
    if (checkUser) return res.status(400).json({ error: 'An account with this email already exists.' });

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
    const insert = db.prepare('INSERT INTO users (name, email, password, status, role) VALUES (?, ?, ?, ?, ?)');
    const info = insert.run(name.trim(), cleanEmail, hashedPassword, initialStatus, initialRole);

    const token = jwt.sign(
      { id: info.lastInsertRowid, name: name.trim(), email: cleanEmail, status: initialStatus, role: initialRole },
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

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Please provide email and password.' });

    const cleanEmail = email.toLowerCase().trim();
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail);
    if (!user || !user.password) return res.status(400).json({ error: 'Invalid credentials.' });

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(400).json({ error: 'Invalid credentials.' });

    if (isRootUser(cleanEmail) && user.role !== 'root') {
      db.prepare("UPDATE users SET role = 'root', status = 'approved' WHERE id = ?").run(user.id);
      user.role = 'root';
      user.status = 'approved';
    } else if (isAdminEmail(cleanEmail) && user.role === 'teacher') {
      db.prepare("UPDATE users SET role = 'admin', status = 'approved' WHERE id = ?").run(user.id);
      user.role = 'admin';
      user.status = 'approved';
    }

    const token = jwt.sign(
      { id: user.id, name: user.name, email: user.email, status: user.status, role: user.role },
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

    return res.json({ success: true, user: { name: user.name, email: user.email, status: user.status, role: user.role } });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Server error during login.' });
  }
});

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

    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

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

      const insert = db.prepare('INSERT INTO users (name, email, password, google_id, status, role) VALUES (?, ?, ?, ?, ?, ?)');
      const info = insert.run(name, email, 'GOOGLE_AUTH_ACCOUNT', googleId, initialStatus, initialRole);
      user = { id: info.lastInsertRowid, name, email, status: initialStatus, role: initialRole };
    } else {
      if (isRootUser(email) && user.role !== 'root') {
        db.prepare("UPDATE users SET role = 'root', status = 'approved', google_id = ? WHERE id = ?").run(googleId, user.id);
        user.role = 'root';
        user.status = 'approved';
      } else if (isAdminEmail(email) && user.role === 'teacher') {
        db.prepare("UPDATE users SET role = 'admin', status = 'approved', google_id = ? WHERE id = ?").run(googleId, user.id);
        user.role = 'admin';
        user.status = 'approved';
      } else if (!user.google_id && googleId) {
        db.prepare('UPDATE users SET google_id = ? WHERE id = ?').run(googleId, user.id);
      }
    }

    const token = jwt.sign(
      { id: user.id, name: user.name, email: user.email, status: user.status, role: user.role },
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

// Admin User Management Endpoints
app.get('/api/admin/users', authenticateToken, requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, name, email, status, role, created_at FROM users ORDER BY id DESC').all();
  res.json({ success: true, users });
});

app.post('/api/admin/users/:id/status', authenticateToken, requireAdmin, (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!['approved', 'pending', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });

  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'User not found.' });

  if (target.role === 'root') {
    return res.status(403).json({ error: 'The Root User account status cannot be modified.' });
  }

  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, id);
  res.json({ success: true, message: `Account updated to ${status}.` });
});

app.post('/api/admin/users/:id/role', authenticateToken, requireAdmin, (req, res) => {
  const { id } = req.params;
  const { role } = req.body;

  if (!['admin', 'teacher'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role specified.' });
  }

  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'User not found.' });

  if (target.role === 'root') {
    return res.status(403).json({ error: 'The Root User cannot be demoted.' });
  }

  if (req.user.id === parseInt(id, 10) && role !== 'admin') {
    return res.status(400).json({ error: 'You cannot revoke your own admin rights.' });
  }

  db.prepare("UPDATE users SET role = ?, status = 'approved' WHERE id = ?").run(role, id);
  res.json({ success: true, message: `User role changed to ${role}.` });
});

app.delete('/api/admin/users/:id', authenticateToken, requireAdmin, (req, res) => {
  const { id } = req.params;

  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'User not found.' });

  if (target.role === 'root') {
    return res.status(403).json({ error: 'The Root User account cannot be deleted.' });
  }

  if (req.user.id === parseInt(id, 10)) {
    return res.status(400).json({ error: 'You cannot delete your own active account.' });
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ success: true, message: 'Account deleted successfully.' });
});

// Password Reset Endpoint with Resend / Gmail & Direct UI Fallback
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Please enter your email address.' });

    const cleanEmail = email.toLowerCase().trim();
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail);
    if (!user) return res.status(404).json({ error: 'No account found with this email address.' });

    const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    db.prepare('DELETE FROM password_resets WHERE email = ?').run(cleanEmail);
    db.prepare('INSERT INTO password_resets (email, token, expires_at) VALUES (?, ?, ?)').run(
      cleanEmail,
      resetCode,
      expiresAt
    );

    console.log(`\n========================================`);
    console.log(`🔑 PASSWORD RESET CODE for [${cleanEmail}]: ${resetCode}`);
    console.log(`========================================\n`);

    let delivered = false;

    // 1. Try Resend if configured
    if (resend) {
      try {
        const response = await resend.emails.send({
          from: 'Halo Book <onboarding@resend.dev>',
          to: cleanEmail,
          subject: 'Halo Book — Your Password Reset Code',
          html: `<p>Your password reset code is: <b>${resetCode}</b> (expires in 15 mins)</p>`
        });
        if (response && response.data && response.data.id) {
          delivered = true;
        }
      } catch (e) {
        console.warn('Resend send failed (expected on testing domain for external emails):', e.message);
      }
    }

    // 2. Try Gmail SMTP if Resend didn't deliver
    if (!delivered && process.env.SMTP_EMAIL && process.env.SMTP_PASSWORD) {
      try {
        await Promise.race([
          emailTransporter.sendMail({
            from: `"Halo Book" <${process.env.SMTP_EMAIL.trim()}>`,
            to: cleanEmail,
            subject: 'Halo Book — Your Password Reset Code',
            text: `Your password reset code is: ${resetCode}`
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('SMTP Timeout')), 5000))
        ]);
        delivered = true;
      } catch (e) {
        console.warn('SMTP delivery failed / timed out:', e.message);
      }
    }

    return res.json({ 
      success: true, 
      delivered,
      devCode: resetCode,
      message: delivered 
        ? 'A 6-digit verification code has been dispatched to your email.' 
        : `Email delivery unavailable. Your verification code is: ${resetCode}`
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    return res.status(500).json({ error: error.message || 'Failed to request reset.' });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) return res.status(400).json({ error: 'Missing required fields.' });

    if (!isStrongPassword(newPassword)) {
      return res.status(400).json({ 
        error: 'New password must be at least 8 characters and include uppercase, lowercase, a number, and a special character.' 
      });
    }

    const record = db.prepare('SELECT * FROM password_resets WHERE email = ? AND token = ?').get(
      email.toLowerCase().trim(),
      code.trim()
    );

    if (!record || new Date(record.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Invalid or expired verification code.' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    db.prepare('UPDATE users SET password = ? WHERE email = ?').run(hashedPassword, email.toLowerCase().trim());
    db.prepare('DELETE FROM password_resets WHERE email = ?').run(email.toLowerCase().trim());

    return res.json({ success: true, message: 'Password reset successfully. You can now login.' });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to reset password.' });
  }
});

app.get('/api/auth/me', authenticateToken, (req, res) => {
  res.json({ success: true, user: req.user });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('halo_token');
  res.json({ success: true, message: 'Logged out successfully.' });
});

// Static files and Page Routes
const publicDir = path.resolve(__dirname, 'public');
app.use(express.static(publicDir));

app.get('/login', (req, res) => {
  res.sendFile(path.join(publicDir, 'login.html'));
});

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(publicDir, 'login.html'));
});

app.get('/', authenticateToken, (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.get('/index.html', authenticateToken, (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
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

// AI Batch Marking Route
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
      for (const sFile of schemeFiles) {
        if (!isImage(sFile) && !isPdf(sFile)) {
          const txt = await extractText(sFile);
          if (txt.trim()) {
            allSchemeText += `\n[Rubric File: ${sFile.originalname}]\n${txt}\n`;
          }
        }
      }

      const results = [];
      let fileCursor = 0;

      for (let sIdx = 0; sIdx < submissionsMeta.length; sIdx++) {
        const sub = submissionsMeta[sIdx];
        const pageCount = sub.fileCount || 1;
        const studentFiles = allUploadedFiles.slice(fileCursor, fileCursor + pageCount);
        fileCursor += pageCount;

        if (studentFiles.length === 0) continue;

        const assignedStudentName = sub.name || `Student ${sIdx + 1}`;
        const inputPayload = [];

        for (let rIdx = 0; rIdx < schemeFiles.length; rIdx++) {
          const sFile = schemeFiles[rIdx];
          if (isImage(sFile)) {
            let mimeType = sFile.mimetype || 'image/png';
            if (!mimeType.startsWith('image/')) mimeType = 'image/png';
            inputPayload.push({
              type: 'image',
              mime_type: mimeType,
              data: sFile.buffer.toString('base64')
            });
          } else if (isPdf(sFile)) {
            inputPayload.push({
              type: 'document',
              mime_type: 'application/pdf',
              data: sFile.buffer.toString('base64')
            });
          }
        }

        let promptText = `You are a strict, high-precision exam evaluator reviewing a student's test sheet / essay.

IMPORTANT MULTI-PAGE & RUBRIC INSTRUCTIONS:
- The marking scheme / rubric is provided across ${schemeFiles.length} file(s)/image(s) and any extra criteria notes attached. Read all rubric pages completely.
- This student submission consists of ${studentFiles.length} page(s)/image(s). Evaluate ALL attached pages as a single unified exam work.
- Extract the student's handwritten or printed name from the header/page. If none is clearly written, fallback to: "${assignedStudentName}".

CRITICAL FORMATTING RULES:
- EVERY item in 'category_breakdown', 'mistakes', and 'weaknesses' MUST be on a NEW LINE starting with a hyphen '-'. Do NOT group multiple items into a single paragraph!
- Calculate scores category by category across all submitted pages (e.g. - Section 1: 6/10\\n- Section 2: 9/10).
- Compute total_score as the sum of all sections across all pages (e.g. 31/40).
- Use simple, student-friendly English. Be direct and avoid polite filler.

Respond ONLY with valid JSON matching this schema:
{
  "student_name": "Extracted student name",
  "total_score": "31/40",
  "category_breakdown": "- Section 1 (Choose the correct answer): 6/10\\n- Section 2 (Complete the sentences): 9/10\\n- Section 3 (Find mistake): 9/10\\n- Section 4 (Sentence Fragments): 7/10",
  "mistakes": "- Section 1, Item 1: Selected 'c' instead of 'b'\\n- Section 1, Item 3: Selected 'a' instead of 'b'\\n- Section 2, Item 8: Wrote 'hunted' instead of 'born'",
  "weaknesses": "- Practice identifying sentence fragments\\n- Review vocabulary on animal habitats\\n- Practice past tense verb rules"
}`;

        if (allSchemeText.trim()) {
          promptText += `\n\nMARKING SCHEME FILE CONTENT:\n${allSchemeText}`;
        }
        if (extraNotes.trim()) {
          promptText += `\n\nTEACHER EXTRA NOTES & CRITERIA:\n${extraNotes}`;
        }

        for (let p = 0; p < studentFiles.length; p++) {
          const file = studentFiles[p];
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

        promptText += `\n\nSTUDENT ESSAY: Attached above are ${studentFiles.length} file(s)/page(s) representing this student's full submission.`;
        inputPayload.push({ type: 'text', text: promptText });

        const interaction = await ai.interactions.create({
          model: 'gemini-3.1-flash-lite',
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

        let parsedFeedback;
        try {
          parsedFeedback = JSON.parse(interaction.output_text);
        } catch (err) {
          parsedFeedback = {
            student_name: assignedStudentName,
            total_score: '—',
            category_breakdown: 'Failed to generate category breakdown.',
            mistakes: 'Failed to extract specific mistakes.',
            weaknesses: 'Failed to extract weaknesses.'
          };
        }

        const finalStudentName = (parsedFeedback.student_name && parsedFeedback.student_name.trim()) 
          ? parsedFeedback.student_name.trim() 
          : assignedStudentName;

        results.push({
          pageCount: studentFiles.length,
          name: finalStudentName,
          score: parsedFeedback.total_score,
          ...parsedFeedback
        });

        if (sIdx < submissionsMeta.length - 1) {
          await delay(2000);
        }
      }

      return res.json({ success: true, count: results.length, data: results });
    } catch (error) {
      console.error('Server Processing Error:', error);
      return res.status(500).json({ error: error.message || 'Internal server error processing documents.' });
    }
  }
);

// Fallback route
app.use((req, res) => {
  if (req.accepts('html')) {
    res.redirect('/login.html');
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

app.listen(port, () => {
  console.log(`Halo Book Server running on port ${port}`);
});