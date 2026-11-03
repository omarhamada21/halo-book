import { createClient } from '@libsql/client';
import '../config/env.js';

// Database Initialization
const tursoUrl = process.env.TURSO_DATABASE_URL || 'file:mimirmarking.db';
const tursoAuthToken = process.env.TURSO_AUTH_TOKEN || '';

const db = createClient({
  url: tursoUrl,
  authToken: tursoAuthToken
});

export { tursoUrl, tursoAuthToken, db };
