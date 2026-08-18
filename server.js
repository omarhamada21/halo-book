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

// Root & Admin Emails Configuration
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

// Password Strength Validator: Min 8 chars, 1 uppercase, 1 lowercase, 1 number, 1 symbol
function isStrongPassword(password) {
  if (!password || password.length < 8) return false;
  const hasNumber = /[0-9]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasSpecial = /[^A-Za-z0-9]/.test(password);
  return hasNumber && hasUpper && hasLower && hasSpecial;
}

// Setup Nodemailer with Gmail SMTP + timeout handling
const emailTransporter = nodemailer.createTransport({
  service: 'gmail',
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.SMTP_EMAIL || '',
    pass: (process.env.SMTP_PASSWORD || '').replace(/\s+/g, '')
  },
  connectionTimeout: 8000,
  greetingTimeout: 8000,
  socketTimeout: 10000
});

if (process.env.SMTP_EMAIL && process.env.SMTP_PASSWORD) {
  emailTransporter.verify((error) => {
    if (error) {
      console.error('❌ Email Server Connection Error:', error.message);
    } else {
      console.log('✅ Email Server is ready.');
    }
  });
}

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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
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

// Register Endpoint
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

// Login Endpoint
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

// Google Auth Endpoint (with placeholder password to satisfy NOT NULL constraints)
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
      console.error('Failed to parse Google token:', parseErr);
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

    console.log(`✅ Google Sign-In Successful: ${email} (${user.role})`);
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

// Password Reset Endpoint with Non-Freezing Timeout Safety
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

    let emailSent = false;
    if (process.env.SMTP_EMAIL && process.env.SMTP_PASSWORD) {
      try {
        const sendPromise = emailTransporter.sendMail({
          from: `"Halo Book" <${process.env.SMTP_EMAIL}>`,
          to: cleanEmail,
          subject: 'Halo Book — Your Password Reset Code',
          text: `Your password reset code is: ${resetCode}\nThis code expires in 15 minutes.`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; border: 1px solid #C2CEE7; border-radius: 8px; background: #FBFCFE;">
              <h2 style="color: #1D3A66; margin-top: 0;">Halo Book</h2>
              <p style="color: #4A5670; font-size: 15px;">Use the verification code below to reset your password:</p>
              <div style="background: #DDE3EE; color: #16233F; font-size: 28px; font-weight: bold; letter-spacing: 6px; text-align: center; padding: 14px; border-radius: 6px; margin: 20px 0;">
                ${resetCode}
              </div>
              <p style="color: #888; font-size: 12px; margin-bottom: 0;">This code expires in 15 minutes.</p>
            </div>
          `
        });

        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('SMTP timeout')), 6000)
        );

        await Promise.race([sendPromise, timeoutPromise]);
        emailSent = true;
        console.log(`✉️ Email successfully dispatched to ${cleanEmail}`);
      } catch (mailErr) {
        console.error('⚠️ Nodemailer delivery issue:', mailErr.message);
      }
    }

    return res.json({ 
      success: true, 
      emailSent,
      message: emailSent 
        ? 'Verification code sent to your email inbox!' 
        : 'Reset code generated. Please enter your code.'
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
    { name: 'scheme', maxCount: 1 },
    { name: 'essays', maxCount: 30 }
  ]),
  async (req, res) => {
    try {
      const schemeFile = req.files && req.files['scheme'] ? req.files['scheme'][0] : null;
      let extraNotes = req.body.schemeText || '';
      let fileSchemeText = '';

      if (schemeFile) {
        fileSchemeText = await extractText(schemeFile);
      }

      if (!fileSchemeText.trim() && !extraNotes.trim() && !schemeFile) {
        return res.status(400).json({ error: 'Please provide a valid marking scheme file or text notes.' });
      }

      const essayFiles = (req.files && req.files['essays']) || [];
      if (essayFiles.length === 0) {
        return res.status(400).json({ error: 'No essay files uploaded.' });
      }

      const results = [];

      for (let i = 0; i < essayFiles.length; i++) {
        const file = essayFiles[i];

        const fallbackName = file.originalname
          .replace(/\.[^/.]+$/, '')
          .replace(/[_-]+/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase());

        const inputPayload = [];

        if (schemeFile) {
          if (isImage(schemeFile)) {
            let mimeType = schemeFile.mimetype || 'image/png';
            if (!mimeType.startsWith('image/')) mimeType = 'image/png';
            inputPayload.push({
              type: 'image',
              mime_type: mimeType,
              data: schemeFile.buffer.toString('base64')
            });
          } else if (isPdf(schemeFile)) {
            inputPayload.push({
              type: 'document',
              mime_type: 'application/pdf',
              data: schemeFile.buffer.toString('base64')
            });
          }
        }

        let promptText = `You are a strict, high-precision exam evaluator reviewing a student's test sheet.

IMPORTANT NAME EXTRACTION INSTRUCTION:
- Extract the student's handwritten or printed name from the top header. If none found, fallback to: "${fallbackName}".

CRITICAL FORMATTING RULES:
- EVERY item in 'category_breakdown', 'mistakes', and 'weaknesses' MUST be on a NEW LINE starting with a hyphen '-'. Do NOT group multiple items into a single paragraph!
- Calculate scores category by category (e.g. - Section 1: 6/10\\n- Section 2: 9/10).
- Compute total_score as the sum of all sections (e.g. 31/40).
- Use simple, student-friendly English. Be direct and avoid polite filler.

Respond ONLY with valid JSON matching this schema:
{
  "student_name": "Extracted student name",
  "total_score": "31/40",
  "category_breakdown": "- Section 1 (Choose the correct answer): 6/10\\n- Section 2 (Complete the sentences): 9/10\\n- Section 3 (Find mistake): 9/10\\n- Section 4 (Sentence Fragments): 7/10",
  "mistakes": "- Section 1, Item 1: Selected 'c' instead of 'b'\\n- Section 1, Item 3: Selected 'a' instead of 'b'\\n- Section 2, Item 8: Wrote 'hunted' instead of 'born'",
  "weaknesses": "- Practice identifying sentence fragments\\n- Review vocabulary on animal habitats\\n- Practice past tense verb rules"
}`;

        if (fileSchemeText.trim()) {
          promptText += `\n\nMARKING SCHEME FILE CONTENT:\n${fileSchemeText}`;
        } else if (schemeFile) {
          promptText += `\n\nMARKING SCHEME FILE: Refer to the rubric document or image attached above.`;
        }

        if (extraNotes.trim()) {
          promptText += `\n\nTEACHER EXTRA NOTES & INSTRUCTIONS:\n${extraNotes}`;
        }

        if (isImage(file)) {
          let mimeType = file.mimetype || 'image/png';
          if (!mimeType.startsWith('image/')) mimeType = 'image/png';
          inputPayload.push({
            type: 'image',
            mime_type: mimeType,
            data: file.buffer.toString('base64')
          });
          promptText += `\n\nSTUDENT ESSAY: Read handwritten/printed text from image and extract student name.`;
        } else if (isPdf(file)) {
          inputPayload.push({
            type: 'document',
            mime_type: 'application/pdf',
            data: file.buffer.toString('base64')
          });
          promptText += `\n\nSTUDENT ESSAY: Read essay in PDF and extract student name.`;
        } else {
          const essayText = await extractText(file);
          promptText += `\n\nSTUDENT ESSAY:\n${essayText}`;
        }

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
            student_name: fallbackName,
            total_score: '—',
            category_breakdown: 'Failed to generate category breakdown.',
            mistakes: 'Failed to extract specific mistakes.',
            weaknesses: 'Failed to extract weaknesses.'
          };
        }

        const finalStudentName = (parsedFeedback.student_name && parsedFeedback.student_name.trim()) 
          ? parsedFeedback.student_name.trim() 
          : fallbackName;

        results.push({
          filename: file.originalname,
          name: finalStudentName,
          score: parsedFeedback.total_score,
          ...parsedFeedback
        });

        if (i < essayFiles.length - 1) {
          await delay(2500);
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