import crypto from 'crypto';
import { db } from '../../db/client.js';
import { deleteStorageFiles } from '../../integrations/storage.js';
import { isInvalidOrCollidedDeviceId } from '../../lib/deviceId.js';
import { isImage, isPdf } from '../../lib/fileTypes.js';
import { extractText } from '../../lib/text.js';
import { authenticateToken, requireApprovedUser } from '../../middleware/auth.js';
import { upload } from '../../middleware/uploads.js';

export function registerAssignmentRoutes(app) {

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
      sql: 'SELECT id, title, deadline, bundle_code FROM assignments WHERE code = ?' + (isElevated ? '' : ' AND teacher_id = ?'),
      args: isElevated ? [code] : [code, req.user.id]
    });

    const assignment = assignResult.rows[0];
    if (!assignment) return res.status(404).json({ error: 'Assignment not found.' });

    const subsResult = await db.execute({
      sql: `SELECT id, student_name as name, student_name, teacher_name, device_id, page_count as pageCount, total_score, 
            category_breakdown, mistakes, weaknesses, similarity_score, similarity_details, ai_score, ai_details, web_score, 
            possible_duplicate, ip_address, created_at 
            FROM submissions WHERE assignment_id = ? ORDER BY id ASC`,
      args: [assignment.id]
    });

    const submissions = subsResult.rows || [];

    // If this assignment is part of a multi-task bundle, compute advisory completeness per submission
    if (assignment.bundle_code) {
      const bundleTasksResult = await db.execute({
        sql: 'SELECT id, code, title FROM assignments WHERE bundle_code = ? ORDER BY id ASC',
        args: [assignment.bundle_code]
      });
      const bundleTasks = bundleTasksResult.rows || [];

      if (bundleTasks.length > 1) {
        const bundleSubsResult = await db.execute({
          sql: `SELECT s.id, s.assignment_id, s.student_name, s.device_id, a.title as task_title
                FROM submissions s
                JOIN assignments a ON s.assignment_id = a.id
                WHERE a.bundle_code = ?`,
          args: [assignment.bundle_code]
        });
        const allBundleSubs = bundleSubsResult.rows || [];

        for (const sub of submissions) {
          const devId = (sub.device_id || '').trim();
          const studentNameClean = (sub.student_name || '').trim().toLowerCase();

          let submittedTaskIds = new Set();
          if (devId && !isInvalidOrCollidedDeviceId(devId)) {
            // Match on device_id first (handles typos, device-based tracking)
            allBundleSubs
              .filter(s => s.device_id && s.device_id.trim() === devId)
              .forEach(s => submittedTaskIds.add(s.assignment_id));
          } else if (studentNameClean) {
            // Fallback to normalized student name
            allBundleSubs
              .filter(s => (s.student_name || '').trim().toLowerCase() === studentNameClean)
              .forEach(s => submittedTaskIds.add(s.assignment_id));
          }

          // Always ensure the current task is marked submitted for this record
          submittedTaskIds.add(assignment.id);

          const missingTasks = bundleTasks.filter(t => !submittedTaskIds.has(t.id));
          if (missingTasks.length > 0) {
            sub.missing_tasks = missingTasks.map(t => t.title);
            sub.bundle_missing_label = `Incomplete: missing ${missingTasks.map(t => t.title).join(', ')}`;
            sub.is_incomplete_bundle = true;
          } else {
            sub.missing_tasks = [];
            sub.bundle_missing_label = null;
            sub.is_incomplete_bundle = false;
          }
        }
      }
    }

    res.json({
      success: true,
      assignment,
      submissions
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
      try {
        const assignRow = await db.execute({
          sql: 'SELECT scheme_files_json FROM assignments WHERE id = ?',
          args: [id]
        });
        if (assignRow.rows.length > 0 && assignRow.rows[0].scheme_files_json) {
          let sFiles = [];
          try { sFiles = JSON.parse(assignRow.rows[0].scheme_files_json); } catch (_) {}
          const filesToPrune = [];
          for (const f of (Array.isArray(sFiles) ? sFiles : [])) {
            if (typeof f === 'string') filesToPrune.push(f);
            else if (f && typeof f === 'object') {
              if (f.url) filesToPrune.push(f.url);
              if (f.object_key) filesToPrune.push(f.object_key);
              if (f.key) filesToPrune.push(f.key);
            }
          }
          if (filesToPrune.length > 0) {
            await deleteStorageFiles(filesToPrune);
          }
        }
      } catch (fErr) {
        console.warn('[Assignment Delete Files Warning]:', fErr.message);
      }
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
    const deviceId = (req.query.deviceId || '').toString().trim();

    if (!code) {
      return res.status(400).json({ error: 'Assignment code is required.' });
    }

    // A blank, missing, short (< 35 chars), un-hyphenated, or legacy-collided deviceId must never match a lock
    if (isInvalidOrCollidedDeviceId(deviceId)) {
      return res.json({ success: true, hasSubmitted: false });
    }

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
      args: [assignmentId, deviceId]
    });

    return res.json({ success: true, hasSubmitted: subCheck.rows.length > 0 });
  } catch (err) {
    return res.status(500).json({ error: 'Status check failed.' });
  }
});
}
