import express from 'express';
import cors from 'cors';
import path from 'path';
import cookieParser from 'cookie-parser';
import { __dirname } from './paths.js';
import { authenticateToken } from './middleware/auth.js';
import { registerAdminRoutes } from './modules/admin/admin.routes.js';
import { registerAssignmentRoutes } from './modules/assignments/assignments.routes.js';
import { registerAuthRoutes, registerAuthSessionRoutes } from './modules/auth/auth.routes.js';
import { registerMcqRoutes } from './modules/listening-tests/mcq.routes.js';
import { registerOnlineTestRoutes } from './modules/online-tests/online-tests.routes.js';
import { registerSubmissionRoutes } from './modules/submissions/submissions.routes.js';

const app = express();
app.set('trust proxy', 1);

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cookieParser());

// Strict dotfile and sensitive environment file protection
app.use((req, res, next) => {
  const reqPath = (req.path || '').toLowerCase();
  if (reqPath.startsWith('/.') || reqPath.includes('/.env') || reqPath.endsWith('.env') || reqPath.includes('mimirmarking.db')) {
    return res.status(403).json({ error: 'Access denied: protected system resource.' });
  }
  next();
});

// ----------------- FEATURE ROUTES (registered in original order) -----------------
registerAuthRoutes(app);
registerAdminRoutes(app);
registerAuthSessionRoutes(app);
registerAssignmentRoutes(app);
registerSubmissionRoutes(app);
registerMcqRoutes(app);
registerOnlineTestRoutes(app);


// Static assets
const publicDir = path.resolve(__dirname, 'public');
app.use(express.static(publicDir));

app.get('/login', (req, res) => res.sendFile(path.join(publicDir, 'login.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(publicDir, 'login.html')));
app.get('/submit', (req, res) => res.sendFile(path.join(publicDir, 'submit.html')));
app.get('/submit.html', (req, res) => res.sendFile(path.join(publicDir, 'submit.html')));
app.get('/mcq-test', (req, res) => res.sendFile(path.join(publicDir, 'mcq-test.html')));
app.get('/mcq-test.html', (req, res) => res.sendFile(path.join(publicDir, 'mcq-test.html')));
app.get('/online-test', (req, res) => res.sendFile(path.join(publicDir, 'online-test.html')));
app.get('/online-test.html', (req, res) => res.sendFile(path.join(publicDir, 'online-test.html')));
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

export { app, publicDir };
