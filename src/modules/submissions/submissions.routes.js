import { db } from '../../db/client.js';
import { callGemini } from '../../integrations/gemini.js';
import { isInvalidOrCollidedDeviceId } from '../../lib/deviceId.js';
import { isImage, isPdf } from '../../lib/fileTypes.js';
import { extractText, calculateTextSimilarity } from '../../lib/text.js';
import { authenticateToken, requireApprovedUser } from '../../middleware/auth.js';
import { getClientIp, rateLimit } from '../../middleware/rateLimit.js';
import { upload } from '../../middleware/uploads.js';

export function registerSubmissionRoutes(app) {

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

      if (deviceIdInput && !isInvalidOrCollidedDeviceId(deviceIdInput)) {
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

      // NOTE: Do NOT add a "check all bundle tasks" server rule: single-task requests are valid by design (e.g. retrying a single failed task in a bundle, or submitting individual tasks).
      const files = (req.files && req.files['pages']) || [];
      if (!files.length) {
        return res.status(400).json({
          success: false,
          code: 'EMPTY_UPLOAD',
          error: 'Please upload at least one photo or document of your work.'
        });
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
}
