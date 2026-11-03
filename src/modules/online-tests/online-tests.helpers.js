import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import { __dirname } from '../../paths.js';
import { db } from '../../db/client.js';
import { ai } from '../../integrations/gemini.js';

function validateOnlineTestStructure(data) {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Expected root JSON object containing a "sections" array.' };
  }

  const rawSections = Array.isArray(data.sections) ? data.sections : (Array.isArray(data) ? data : null);
  if (!rawSections || rawSections.length === 0) {
    return { valid: false, error: 'Exam must contain at least one non-empty section.' };
  }

  const validSectionTypes = ['listening', 'reading', 'grammar', 'writing', 'general'];
  const validQuestionTypes = ['mcq', 'matching', 'fill_blank', 'rewrite', 'short_answer', 'writing'];
  const sanitizedSections = [];

  for (let sIdx = 0; sIdx < rawSections.length; sIdx++) {
    const s = rawSections[sIdx];
    if (!s || typeof s !== 'object') {
      return { valid: false, error: `Section at index ${sIdx} is invalid or malformed.` };
    }

    const sectionTitle = typeof s.section_title === 'string' && s.section_title.trim()
      ? s.section_title.trim()
      : `Section ${sIdx + 1}`;

    const sectionType = typeof s.section_type === 'string' && validSectionTypes.includes(s.section_type.toLowerCase().trim())
      ? s.section_type.toLowerCase().trim()
      : 'general';

    const partNumber = Number.isInteger(s.part_number) && s.part_number >= 1
      ? s.part_number
      : (sIdx + 1);

    const instructionsText = typeof s.instructions_text === 'string' && s.instructions_text.trim()
      ? s.instructions_text.trim()
      : null;

    const passageText = typeof s.passage_text === 'string' && s.passage_text.trim()
      ? s.passage_text.trim()
      : null;

    const transcript = typeof s.transcript === 'string' && s.transcript.trim()
      ? s.transcript.trim()
      : null;

    if (!Array.isArray(s.questions) || s.questions.length === 0) {
      return { valid: false, error: `Section "${sectionTitle}" (Part ${partNumber}) contains no questions.` };
    }

    const sanitizedQuestions = [];
    for (let qIdx = 0; qIdx < s.questions.length; qIdx++) {
      const q = s.questions[qIdx];
      if (!q || typeof q !== 'object') {
        return { valid: false, error: `Question #${qIdx + 1} in section "${sectionTitle}" is invalid.` };
      }

      if (typeof q.question_text !== 'string' || !q.question_text.trim()) {
        return { valid: false, error: `Question #${qIdx + 1} in section "${sectionTitle}" has missing or empty question text.` };
      }

      const rawQType = typeof q.question_type === 'string' ? q.question_type.toLowerCase().trim() : '';
      if (!validQuestionTypes.includes(rawQType)) {
        return { valid: false, error: `Question #${qIdx + 1} in section "${sectionTitle}" has unsupported question_type: "${q.question_type}".` };
      }
      const qType = rawQType;

      const rawPoints = Number(q.points);
      if (isNaN(rawPoints) || rawPoints <= 0) {
        return { valid: false, error: `Question #${qIdx + 1} in section "${sectionTitle}" must have points > 0 (received: ${q.points}).` };
      }
      const points = rawPoints;

      let cleanOptions = null;
      let cleanCorrectAnswer = null;
      let minWords = Number.isInteger(q.min_words) && q.min_words > 0 ? q.min_words : null;
      let maxWords = Number.isInteger(q.max_words) && q.max_words > 0 ? q.max_words : null;
      const qNumMatch = (q.question_text || '').match(/(?:^|\s|\b)(?:question\s*)?([1-9]\d?)\b/i);
      const qNum = qNumMatch ? parseInt(qNumMatch[1], 10) : (qIdx + 1);
      const isPart1 = (partNumber === 1 || /part\s*1/i.test(sectionTitle)) && qNum <= 5;

      const hasImageUrls = Array.isArray(q.options) && q.options.some(opt => opt && (opt.image_url || opt.imageUrl || opt.object_key));
      const allOptionsAreLongText = Array.isArray(q.options) && q.options.length > 0 && q.options.every(opt => {
        const txt = (typeof opt === 'string' ? opt : (opt.value || opt.text || opt.caption || opt.statement || '')).trim();
        return txt.length > 20 || txt.split(/\s+/).length >= 4;
      });

      const isVisualOptions = isPart1 && !allOptionsAreLongText && !!(
        hasImageUrls ||
        (q.has_visual_options === true && (Array.isArray(q.options) && q.options.some(opt => {
          if (typeof opt === 'object' && opt !== null) {
            return opt.type === 'image' || Boolean(opt.object_key) || Boolean(opt.image_url) || (typeof opt.caption === 'string' && /\[?picture\s*[a-z]\]?/i.test(opt.caption));
          }
          const s = String(opt || '').trim().toLowerCase();
          return /\[?picture\s*[a-z]\]?/i.test(s) || s.startsWith('picture ');
        })))
      );
      const stimulusImageUrl = q.stimulus_image_url ? String(q.stimulus_image_url).trim() : null;

      if (qType === 'mcq') {
        if (!Array.isArray(q.options) || q.options.length < 2) {
          return { valid: false, error: `MCQ Question #${qIdx + 1} in section "${sectionTitle}" must contain at least 2 options.` };
        }
        if (isVisualOptions) {
          cleanOptions = q.options.map((opt, oIdx) => {
            if (typeof opt === 'object' && opt !== null) {
              let rawLabel = typeof opt.label === 'string' && opt.label.trim() ? opt.label.trim().toUpperCase() : String.fromCharCode(65 + oIdx);
              if (rawLabel === 'S') rawLabel = 'C';
              const label = ['A', 'B', 'C', 'D'].includes(rawLabel) ? rawLabel : String.fromCharCode(65 + oIdx);
              const caption = typeof opt.caption === 'string' ? opt.caption.trim() : '';
              const objectKey = typeof opt.object_key === 'string' && opt.object_key.trim() ? opt.object_key.trim() : (typeof opt.objectKey === 'string' ? opt.objectKey.trim() : null);
              const imageUrl = typeof opt.image_url === 'string' ? opt.image_url.trim() : '';
              const imageIndex = opt.image_index !== undefined ? Number(opt.image_index) : oIdx;
              return { type: 'image', label, object_key: objectKey, image_url: imageUrl, caption, image_index: imageIndex };
            }
            return {
              type: 'image',
              label: String.fromCharCode(65 + oIdx),
              object_key: null,
              image_url: '',
              caption: String(opt || '').trim(),
              image_index: oIdx
            };
          });
          const rawAns = Number(q.correct_answer);
          if (!Number.isInteger(rawAns) || rawAns < 0 || rawAns >= cleanOptions.length) {
            return { valid: false, error: `MCQ Question #${qIdx + 1} in section "${sectionTitle}" correct_answer must be an integer index between 0 and ${cleanOptions.length - 1} (received: ${q.correct_answer}).` };
          }
          cleanCorrectAnswer = rawAns;
        } else {
          // Strictly text options: for Part 2 & Part 4, force exactly 3 options (A, B, C)
          let rawOpts = q.options;
          if (!isPart1 && rawOpts.length > 3) {
            rawOpts = rawOpts.slice(0, 3);
          }
          cleanOptions = rawOpts.map((opt, oIdx) => {
            const label = ['A', 'B', 'C', 'D', 'E'][oIdx] || String.fromCharCode(65 + oIdx);
            const val = typeof opt === 'object' && opt !== null 
              ? (opt.value !== undefined ? String(opt.value).trim() : (opt.text ? String(opt.text).trim() : (opt.caption ? String(opt.caption).trim() : '')))
              : String(opt || '').trim();
            const cleanVal = val.replace(/^[A-E][.:]\s*/i, '').trim();
            return { type: 'text', label, value: cleanVal };
          }).filter(o => Boolean(o.value));
          if (cleanOptions.length < 2) {
            return { valid: false, error: `MCQ Question #${qIdx + 1} in section "${sectionTitle}" has invalid or empty options.` };
          }
          const rawAns = Number(q.correct_answer);
          cleanCorrectAnswer = (!Number.isInteger(rawAns) || rawAns < 0 || rawAns >= cleanOptions.length) ? 0 : rawAns;
        }

      } else if (qType === 'matching') {
        if (!Array.isArray(q.options) || q.options.length < 2) {
          return { valid: false, error: `Matching Question #${qIdx + 1} in section "${sectionTitle}" must contain at least 2 options.` };
        }
        cleanOptions = q.options.map((opt, oIdx) => {
          const label = (typeof opt === 'object' && opt && opt.label) ? String(opt.label).trim().toUpperCase() : String.fromCharCode(65 + oIdx);
          const val = typeof opt === 'object' && opt !== null 
            ? (opt.value !== undefined ? String(opt.value).trim() : (opt.text ? String(opt.text).trim() : (opt.statement ? String(opt.statement).trim() : (opt.caption ? String(opt.caption).trim() : '')))) 
            : String(opt || '').trim();
          return { type: 'text', label, value: val };
        }).filter(o => Boolean(o.value));
        if (cleanOptions.length < 2) {
          return { valid: false, error: `Matching Question #${qIdx + 1} in section "${sectionTitle}" has invalid or empty options.` };
        }

        const rawAns = Number(q.correct_answer);
        if (!Number.isInteger(rawAns) || rawAns < 0 || rawAns >= cleanOptions.length) {
          return { valid: false, error: `Matching Question #${qIdx + 1} in section "${sectionTitle}" correct_answer must be an integer index between 0 and ${cleanOptions.length - 1} (received: ${q.correct_answer}).` };
        }
        cleanCorrectAnswer = rawAns;

      } else if (['fill_blank', 'rewrite', 'short_answer'].includes(qType)) {
        cleanOptions = null;
        let accepted = [];
        if (Array.isArray(q.correct_answer)) {
          accepted = q.correct_answer.map((a) => (a !== null && a !== undefined ? String(a).trim() : '')).filter(Boolean);
        } else if (typeof q.correct_answer === 'string' && q.correct_answer.trim()) {
          accepted = [q.correct_answer.trim()];
        } else if (typeof q.correct_answer === 'number' && !isNaN(q.correct_answer)) {
          accepted = [String(q.correct_answer).trim()];
        } else if (Array.isArray(q.acceptable_answers)) {
          accepted = q.acceptable_answers.map((a) => (a !== null && a !== undefined ? String(a).trim() : '')).filter(Boolean);
        }

        if (accepted.length === 0) {
          return { valid: false, error: `Question #${qIdx + 1} (${qType}) in section "${sectionTitle}" must contain at least one accepted answer string.` };
        }
        cleanCorrectAnswer = accepted;

      } else if (qType === 'writing') {
        cleanOptions = null;
        let rubricObj = q.correct_answer;
        if (typeof rubricObj === 'string') {
          try {
            rubricObj = JSON.parse(rubricObj);
          } catch (_) {
            rubricObj = { rubric_notes: rubricObj };
          }
        }
        if (!rubricObj || typeof rubricObj !== 'object' || Array.isArray(rubricObj)) {
          return { valid: false, error: `Writing Question #${qIdx + 1} in section "${sectionTitle}" must contain a structured rubric object in correct_answer.` };
        }
        cleanCorrectAnswer = rubricObj;
      }

      let groupTitle = typeof q.group_title === 'string' && q.group_title.trim() ? q.group_title.trim() : null;
      let groupInstructions = typeof q.group_instructions === 'string' && q.group_instructions.trim() ? q.group_instructions.trim() : null;
      let wordBankArray = null;
      const rawBank = q.word_bank || q.shared_word_bank;
      if (Array.isArray(rawBank)) {
        wordBankArray = rawBank.map(w => String(w || '').trim()).filter(Boolean);
      } else if (typeof rawBank === 'string' && rawBank.trim()) {
        try {
          let parsed = JSON.parse(rawBank);
          if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch (_) {} }
          if (Array.isArray(parsed)) {
            wordBankArray = parsed.map(w => String(w || '').trim()).filter(Boolean);
          } else {
            wordBankArray = [rawBank.trim()];
          }
        } catch (_) {
          const parts = rawBank.split(/[|,]/).map(s => s.trim()).filter(Boolean);
          wordBankArray = parts.length > 0 ? parts : [rawBank.trim()];
        }
      }

      // Auto-recovery regex fallback: If wordBankArray is null/empty, inspect group_instructions, group_title, instructions_text, and question_text
      if (!wordBankArray || wordBankArray.length === 0) {
        const textToScan = [groupInstructions, groupTitle, instructionsText, q.question_text].filter(Boolean).join('\n');
        // Pattern 1: pipe-separated: "Simile | Metaphor | Personification | Alliteration | Onomatopoeia"
        const pipeMatch = textToScan.match(/(?:\[\s*)?([A-Za-z0-9_\- ']+(?:\s*\|\s*[A-Za-z0-9_\- ']+){2,})(?:\s*\])?/);
        if (pipeMatch) {
          const words = pipeMatch[1].split('|').map(s => s.trim().replace(/^\[|\]$/g, '')).filter(s => s.length > 0 && s.length < 60);
          if (words.length >= 3) {
            wordBankArray = words;
          }
        }
        // Pattern 2: slash-separated: "Although / Whereas / While"
        if (!wordBankArray || wordBankArray.length === 0) {
          const slashMatch = textToScan.match(/(?:\[\s*|\(\s*)?([A-Za-z0-9_\- ']+(?:\s*\/\s*[A-Za-z0-9_\- ']+){2,})(?:\s*\]|\s*\))?/);
          if (slashMatch) {
            const words = slashMatch[1].split('/').map(s => s.trim().replace(/^\[|\]$/g, '')).filter(s => s.length > 0 && s.length < 60);
            if (words.length >= 3) {
              wordBankArray = words;
            }
          }
        }
        // Pattern 3: Explicit Box / Word bank keywords: e.g. "Choose from: (word1, word2, word3)" or "Word Bank: word1, word2, word3"
        if (!wordBankArray || wordBankArray.length === 0) {
          const boxMatch = textToScan.match(/(?:word\s*bank|reference\s*box|choose\s*from|box)[\s:]*\[?([A-Za-z0-9_\- ',;/]+)\]?/i);
          if (boxMatch) {
            const words = boxMatch[1].split(/[,;/]/).map(s => s.trim()).filter(s => s.length > 0 && s.length < 60);
            if (words.length >= 3) {
              wordBankArray = words;
            }
          }
        }
      }

      sanitizedQuestions.push({
        question_type: qType,
        question_text: q.question_text.trim(),
        options: cleanOptions,
        correct_answer: cleanCorrectAnswer,
        min_words: minWords,
        max_words: maxWords,
        points: points,
        order_index: qIdx,
        stimulus_image_url: stimulusImageUrl,
        has_visual_options: isVisualOptions ? 1 : 0,
        group_title: groupTitle,
        group_instructions: groupInstructions,
        word_bank: (wordBankArray && wordBankArray.length > 0) ? wordBankArray : null,
        shared_word_bank: (wordBankArray && wordBankArray.length > 0) ? wordBankArray : null
      });
    }

    // Propagate word_bank across all questions sharing the same group_title
    const groupBankMap = new Map();
    for (const q of sanitizedQuestions) {
      if (q.group_title && Array.isArray(q.word_bank) && q.word_bank.length > 0) {
        groupBankMap.set(q.group_title, q.word_bank);
      }
    }
    for (const q of sanitizedQuestions) {
      if (q.group_title && (!q.word_bank || q.word_bank.length === 0) && groupBankMap.has(q.group_title)) {
        q.word_bank = groupBankMap.get(q.group_title);
        q.shared_word_bank = q.word_bank;
      }
    }

    sanitizedSections.push({
      section_title: sectionTitle,
      section_type: sectionType,
      part_number: partNumber,
      instructions_text: instructionsText,
      passage_text: passageText,
      transcript: transcript,
      order_index: sIdx,
      questions: sanitizedQuestions
    });
  }

  return { valid: true, sanitizedSections };
}

async function generateUniqueOnlineTestCode() {
  for (let i = 0; i < 10; i++) {
    const code = crypto.randomBytes(3).toString('hex').toLowerCase();
    const existing = await db.execute({
      sql: 'SELECT id FROM online_tests WHERE code = ? LIMIT 1',
      args: [code]
    });
    if (existing.rows.length === 0) return code;
  }
  return crypto.randomBytes(4).toString('hex').slice(0, 6).toLowerCase();
}

// Helper: Strict Multi-Tenancy & Authorization Validator (Only the creator can access/modify their test)
async function getAuthoritativeTestOrCheckAuth(testId, user) {
  const testRes = await db.execute({
    sql: 'SELECT id, teacher_id, title, deadline, status, code, audio_path, extra_instructions, created_at FROM online_tests WHERE id = ?',
    args: [testId]
  });
  const test = testRes.rows[0];
  if (!test) {
    return { test: null, status: 404, error: 'Online test not found.' };
  }
  if (!user || Number(test.teacher_id) !== Number(user.id)) {
    return { test: null, status: 403, error: 'Forbidden: You do not have permission to access or modify this test.' };
  }
  return { test, status: 200, error: null };
}

// ----------------- ASYNC BACKGROUND EVALUATION & DUAL DIAGNOSTIC ENGINE -----------------

async function evaluateAndDiagnoseAttempt(attemptId, testId) {
  try {
    const attemptRes = await db.execute({
      sql: 'SELECT id, test_id, student_name, answers, score, max_score, status FROM online_test_attempts WHERE id = ?',
      args: [attemptId]
    });

    const attempt = attemptRes.rows[0];
    if (!attempt) return;

    let answers = [];
    try { answers = JSON.parse(attempt.answers); } catch (_) { answers = []; }

    const sectionsRes = await db.execute({
      sql: 'SELECT id, section_title, section_type, part_number, instructions_text, passage_text, transcript FROM online_test_sections WHERE test_id = ?',
      args: [testId]
    });

    const sectionsMap = new Map();
    sectionsRes.rows.forEach((s) => sectionsMap.set(Number(s.id), s));

    const geminiModels = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-flash'];

    // 1. Evaluate Writing / Essay Questions (Hybrid: Type vs. Photo Upload with Gemini OCR)
    const writingTasks = answers.filter((a) => a.question_type === 'writing');
    for (const w of writingTasks) {
      // Step A: If submitted as handwritten photos, run multimodal OCR transcription pipeline first
      const hasPhotos = w.mode === 'photo' || (Array.isArray(w.essay_images) && w.essay_images.length > 0);
      if (hasPhotos) {
        const imagePayloadParts = [];
        const rawImages = Array.isArray(w.essay_images) ? w.essay_images : [];

        for (const imgRef of rawImages) {
          try {
            if (typeof imgRef === 'string' && imgRef.startsWith('data:')) {
              const matches = imgRef.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
              if (matches) {
                const mimeType = matches[1].includes('png') ? 'image/png' : 'image/jpeg';
                imagePayloadParts.push({
                  inlineData: {
                    mimeType,
                    data: matches[2]
                  }
                });
              }
            } else if (typeof imgRef === 'string' && imgRef.trim()) {
              const cleanRelPath = imgRef.trim().replace(/^\//, '');
              const localAbsPath = path.join(__dirname, 'public', cleanRelPath);
              if (fs.existsSync(localAbsPath)) {
                const fileBuf = fs.readFileSync(localAbsPath);
                const ext = path.extname(localAbsPath).toLowerCase();
                const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
                imagePayloadParts.push({
                  inlineData: {
                    mimeType,
                    data: fileBuf.toString('base64')
                  }
                });
              }
            }
          } catch (readErr) {
            console.warn('[OCR Image Read Warning]:', readErr.message);
          }
        }

        let transcribedText = '';
        if (imagePayloadParts.length > 0) {
          const ocrPrompt = 'Transcribe all handwritten student text across these pages sequentially and verbatim. Maintain paragraph breaks. Return ONLY the transcribed text without conversational preamble.';
          const ocrContents = [...imagePayloadParts, ocrPrompt];

          const ocrModels = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-flash'];
          for (const m of ocrModels) {
            try {
              const resp = await ai.models.generateContent({
                model: m,
                contents: ocrContents
              });
              if (resp && resp.text && resp.text.trim()) {
                transcribedText = resp.text.trim();
                break;
              }
            } catch (ocrErr) {
              console.warn(`[OCR Gemini Model ${m} Notice]:`, ocrErr.message);
            }
          }
        }

        if (!transcribedText) {
          transcribedText = (w.student_answer || '').trim() || '[Handwritten submission - transcription pending teacher review]';
        }

        const calculatedWords = transcribedText.trim().split(/\s+/).filter(Boolean).length;
        w.mode = 'photo';
        w.essay_images = rawImages;
        w.images = rawImages;
        w.transcribed_text = transcribedText;
        w.student_answer = transcribedText;
        w.word_count = calculatedWords;
      }

      // Step B: Grade student response against rubric criteria
      const studentText = (w.student_answer || w.transcribed_text || '').trim();
      if (studentText && !studentText.startsWith('[Handwritten submission - transcription pending')) {
        const rubricObj = w.correct_answer || {};
        const writingPrompt = `You are the Senior IGCSE/GCSE English Writing Examiner for Mimir Marking.
Evaluate the student's writing response strictly according to the official marking scheme rubric criteria.

Task Prompt:
"${w.question_text}"

Student Word Count: ${w.word_count || 0}
Target Bounds: Min ${w.min_words || 'None'}, Max ${w.max_words || 'None'}

Official Marking Scheme Rubric:
${JSON.stringify(rubricObj, null, 2)}

Max Points Available: ${w.max_points}

Student Submitted Response:
"""
${studentText}
"""

Evaluate strictly using the rubric. Output valid JSON in this exact structure:
{
  "question_id": ${w.question_id},
  "content_score": <number>,
  "language_score": <number>,
  "total_score": <number, between 0 and ${w.max_points}>,
  "commentary": "<concise analytical assessment>",
  "achieved_criteria": ["<specific rubric point achieved>", ...],
  "missed_criteria": ["<specific rubric point missed or incomplete>", ...]
}`;

        let evalJson = null;
        for (const m of geminiModels) {
          try {
            const resp = await ai.models.generateContent({
              model: m,
              contents: writingPrompt,
              config: { responseMimeType: 'application/json' }
            });
            if (resp && resp.text) {
              evalJson = JSON.parse(resp.text);
              break;
            }
          } catch (_) { }
        }

        if (evalJson) {
          let awarded = parseFloat(evalJson.total_score);
          if (isNaN(awarded) || awarded < 0) awarded = 0;
          if (awarded > w.max_points) awarded = w.max_points;

          w.points_awarded = awarded;
          w.writing_evaluation = evalJson;
          w.rubric_scores = evalJson;
        } else {
          // Fallback if AI unavailable: award 70% provisional mark
          const fallbackPts = Math.round(Number(w.max_points) * 0.7);
          const fallbackEval = {
            total_score: fallbackPts,
            commentary: 'Provisional score generated. Awaiting teacher review.',
            achieved_criteria: ['Addressed prompt response'],
            missed_criteria: []
          };
          w.points_awarded = fallbackPts;
          w.writing_evaluation = fallbackEval;
          w.rubric_scores = fallbackEval;
        }
      } else {
        // Fallback for pending or blank submissions
        const defaultPts = studentText ? Math.round(Number(w.max_points) * 0.7) : 0;
        const defaultEval = {
          total_score: defaultPts,
          commentary: studentText ? 'Provisional score generated. Awaiting teacher review.' : 'No response submitted.',
          achieved_criteria: studentText ? ['Submitted response pages'] : [],
          missed_criteria: studentText ? [] : ['Complete task response']
        };
        w.points_awarded = defaultPts;
        w.writing_evaluation = defaultEval;
        w.rubric_scores = defaultEval;
      }
    }

    // 2. Dual Diagnostic Analysis Pass for all incorrect or imperfect answers
    const mistakes = answers.filter((a) => Number(a.points_awarded || 0) < Number(a.max_points || 0));
    let diagnosticReport = null;

    if (mistakes.length > 0) {
      const mistakeItems = mistakes.map((m) => {
        const sec = sectionsMap.get(Number(m.section_id));
        return {
          question_id: m.question_id,
          section_title: sec?.section_title || '',
          section_type: sec?.section_type || m.section_type || 'general',
          question_text: m.question_text,
          student_answer: m.student_answer,
          correct_answer: m.correct_answer,
          points_awarded: m.points_awarded,
          max_points: m.max_points,
          transcript_evidence: sec?.transcript || null,
          passage_evidence: sec?.passage_text || null
        };
      });

      const diagPrompt = `You are the Senior Exam Diagnostic Examiner for Mimir Marking.
Analyze the student's mistakes on this examination.

CRITICAL PEDAGOGICAL INSTRUCTIONS:
1. For LISTENING mistakes:
   You MUST classify the error using the 12-skill IG Grade 9 Listening Skills Framework:
   [Vocabulary in Context, Gist, Specific Info, Paraphrasing, Inference, Opinion/Attitude, Distractors, Multiple Speakers, Sequencing, Processing Speed, Answer Accuracy, Listening Strategies].
   Cite the exact audio transcript evidence, diagnose the distractor/trap that misled the student, and provide an actionable listening intervention strategy.

2. For READING, GRAMMAR & REWRITE mistakes:
   Cite the specific passage line or grammatical rule. Explain the misconception and contrast the student's answer directly with the official mark scheme.

3. For WRITING tasks:
   Summarize prompt fulfillment, missed criteria, and specific grammatical/cohesive recommendations.

Mistakes Data:
${JSON.stringify(mistakeItems, null, 2)}

Return valid JSON in this exact structure:
{
  "summary": {
    "total_questions": ${answers.length},
    "mistakes_count": ${mistakes.length},
    "overall_performance": "<concise paragraph summarizing performance trends and key areas for improvement>"
  },
  "diagnostics": [
    {
      "question_id": <number>,
      "section_type": "<listening|reading|grammar|writing>",
      "framework_skill": "<one of the 12 IG Listening Skills if listening, or relevant skill if reading/grammar>",
      "sub_skill": "<specific sub-skill descriptor>",
      "evidence_quote": "<verbatim transcript quote or passage line>",
      "misconception": "<explanation of why student was misled or where error occurred>",
      "intervention_strategy": "<specific pedagogical guidance for the student>"
    }
  ]
}`;

      for (const m of geminiModels) {
        try {
          const resp = await ai.models.generateContent({
            model: m,
            contents: diagPrompt,
            config: { responseMimeType: 'application/json' }
          });
          if (resp && resp.text) {
            diagnosticReport = JSON.parse(resp.text);
            break;
          }
        } catch (_) { }
      }
    }

    // Fallback diagnostic report
    if (!diagnosticReport) {
      if (mistakes.length === 0) {
        diagnosticReport = {
          summary: {
            total_questions: answers.length,
            mistakes_count: 0,
            overall_performance: 'Outstanding performance! Full marks achieved on all questions.'
          },
          diagnostics: []
        };
      } else {
        diagnosticReport = {
          summary: {
            total_questions: answers.length,
            mistakes_count: mistakes.length,
            overall_performance: `The candidate completed the exam with ${answers.length - mistakes.length}/${answers.length} correct responses.`
          },
          diagnostics: mistakes.map((m) => {
            const qIndex = answers.findIndex(a => Number(a.question_id) === Number(m.question_id));
            return {
              question_number: qIndex !== -1 ? (qIndex + 1) : undefined,
              question_id: m.question_id,
              section_type: m.section_type || 'general',
              framework_skill: m.section_type === 'listening' ? 'Answer Accuracy' : 'Reading Comprehension',
              sub_skill: 'Direct mark scheme contrast',
              evidence_quote: 'Official Mark Scheme Key',
              misconception: `Candidate answered "${m.student_answer || '(Blank)'}", which does not match the official key.`,
              intervention_strategy: 'Review mark scheme acceptable variations and focus keywords.'
            };
          })
        };
      }
    }

    // Attach sequential exam question_number (1..N) to all diagnostics
    if (diagnosticReport && Array.isArray(diagnosticReport.diagnostics)) {
      diagnosticReport.diagnostics.forEach((d) => {
        if (!d.question_number) {
          const qIndex = answers.findIndex(a => Number(a.question_id) === Number(d.question_id));
          if (qIndex !== -1) {
            d.question_number = qIndex + 1;
          }
        }
      });
    }

    // Recalculate total score
    const finalScore = answers.reduce((sum, a) => sum + (Number(a.points_awarded) || 0), 0);

    await db.execute({
      sql: `UPDATE online_test_attempts
            SET answers = ?, score = ?, diagnostic_report = ?, status = 'graded'
            WHERE id = ?`,
      args: [JSON.stringify(answers), finalScore, JSON.stringify(diagnosticReport), attemptId]
    });

    console.log(`[Online Test Grading Complete] Attempt ${attemptId} scored ${finalScore}/${attempt.max_score} - status: graded`);
  } catch (err) {
    console.error(`[Online Test Grading Background Exception Attempt ${attemptId}]:`, err);
  }
}

export { validateOnlineTestStructure, generateUniqueOnlineTestCode, getAuthoritativeTestOrCheckAuth, evaluateAndDiagnoseAttempt };
