import { db } from '../db/client.js';

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

export { cleanExpiredAssignments };
