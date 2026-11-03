import { db } from '../../db/client.js';
import { ai, callGemini } from '../../integrations/gemini.js';
import { getMissingFilebaseEnvVars, uploadAudioToFilebase, generateSignedAudioUrl, generateSignedImageUrl, deleteStorageFiles, deleteAudioFromFilebase } from '../../integrations/storage.js';
import { isInvalidOrCollidedDeviceId } from '../../lib/deviceId.js';
import { isImage, isPdf } from '../../lib/fileTypes.js';
import { extractText } from '../../lib/text.js';
import { authenticateToken, requireApprovedUser } from '../../middleware/auth.js';
import { getClientIp, rateLimit } from '../../middleware/rateLimit.js';
import { mcqUpload } from '../../middleware/uploads.js';
import { transcribeListeningAudio, generateUniqueMcqCode } from './mcq.helpers.js';

export function registerMcqRoutes(app) {

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
      let audioTranscript = null;

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

        // Dedicated Universal Audio Transcriber via Gemini Files API
        try {
          audioTranscript = await transcribeListeningAudio(audioFile.buffer, audioFile.originalname, audioFile.mimetype);
          if (audioTranscript) {
            console.log(`[Universal Transcriber] Transcribed ${audioFile.originalname} (${audioTranscript.length} chars)`);
          }
        } catch (tErr) {
          console.warn('[Universal Transcriber Notice]: Failed to transcribe listening audio:', tErr.message);
        }
      }

      // Automatic visual option cropping decommissioned: picture choices are extracted as descriptive text captions.

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

      if (audioTranscript) {
        markingSchemePromptAddon += `\n\nVERBATIM AUDIO TRANSCRIPT (EXAM LISTENING PASSAGE):\n${audioTranscript}`;
      }

      // 3. Prompt instructing Gemini to convert PDF questions into native exam formats
      const promptText = `You are an expert assessment converter for English exams (Cambridge, IELTS, GCSE).
You are provided with an examination/test PDF document and its official marking scheme / answer key.
Analyze the Test Paper and Marking Scheme. You MUST extract ALL 25 questions across all 5 parts of the exam paper sequentially (Part 1: Questions 1 to 5, Part 2: Questions 6 to 10, Part 3: Questions 11 to 15, Part 4: Questions 16 to 20, Part 5: Questions 21 to 25).
Output a single JSON array with exactly 25 question objects. Do NOT stop after Question 1. Do NOT omit any questions.

Extract each question into one of three question_type formats:

1. 'mcq': Standard multiple-choice questions with 3-5 options.
   - "question_type": "mcq"
   - "question": Clear question prompt text
   - "options": Array of 3-5 plausible option strings. For picture/illustration choice questions (e.g. Cambridge Listening Part 1 showing pictures A, B, C), provide concise descriptive captions of each illustration as the option text (e.g. ["Inside a sports bag", "Under a table", "On a bed"]). Do NOT set has_visual_options to true or invent image URLs.
   - "correct_index": Zero-based integer (0 to options.length - 1) indicating the correct option
   - "acceptable_answers": []
   - "points": Marks/points awarded (default 1)

2. 'matching': Matching tasks (e.g., Speakers 1 to 5 matching Statements A to H).
   - "question_type": "matching"
   - "question": Speaker or item prompt (e.g. "Speaker 1")
   - "options": Array of the available statements (e.g. ["Statement A: ...", "Statement B: ...", ...])
   - "correct_index": Zero-based integer indicating which statement matches this prompt
   - "acceptable_answers": []
   - "points": Marks/points awarded (default 1)

3. 'fill_blank': Note, sentence, or summary completion where students write short answers.
   - "question_type": "fill_blank"
   - "question": The sentence or context with the blank indicated (e.g. "Lara spent (11) [blank] days in Zambia.")
   - "options": []
   - "correct_index": 0
   - "acceptable_answers": Array of valid strings accepted by the mark scheme (e.g. ["14", "fourteen"])
   - "points": Marks/points awarded (default 1)

CRITICAL INSTRUCTIONS:
1. Maintain the natural sequence of all 25 questions as presented in the test PDF.
2. Return ONLY a valid JSON array matching the schema:
   [
     {
       "question_type": "mcq" | "matching" | "fill_blank",
       "question": "string",
       "options": ["string", ...],
       "correct_index": 0,
       "acceptable_answers": ["string", ...],
       "points": 1
     }
   ]
${markingSchemePromptAddon}`;

      inputPayload.push(promptText);

      // Define Gemini JSON Array Schema with maxOutputTokens 8192
      const mcqConfig = {
        responseMimeType: 'application/json',
        maxOutputTokens: 8192,
        responseSchema: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              question_type: { type: 'STRING', enum: ['mcq', 'matching', 'fill_blank'] },
              question: { type: 'STRING' },
              options: {
                type: 'ARRAY',
                items: { type: 'STRING' }
              },
              correct_index: { type: 'INTEGER' },
              acceptable_answers: {
                type: 'ARRAY',
                items: { type: 'STRING' }
              },
              points: { type: 'NUMBER' }
            },
            required: ['question_type', 'question', 'points']
          }
        }
      };

      let rawOutput;
      try {
        rawOutput = await callGemini(inputPayload, mcqConfig);
      } catch (aiErr) {
        if (uploadedAudioKey) {
          try { await deleteAudioFromFilebase(uploadedAudioKey); } catch (_) { }
        }
        console.error('Gemini MCQ generation call error:', aiErr);
        return res.status(502).json({ success: false, error: `AI question generation failed: ${aiErr.message || 'Gemini service error.'}` });
      }

      // Parse and Validate JSON with Resilient Repair
      let parsedQuestions = null;
      try {
        let cleanText = (rawOutput || '').trim();
        if (cleanText.startsWith('```')) {
          cleanText = cleanText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        }
        try {
          parsedQuestions = JSON.parse(cleanText);
        } catch (initialParseErr) {
          // Attempt resilient repair of truncated JSON array
          let repairedText = cleanText;
          const lastCurly = repairedText.lastIndexOf('}');
          if (lastCurly > 0) {
            repairedText = repairedText.slice(0, lastCurly + 1).trim() + '\n]';
            parsedQuestions = JSON.parse(repairedText);
            console.log('[MCQ Generation] Resilient JSON repair succeeded on truncated array.');
          } else {
            throw initialParseErr;
          }
        }
        if (parsedQuestions && !Array.isArray(parsedQuestions) && Array.isArray(parsedQuestions.questions)) {
          parsedQuestions = parsedQuestions.questions;
        }
      } catch (parseErr) {
        if (uploadedAudioKey) {
          try { await deleteAudioFromFilebase(uploadedAudioKey); } catch (_) { }
        }
        console.error('MCQ JSON parse error:', parseErr, 'Raw output:', rawOutput);
        return res.status(422).json({ success: false, error: 'Failed to parse AI output into valid JSON questions.' });
      }

      if (!Array.isArray(parsedQuestions) || parsedQuestions.length === 0) {
        if (uploadedAudioKey) {
          try { await deleteAudioFromFilebase(uploadedAudioKey); } catch (_) { }
        }
        return res.status(422).json({ success: false, error: 'AI returned an empty or invalid question set. Expected a non-empty array of questions.' });
      }

      const validatedQuestions = [];
      for (let i = 0; i < parsedQuestions.length; i++) {
        const item = parsedQuestions[i];
        if (!item || typeof item !== 'object') continue;

        const qPrompt = typeof item.question === 'string' && item.question.trim() ? item.question.trim() : `Question ${i + 1}`;
        const qType = ['mcq', 'matching', 'fill_blank'].includes(item.question_type) ? item.question_type : 'mcq';
        let cleanOptions = [];
        let correctIdx = 0;
        let cleanAcceptable = [];

        if (qType === 'fill_blank') {
          cleanOptions = [];
          if (Array.isArray(item.acceptable_answers)) {
            cleanAcceptable = item.acceptable_answers.map((a) => String(a).trim()).filter(Boolean);
          }
          if (cleanAcceptable.length === 0 && item.correct_answer) {
            cleanAcceptable = [String(item.correct_answer).trim()];
          }
          correctIdx = 0;
        } else if (qType === 'matching') {
          const rawOpts = Array.isArray(item.options) ? item.options : [];
          cleanOptions = rawOpts.map((opt, oIdx) => {
            const label = (typeof opt === 'object' && opt?.label) ? String(opt.label).trim().toUpperCase() : String.fromCharCode(65 + oIdx);
            const textVal = typeof opt === 'string' ? opt : (opt?.text || opt?.statement || opt?.value || opt?.caption || '');
            return {
              label,
              text: String(textVal || '').trim()
            };
          }).filter(o => Boolean(o.text));
          if (cleanOptions.length === 0) {
            cleanOptions = [{ label: 'A', text: 'Statement A' }, { label: 'B', text: 'Statement B' }];
          }
          const rawIdx = Number(item.correct_index);
          correctIdx = Number.isInteger(rawIdx) && rawIdx >= 0 && rawIdx < cleanOptions.length ? rawIdx : 0;
        } else {
          // 'mcq'
          const rawOpts = Array.isArray(item.options) ? item.options : [];
          cleanOptions = rawOpts.map((opt) => {
            if (typeof opt === 'object' && opt !== null) {
              return String(opt.caption || opt.value || opt.text || '').trim();
            }
            return String(opt || '').trim();
          }).filter(Boolean);

          cleanOptions = cleanOptions.map(opt => opt.replace(/^[A-E][.:]\s*/i, '').trim());

          if (cleanOptions.length < 2) {
            cleanOptions = ['Option A', 'Option B', 'Option C'];
          }

          const rawIdx = Number(item.correct_index);
          correctIdx = Number.isInteger(rawIdx) && rawIdx >= 0 && rawIdx < cleanOptions.length ? rawIdx : 0;
        }

        const rawPoints = Number(item.points);
        const points = !isNaN(rawPoints) && rawPoints > 0 ? rawPoints : 1;

        validatedQuestions.push({
          question_type: qType,
          question: qPrompt,
          options: cleanOptions,
          correct_index: correctIdx,
          acceptable_answers: cleanAcceptable,
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
            sql: `INSERT INTO mcq_tests (teacher_id, title, audio_path, transcript, deadline, status, code, max_plays)
                  VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)`,
            args: [req.user.id, title.trim(), audioPath, audioTranscript, deadlineVal, testCode, maxPlays]
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
          sql: `INSERT INTO mcq_questions (test_id, question_type, question_text, options, correct_index, acceptable_answers, points, order_index)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [testId, q.question_type, q.question, JSON.stringify(q.options), q.correct_index, JSON.stringify(q.acceptable_answers), q.points, i]
        });

        insertedQuestions.push({
          id: Number(qInsert.lastInsertRowid),
          test_id: testId,
          question_type: q.question_type,
          question_text: q.question,
          options: q.options,
          correct_index: q.correct_index,
          acceptable_answers: q.acceptable_answers,
          points: q.points,
          order_index: i
        });
      }

      const testRowRes = await db.execute({
        sql: 'SELECT id, teacher_id, title, audio_path, transcript, deadline, status, code, created_at, max_plays FROM mcq_tests WHERE id = ?',
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
        } catch (_) { }
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
      sql: 'SELECT id, code, title, audio_path, transcript, deadline, status, teacher_id FROM mcq_tests WHERE code = ?',
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
      sql: `SELECT id, student_name, device_id, ip_address, answers, score, possible_duplicate, diagnostic_feedback, submitted_at
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

      let parsedDiagnostics = att.diagnostic_feedback;
      if (typeof parsedDiagnostics === 'string') {
        try {
          parsedDiagnostics = JSON.parse(parsedDiagnostics);
        } catch (_) {
          parsedDiagnostics = null;
        }
      }

      return {
        ...att,
        answers: parsedAnswers && typeof parsedAnswers === 'object' ? parsedAnswers : {},
        diagnostic_feedback: Array.isArray(parsedDiagnostics) ? parsedDiagnostics : null
      };
    });

    const questionsRes = await db.execute({
      sql: `SELECT id, question_type, question_text, options, correct_index, acceptable_answers, points, order_index
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
      let acceptable = q.acceptable_answers;
      if (typeof acceptable === 'string') {
        try {
          acceptable = JSON.parse(acceptable);
        } catch (_) {
          acceptable = [];
        }
      }
      return {
        ...q,
        question_type: q.question_type || 'mcq',
        options: Array.isArray(opts) ? opts : [],
        acceptable_answers: Array.isArray(acceptable) ? acceptable : []
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

// 4. POST /api/mcq/:testId/attempts/:attemptId/diagnose - Universal Listening Skills Diagnostic Engine
app.post('/api/mcq/:testId/attempts/:attemptId/diagnose', authenticateToken, requireApprovedUser, async (req, res) => {
  try {
    const testParam = req.params.testId;
    const attemptId = parseInt(req.params.attemptId, 10);
    if (!testParam || isNaN(attemptId) || attemptId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid test identifier or attempt ID.' });
    }

    // Lookup test by numeric id or code
    const isNumericId = !isNaN(parseInt(testParam, 10)) && String(parseInt(testParam, 10)) === String(testParam).trim();
    const testQuery = isNumericId
      ? 'SELECT id, code, title, audio_path, transcript, teacher_id FROM mcq_tests WHERE id = ?'
      : 'SELECT id, code, title, audio_path, transcript, teacher_id FROM mcq_tests WHERE code = ?';
    const testArg = isNumericId ? parseInt(testParam, 10) : String(testParam).trim();

    const testRes = await db.execute({ sql: testQuery, args: [testArg] });
    const test = testRes.rows[0];
    if (!test) {
      return res.status(404).json({ success: false, error: 'MCQ assessment not found.' });
    }

    const isElevated = ['root', 'admin'].includes(req.user.role);
    if (Number(test.teacher_id) !== Number(req.user.id) && !isElevated) {
      return res.status(403).json({ success: false, error: 'Unauthorized to run diagnostics on this test.' });
    }

    // Universal Rule 2: Must be a Listening Assessment with an audio track
    if (!test.audio_path) {
      return res.status(400).json({
        success: false,
        error: 'Diagnostics are only supported for Listening Assessments that contain an audio track.'
      });
    }

    // Verify transcript
    const transcript = test.transcript;
    if (!transcript || !transcript.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Audio transcript is missing for this test. Diagnostics require a verbatim audio transcript.'
      });
    }

    // Fetch student attempt
    const attemptRes = await db.execute({
      sql: 'SELECT id, student_name, answers, score, diagnostic_feedback FROM mcq_attempts WHERE id = ? AND test_id = ?',
      args: [attemptId, test.id]
    });
    const attempt = attemptRes.rows[0];
    if (!attempt) {
      return res.status(404).json({ success: false, error: 'Student attempt record not found.' });
    }

    let studentAnswers = attempt.answers;
    if (typeof studentAnswers === 'string') {
      try { studentAnswers = JSON.parse(studentAnswers); } catch (_) { studentAnswers = {}; }
    }
    if (!studentAnswers || typeof studentAnswers !== 'object') studentAnswers = {};

    // Fetch questions
    const qRes = await db.execute({
      sql: `SELECT id, question_type, question_text, options, correct_index, acceptable_answers, points, order_index
            FROM mcq_questions
            WHERE test_id = ?
            ORDER BY order_index ASC, id ASC`,
      args: [test.id]
    });
    const questions = qRes.rows;

    // Strict Marking Separation: Identify mistakes per the official marking scheme
    const mistakesList = [];
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const qPoints = Number(q.points) > 0 ? Number(q.points) : 1;
      const qType = q.question_type || 'mcq';

      if (qType === 'fill_blank') {
        const rawAns = studentAnswers[q.id] !== undefined && studentAnswers[q.id] !== null ? String(studentAnswers[q.id]) : '';
        const studentAns = rawAns.trim().toLowerCase().replace(/['"]/g, '');
        let acceptable = q.acceptable_answers;
        if (typeof acceptable === 'string') {
          try { acceptable = JSON.parse(acceptable); } catch (_) { acceptable = []; }
        }
        if (!Array.isArray(acceptable)) acceptable = [];
        const normalizedAcceptable = acceptable
          .map((a) => (a !== null && a !== undefined ? String(a).trim().toLowerCase().replace(/['"]/g, '') : ''))
          .filter(Boolean);

        if (!studentAns || !normalizedAcceptable.includes(studentAns)) {
          mistakesList.push({
            question_id: q.id,
            question_number: i + 1,
            question_type: 'fill_blank',
            question_text: q.question_text,
            student_answer: rawAns.trim() || '(empty)',
            correct_answer: acceptable.join(', '),
            points_possible: qPoints,
            points_awarded: 0
          });
        }
      } else {
        // 'mcq' or 'matching'
        const rawVal = studentAnswers[q.id];
        const studentChoice = rawVal !== undefined && rawVal !== null && rawVal !== '' ? parseInt(rawVal, 10) : -1;
        if (isNaN(studentChoice) || studentChoice !== Number(q.correct_index)) {
          let opts = q.options;
          if (typeof opts === 'string') {
            try { opts = JSON.parse(opts); } catch (_) { opts = []; }
          }
          if (!Array.isArray(opts)) opts = [];

          const correctOption = opts[q.correct_index] || `Option ${Number(q.correct_index) + 1}`;
          const studentOption = studentChoice >= 0 && opts[studentChoice] ? opts[studentChoice] : (studentChoice >= 0 ? `Option ${studentChoice + 1}` : '(unanswered)');

          mistakesList.push({
            question_id: q.id,
            question_number: i + 1,
            question_type: qType,
            question_text: q.question_text,
            student_answer: studentOption,
            correct_answer: correctOption,
            points_possible: qPoints,
            points_awarded: 0
          });
        }
      }
    }

    // If 0 mistakes, student has full marks
    if (mistakesList.length === 0) {
      await db.execute({
        sql: 'UPDATE mcq_attempts SET diagnostic_feedback = ? WHERE id = ?',
        args: [JSON.stringify([]), attemptId]
      });
      return res.json({
        success: true,
        diagnostics: [],
        message: 'Perfect score! 0 listening mistakes detected.'
      });
    }

    // Send to Gemini with Complete IG Grade 9 Listening Skills Framework directly embedded
    const systemInstruction = `You are the Universal English Listening Diagnostic Examiner for Mimir Marking.
Analyze the student's listening mistakes using the embedded IG Grade 9 Listening Skills Framework.

CORE RULE:
Scoring and points are already finalized strictly per the official Marking Scheme. Your role is purely analytical: pinpoint WHY the mistake occurred, identify which specific listening sub-skill and trap caused the error, and provide an actionable diagnostic intervention strategy.

================================================================================
EMBEDDED FRAMEWORK: IG GRADE 9 LISTENING SKILLS TAXONOMY
================================================================================

1. Vocabulary in Context
   - Sub-skills: Context meaning, Synonyms, Collocations, Phrasal verbs, Pronunciation
   - Pedagogical Trap: The student hears a word in spoken English (e.g. hears "purchase") but fails to recognize its target synonym/meaning (e.g. "buy").
   - Recommended Intervention: Synonym listening practice & vocabulary matching.

2. Gist & Main Idea
   - Sub-skills: General topic, Speaker's purpose, Main point, Summarizing
   - Pedagogical Trap: The student gets distracted by isolated, minor details and misses the overall message or communicative purpose of the speaker.
   - Recommended Intervention: Topic identification drills without note-taking on isolated numbers.

3. Specific Information
   - Sub-skills: Names, Numbers, Dates, Places, Reasons, Examples, Facts / details
   - Pedagogical Trap: The student misidentifies an exact date, time, quantity, name, or location mentioned in the dialogue.
   - Recommended Intervention: Date/number listening drills and targeted fact-extraction practice.

4. Paraphrasing
   - Sub-skills: Recognizing synonyms, Rephrased ideas, Equivalent meaning, Matching question wording to spoken information
   - Pedagogical Trap: The student listens for exact keywords from the question paper instead of recognizing rephrased speech (e.g., question says "rise", but dialogue says "increase").
   - Recommended Intervention: Paraphrase mapping drills between exam text and audio script.

5. Inference
   - Sub-skills: Implied meaning, Context clues, Connecting information, Drawing conclusions
   - Pedagogical Trap: The student fails to read between the lines to deduce unstated feelings, hidden intentions, or indirect conclusions.
   - Recommended Intervention: Context-clue inference tasks and deduction exercises.

6. Opinion & Attitude
   - Sub-skills: Opinion, Feelings, Tone, Agreement / disagreement, Attitude
   - Pedagogical Trap: The student fails to recognize whether a speaker is supportive, critical, neutral, or hesitant due to subtle intonation or hedging qualifiers.
   - Recommended Intervention: Tone and attitude analysis listening exercises.

7. Distractors
   - Sub-skills: Corrections (self-repair), Changed information, Irrelevant details, Misleading options
   - Pedagogical Trap: The speaker mentions false or earlier information first, then corrects it (e.g., "I wanted tea, but actually had coffee"). The student prematurely chooses the first mentioned option.
   - Recommended Intervention: Correction & distractor drills focusing on pivot words like "actually", "instead", "rather", or "however".

8. Multiple Speakers
   - Sub-skills: Speaker identification, Matching speaker to opinion, Distinguishing viewpoints, Tracking different speakers
   - Pedagogical Trap: In dialogues or matching tasks (Speakers 1–5), the student confuses who expressed which viewpoint.
   - Recommended Intervention: Multi-speaker identification and perspective-tracking drills.

9. Sequencing & Development
   - Sub-skills: Stages, Transitions, Changes in topic, Chronological order
   - Pedagogical Trap: The student confuses the chronological sequence of events or misses transition signposts indicating a new stage.
   - Recommended Intervention: Chronological timeline mapping and transition-word tracking.

10. Processing Speed
    - Sub-skills: Fast speech, Maintaining attention, Following information, Moving between pieces of information
    - Pedagogical Trap: The student loses track during rapid delivery, connected speech (elision/assimilation), or fast topic transitions.
    - Recommended Intervention: Speed-building listening drills and connected-speech awareness practice.

11. Answer Accuracy
    - Sub-skills: Spelling, Grammar / answer form, Following instructions, Checking answers
    - Pedagogical Trap: Exceeded word count limit (e.g., "NO MORE THAN ONE WORD"), spelling errors that alter word meaning, singular vs plural confusion.
    - Recommended Intervention: Form-checking drills, singular/plural listening verification, and word-limit compliance checks.

12. Listening Strategies
    - Sub-skills: Prediction, Keywords, Anticipating vocabulary, Using first listening effectively, Using second listening for confirmation, Checking answers
    - Pedagogical Trap: Failure to pre-read questions to predict word category or grammatical form, or failing to use the second listen for verification.
    - Recommended Intervention: Pre-listening prediction drills and dual-pass listening strategy coaching.

================================================================================
DIAGNOSTIC PIPELINE PATTERN:
Main Skill -> Sub-skill -> Observable Error -> Diagnosis -> Intervention Strategy -> Retest Recommendation
================================================================================`;

    const promptText = `AUDIO TRANSCRIPT:
${transcript}

STUDENT MISTAKES DATA:
${JSON.stringify(mistakesList, null, 2)}

OUTPUT REQUIREMENT (Strict JSON):
Return a JSON object with a "diagnostics" array containing an entry for every mistake listed above:
{
  "diagnostics": [
    {
      "question_id": 1,
      "main_skill": "Distractors",
      "sub_skill": "Recognizing corrections",
      "observable_error": "Selected initial statement before the speaker corrected themselves",
      "spoken_quote": "Exact sentence spoken in the audio transcript",
      "diagnosis_and_strategy": "2-3 sentences explaining why this option was a trap and the exact strategy to catch it in future tests.",
      "intervention": "Distractor & self-correction listening drills focusing on pivot words like 'actually' or 'instead'.",
      "retest_type": "New correction item"
    }
  ]
}`;

    const models = ['gemini-2.5-flash', 'gemini-3.6-flash', 'gemini-3.5-flash'];
    let rawOutput = null;

    for (const modelName of models) {
      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: [
            { role: 'user', parts: [{ text: `${systemInstruction}\n\n${promptText}` }] }
          ],
          config: {
            responseMimeType: 'application/json'
          }
        });
        rawOutput = response.text;
        if (rawOutput) break;
      } catch (gemErr) {
        console.warn(`[Diagnostic Model ${modelName} Warning]:`, gemErr.message);
      }
    }

    if (!rawOutput) {
      throw new Error('Failed to generate diagnostic feedback from Gemini.');
    }

    let parsed = null;
    try {
      parsed = JSON.parse(rawOutput);
    } catch (_) {
      const match = rawOutput.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
    }

    const rawDiagnostics = parsed && Array.isArray(parsed.diagnostics) ? parsed.diagnostics : [];
    const diagnostics = rawDiagnostics.map((d) => {
      const mistake = mistakesList.find((m) => m.question_id === d.question_id || m.question_number === d.question_id) || {};
      return {
        ...d,
        student_answer: d.student_answer || mistake.student_answer || '',
        correct_answer: d.correct_answer || mistake.correct_answer || '',
        question_number: d.question_number || mistake.question_number || d.question_id
      };
    });

    await db.execute({
      sql: 'UPDATE mcq_attempts SET diagnostic_feedback = ? WHERE id = ?',
      args: [JSON.stringify(diagnostics), attemptId]
    });

    return res.json({
      success: true,
      diagnostics
    });
  } catch (err) {
    console.error('Error running listening diagnostics:', err);
    return res.status(500).json({ success: false, error: err.message || 'Diagnostic generation failed.' });
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
      sql: 'SELECT id, teacher_id, title, audio_path, transcript, deadline, status, code, created_at, max_plays FROM mcq_tests WHERE id = ?',
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
      sql: 'SELECT id, test_id, question_type, question_text, options, correct_index, acceptable_answers, points, order_index FROM mcq_questions WHERE test_id = ? ORDER BY order_index ASC, id ASC',
      args: [testId]
    });

    const questions = [];
    for (let idx = 0; idx < qRes.rows.length; idx++) {
      const q = qRes.rows[idx];
      let opts = q.options;
      if (typeof opts === 'string') {
        try {
          opts = JSON.parse(opts);
        } catch (_) {
          opts = [];
        }
      }
      let acceptable = q.acceptable_answers;
      if (typeof acceptable === 'string') {
        try {
          acceptable = JSON.parse(acceptable);
        } catch (_) {
          acceptable = [];
        }
      }

      if (Array.isArray(opts)) {
        for (const opt of opts) {
          if (opt && typeof opt === 'object' && opt.object_key) {
            try {
              opt.image_url = (await generateSignedImageUrl(opt.object_key)) || opt.image_url || '';
            } catch (_) {}
          }
        }
      }

      questions.push({
        id: q.id,
        test_id: q.test_id,
        question_type: q.question_type || 'mcq',
        question_text: q.question_text,
        options: Array.isArray(opts) ? opts : [],
        correct_index: q.correct_index,
        acceptable_answers: Array.isArray(acceptable) ? acceptable : [],
        points: q.points,
        order_index: q.order_index
      });
    }

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
      sql: 'SELECT id, test_id, question_type, question_text, options, correct_index, acceptable_answers, points, order_index FROM mcq_questions WHERE id = ? AND test_id = ?',
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

    let existingAcceptable = [];
    try {
      existingAcceptable = typeof question.acceptable_answers === 'string' ? JSON.parse(question.acceptable_answers) : question.acceptable_answers;
    } catch (_) {
      existingAcceptable = [];
    }

    const { question_type, question_text, options, correct_index, acceptable_answers, points } = req.body;

    const updatedQType = question_type !== undefined
      ? (['mcq', 'matching', 'fill_blank'].includes(question_type) ? question_type : 'mcq')
      : (question.question_type || 'mcq');

    let updatedQuestionText = question.question_text;
    if (question_text !== undefined) {
      if (typeof question_text !== 'string') {
        return res.status(400).json({ error: 'Question text must be a string.' });
      }
      updatedQuestionText = question_text.trim();
    }

    let updatedOptions = Array.isArray(existingOptions) ? existingOptions : [];
    let updatedCorrectIndex = question.correct_index;
    let updatedAcceptable = Array.isArray(existingAcceptable) ? existingAcceptable : [];

    if (updatedQType === 'fill_blank') {
      updatedOptions = [];
      updatedCorrectIndex = null;
      if (acceptable_answers !== undefined) {
        if (Array.isArray(acceptable_answers)) {
          updatedAcceptable = acceptable_answers.map((a) => String(a || '').trim()).filter(Boolean);
        } else if (typeof acceptable_answers === 'string') {
          updatedAcceptable = acceptable_answers.split(',').map((a) => a.trim()).filter(Boolean);
        } else {
          updatedAcceptable = [];
        }
      }
    } else {
      // 'mcq' or 'matching'
      if (options !== undefined) {
        if (!Array.isArray(options) || options.length < 2) {
          return res.status(400).json({ error: 'Options must be an array with at least 2 options.' });
        }
        const cleanOptions = options.map((opt) => {
          if (typeof opt === 'object' && opt !== null) return opt;
          return opt !== null && opt !== undefined ? String(opt).trim() : '';
        });
        if (cleanOptions.some((opt) => opt === '')) {
          return res.status(400).json({ error: 'All options must be non-empty strings or objects.' });
        }
        updatedOptions = cleanOptions;
      }

      if (correct_index !== undefined) {
        const cIdx = Number(correct_index);
        if (!Number.isInteger(cIdx) || cIdx < 0 || cIdx >= updatedOptions.length) {
          return res.status(400).json({ error: `correct_index must be an integer between 0 and ${updatedOptions.length - 1}.` });
        }
        updatedCorrectIndex = cIdx;
      } else if (options !== undefined && (updatedCorrectIndex === null || updatedCorrectIndex < 0 || updatedCorrectIndex >= updatedOptions.length)) {
        updatedCorrectIndex = 0;
      }
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
            SET question_type = ?, question_text = ?, options = ?, correct_index = ?, acceptable_answers = ?, points = ?
            WHERE id = ? AND test_id = ?`,
      args: [
        updatedQType,
        updatedQuestionText,
        JSON.stringify(updatedOptions),
        updatedCorrectIndex,
        JSON.stringify(updatedAcceptable),
        updatedPoints,
        questionId,
        testId
      ]
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
      sql: 'SELECT id, question_type, question_text, options, correct_index, acceptable_answers, points, order_index FROM mcq_questions WHERE test_id = ? ORDER BY order_index ASC',
      args: [testId]
    });

    const questions = qRes.rows;
    if (!questions || questions.length === 0) {
      return res.status(400).json({ error: 'Cannot publish a test with no questions. Add at least 1 question.' });
    }

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const qType = q.question_type || 'mcq';

      if (!q.question_text || !q.question_text.trim()) {
        return res.status(400).json({ error: `Cannot publish: Question #${i + 1} has empty question text.` });
      }

      if (qType === 'fill_blank') {
        let acceptable = q.acceptable_answers;
        if (typeof acceptable === 'string') {
          try { acceptable = JSON.parse(acceptable); } catch (_) { acceptable = []; }
        }
        if (!Array.isArray(acceptable) || acceptable.length === 0 || !acceptable.some(a => String(a || '').trim())) {
          return res.status(400).json({ error: `Cannot publish: Question #${i + 1} (Fill in the Blank) must have at least 1 acceptable answer.` });
        }
      } else {
        // 'mcq' or 'matching'
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

    // S3/Filebase Storage cleanup: audio + question image crops
    const filesToDelete = [];
    if (test.audio_path) filesToDelete.push(test.audio_path);

    try {
      const qRows = await db.execute({
        sql: 'SELECT options FROM mcq_questions WHERE test_id = ?',
        args: [testId]
      });
      for (const row of qRows.rows) {
        let opts = row.options;
        if (typeof opts === 'string') {
          try { opts = JSON.parse(opts); } catch (_) { opts = []; }
        }
        if (Array.isArray(opts)) {
          for (const opt of opts) {
            if (opt && typeof opt === 'object') {
              if (opt.image_url) filesToDelete.push(opt.image_url);
              if (opt.object_key) filesToDelete.push(opt.object_key);
            }
          }
        }
      }
    } catch (qErr) {
      console.warn('[MCQ Delete Questions Media Warning]:', qErr.message);
    }

    if (filesToDelete.length > 0) {
      await deleteStorageFiles(filesToDelete);
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
      sql: `SELECT id, question_type, question_text, options, order_index
            FROM mcq_questions
            WHERE test_id = ?
            ORDER BY order_index ASC, id ASC`,
      args: [test.id]
    });

    // CRITICAL: Anti-cheat stripping of correct_index, points, and acceptable_answers
    const questions = [];
    for (let idx = 0; idx < qRes.rows.length; idx++) {
      const q = qRes.rows[idx];
      let opts = q.options;
      if (typeof opts === 'string') {
        try {
          opts = JSON.parse(opts);
        } catch (_) {
          opts = [];
        }
      }

      if (Array.isArray(opts)) {
        for (const opt of opts) {
          if (opt && typeof opt === 'object' && opt.object_key) {
            try {
              opt.image_url = (await generateSignedImageUrl(opt.object_key)) || opt.image_url || '';
            } catch (_) {}
          }
        }
      }

      questions.push({
        id: q.id,
        question_type: q.question_type || 'mcq',
        question_text: q.question_text,
        options: Array.isArray(opts) ? opts : []
      });
    }

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

    // A blank, missing, short (< 35 chars), un-hyphenated, or legacy-collided deviceId must never match a lock
    if (isInvalidOrCollidedDeviceId(deviceId)) {
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
      if (cleanDeviceId && !isInvalidOrCollidedDeviceId(cleanDeviceId)) {
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
        sql: 'SELECT id, question_type, correct_index, acceptable_answers, points FROM mcq_questions WHERE test_id = ? ORDER BY order_index ASC, id ASC',
        args: [test.id]
      });

      const questions = qRes.rows;
      let totalScore = 0;
      let earnedScore = 0;
      const cleanAnswers = (answers && typeof answers === 'object') ? answers : {};

      for (const q of questions) {
        const qPoints = Number(q.points) > 0 ? Number(q.points) : 1;
        totalScore += qPoints;
        const qType = q.question_type || 'mcq';

        if (qType === 'fill_blank') {
          const rawAns = cleanAnswers[q.id] !== undefined && cleanAnswers[q.id] !== null ? String(cleanAnswers[q.id]) : '';
          const studentAns = rawAns.trim().toLowerCase().replace(/['"]/g, '');

          let acceptable = q.acceptable_answers;
          if (typeof acceptable === 'string') {
            try { acceptable = JSON.parse(acceptable); } catch (_) { acceptable = []; }
          }
          if (!Array.isArray(acceptable)) acceptable = [];

          const normalizedAcceptable = acceptable
            .map((a) => (a !== null && a !== undefined ? String(a).trim().toLowerCase().replace(/['"]/g, '') : ''))
            .filter(Boolean);

          if (studentAns && normalizedAcceptable.includes(studentAns)) {
            earnedScore += qPoints;
          }
        } else {
          // 'mcq' or 'matching'
          const rawVal = cleanAnswers[q.id];
          const studentChoice = rawVal !== undefined && rawVal !== null && rawVal !== '' ? parseInt(rawVal, 10) : -1;
          if (!isNaN(studentChoice) && studentChoice === Number(q.correct_index)) {
            earnedScore += qPoints;
          }
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
}
