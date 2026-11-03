import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

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

export { port, isProduction, JWT_SECRET, GOOGLE_CLIENT_ID, ROOT_EMAIL, ADMIN_EMAILS, isRootUser, isAdminEmail, isStrongPassword };
