import bcrypt from 'bcryptjs';
import { isStrongPassword } from '../../config/env.js';
import { db } from '../../db/client.js';
import { authenticateToken, requireAdmin } from '../../middleware/auth.js';

export function registerAdminRoutes(app) {

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
}
