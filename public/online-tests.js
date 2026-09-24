// ==========================================
// ONLINE-TESTS.JS - Teacher Review & Creation UI
// ==========================================

let onlineTestsList = [];
let currentReviewTest = null;
let currentReviewSections = [];
const pendingQuestionEdits = new Map();
const pendingSectionEdits = new Map();

// --- 1. Mode Switching & Listing ---

async function loadOnlineTestsList() {
  const container = document.getElementById('online-tests-grid');
  const emptyState = document.getElementById('online-tests-empty');
  const loadingIndicator = document.getElementById('online-tests-loading');

  if (loadingIndicator) loadingIndicator.style.display = 'block';
  if (emptyState) emptyState.style.display = 'none';

  try {
    const res = await fetch('/api/online-tests');
    if (!res.ok) throw new Error('Failed to fetch tests list.');
    const data = await res.json();
    onlineTestsList = data.tests || [];

    if (loadingIndicator) loadingIndicator.style.display = 'none';

    if (onlineTestsList.length === 0) {
      if (emptyState) emptyState.style.display = 'block';
      if (container) container.innerHTML = '';
      return;
    }

    if (emptyState) emptyState.style.display = 'none';
    renderOnlineTestsGrid();
  } catch (err) {
    if (loadingIndicator) loadingIndicator.style.display = 'none';
    console.error('Error loading online tests:', err);
    if (container) {
      container.innerHTML = `<div style="color:#DC2626; padding:16px; background:#FEF2F2; border-radius:8px;">Failed to load tests: ${escapeHtml(err.message)}</div>`;
    }
  }
}

function renderOnlineTestsGrid() {
  const container = document.getElementById('online-tests-grid');
  if (!container) return;

  container.innerHTML = onlineTestsList.map(test => {
    const isDraft = test.status === 'draft';
    const statusBadge = isDraft
      ? `<span class="ot-badge ot-badge-draft">Draft</span>`
      : `<span class="ot-badge ot-badge-published">Published</span>`;

    const deadlineText = test.deadline
      ? new Date(test.deadline).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
      : 'No deadline';

    const attemptsCount = Number(test.attempt_count || 0);
    const sectionsCount = Number(test.section_count || 0);
    const totalMarks = Number(test.total_marks || 0);

    return `
      <div class="ot-card" id="ot-card-${test.id}">
        <div class="ot-card-header">
          <div>
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
              ${statusBadge}
              <span class="ot-code-badge">${escapeHtml(test.code)}</span>
            </div>
            <h3 class="ot-card-title">${escapeHtml(test.title)}</h3>
          </div>
          <button class="ghost ghost-danger" style="padding:4px 8px; font-size:12px;" onclick="confirmDeleteOnlineTest(${test.id}, '${escapeHtml(test.title)}')">🗑️</button>
        </div>

        <div class="ot-card-meta">
          <span>📅 ${deadlineText}</span>
          <span>📑 ${sectionsCount} Section${sectionsCount === 1 ? '' : 's'}</span>
          <span>🎯 ${totalMarks} Total Marks</span>
          <span>👥 ${attemptsCount} Submission${attemptsCount === 1 ? '' : 's'}</span>
          ${test.audio_path ? '<span>🎧 Audio Attached</span>' : ''}
        </div>

        <div class="ot-card-actions" style="display:flex; gap:6px; flex-wrap:wrap;">
          <button class="primary" style="flex:1; min-width:110px; padding:8px 12px; font-size:13px;" onclick="openOnlineTestReview(${test.id})">
            ✏️ Edit & Review
          </button>
          <button class="ghost" style="padding:8px 12px; font-size:13px;" onclick="viewOnlineTestSubmissions(${test.id})">
            👥 Submissions (${attemptsCount})
          </button>
          <button class="ghost" style="padding:8px 12px; font-size:13px;" onclick="copyOnlineTestStudentLink('${escapeHtml(test.code)}')">
            📋 Copy Link
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function copyOnlineTestStudentLink(code) {
  const url = `${window.location.origin}/online-test.html?code=${encodeURIComponent(code)}`;
  navigator.clipboard.writeText(url).then(() => {
    showToast(`Student link copied: ${url}`);
  }).catch(() => {
    prompt('Copy student link:', url);
  });
}

function confirmDeleteOnlineTest(testId, title) {
  if (!confirm(`Are you sure you want to permanently delete the test "${title}"?\nAll sections, questions, and student attempts will be deleted.`)) {
    return;
  }

  fetch(`/api/online-tests/${testId}`, { method: 'DELETE' })
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        showToast('Online test deleted successfully.');
        loadOnlineTestsList();
      } else {
        alert(data.error || 'Failed to delete test.');
      }
    })
    .catch(err => {
      alert('Error deleting test: ' + err.message);
    });
}

// --- 2. Creation Modal & AI Generation ---

function openOnlineTestCreateModal() {
  const modal = document.getElementById('online-test-create-modal');
  if (!modal) return;
  modal.style.display = 'flex';

  // Reset inputs
  document.getElementById('ot-create-title').value = '';
  document.getElementById('ot-create-deadline').value = '';
  document.getElementById('ot-create-instructions').value = '';
  document.getElementById('ot-create-exam-file').value = '';
  document.getElementById('ot-create-scheme-file').value = '';
  document.getElementById('ot-create-audio-file').value = '';

  updateFileInputLabel('ot-create-exam-file', 'ot-label-exam');
  updateFileInputLabel('ot-create-scheme-file', 'ot-label-scheme');
  updateFileInputLabel('ot-create-audio-file', 'ot-label-audio');

  document.getElementById('ot-create-progress-box').style.display = 'none';
  document.getElementById('ot-create-submit-btn').disabled = false;
}

function closeOnlineTestCreateModal() {
  const modal = document.getElementById('online-test-create-modal');
  if (modal) modal.style.display = 'none';
}

function updateFileInputLabel(inputId, labelId) {
  const input = document.getElementById(inputId);
  const label = document.getElementById(labelId);
  if (!input || !label) return;

  if (input.files && input.files.length > 0) {
    const file = input.files[0];
    const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
    label.innerHTML = `<b>Selected:</b> ${escapeHtml(file.name)} <span style="color:#059669; font-weight:600;">(${sizeMb}MB)</span>`;
  } else {
    label.innerHTML = label.getAttribute('data-default-text') || 'Click or drop file here';
  }
}

async function handleOnlineTestCreateSubmit(event) {
  if (event) event.preventDefault();

  const title = (document.getElementById('ot-create-title').value || '').trim();
  const deadline = document.getElementById('ot-create-deadline').value;
  const extraInstructions = document.getElementById('ot-create-instructions').value;

  const examFile = document.getElementById('ot-create-exam-file').files[0];
  const schemeFile = document.getElementById('ot-create-scheme-file').files[0];
  const audioFile = document.getElementById('ot-create-audio-file').files[0];

  if (!title) {
    alert('Please enter a test title.');
    return;
  }
  if (!examFile) {
    alert('Please select an Exam Paper PDF file.');
    return;
  }
  if (!schemeFile) {
    alert('Please select a Marking Scheme PDF file.');
    return;
  }

  const formData = new FormData();
  formData.append('title', title);
  if (deadline) formData.append('deadline', deadline);
  if (extraInstructions) formData.append('extra_instructions', extraInstructions);
  formData.append('examPdf', examFile);
  formData.append('markingSchemePdf', schemeFile);
  if (audioFile) formData.append('audio', audioFile);

  const progressBox = document.getElementById('ot-create-progress-box');
  const progressText = document.getElementById('ot-create-progress-text');
  const submitBtn = document.getElementById('ot-create-submit-btn');

  progressBox.style.display = 'block';
  submitBtn.disabled = true;

  // Progressive status updates
  let stageTimer;
  progressText.innerText = 'Step 1/3: Uploading exam files & audio track...';

  stageTimer = setTimeout(() => {
    progressText.innerText = 'Step 2/3: Transcribing audio track & analyzing marking scheme...';
  }, 4000);

  const stageTimer2 = setTimeout(() => {
    progressText.innerText = 'Step 3/3: Deconstructing exam sections & matching mark scheme keys...';
  }, 12000);

  try {
    const response = await fetch('/api/online-tests/generate', {
      method: 'POST',
      body: formData
    });

    clearTimeout(stageTimer);
    clearTimeout(stageTimer2);

    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.error || 'Failed to generate online test.');
    }

    closeOnlineTestCreateModal();
    showToast(`Test created! Generated access code: ${result.code}`);

    // Load and open the review canvas directly
    await loadOnlineTestsList();
    openOnlineTestReview(result.test_id);
  } catch (err) {
    clearTimeout(stageTimer);
    clearTimeout(stageTimer2);
    progressBox.style.display = 'none';
    submitBtn.disabled = false;
    alert(`Creation Error: ${err.message}`);
  }
}

// --- 3. Review & Inline Editing Canvas ---

async function openOnlineTestReview(testId) {
  const listPane = document.getElementById('online-tests-list-view');
  const reviewCanvas = document.getElementById('online-test-review-canvas');
  const loading = document.getElementById('online-tests-review-loading');

  if (listPane) listPane.style.display = 'none';
  if (reviewCanvas) reviewCanvas.style.display = 'block';
  if (loading) loading.style.display = 'block';

  try {
    const res = await fetch(`/api/online-tests/${testId}`);
    if (!res.ok) throw new Error('Failed to load test details.');
    const data = await res.json();

    currentReviewTest = data.test;
    currentReviewSections = data.sections || [];

    if (loading) loading.style.display = 'none';
    renderOnlineTestReviewCanvas();
  } catch (err) {
    if (loading) loading.style.display = 'none';
    alert('Failed to load test: ' + err.message);
    backToOnlineTestsList();
  }
}

function backToOnlineTestsList() {
  const listPane = document.getElementById('online-tests-list-view');
  const reviewCanvas = document.getElementById('online-test-review-canvas');
  const submissionsView = document.getElementById('online-test-submissions-view');

  if (reviewCanvas) reviewCanvas.style.display = 'none';
  if (submissionsView) submissionsView.style.display = 'none';
  if (listPane) listPane.style.display = 'block';
  loadOnlineTestsList();
}

function renderOnlineTestReviewCanvas() {
  if (!currentReviewTest) return;

  const test = currentReviewTest;
  document.getElementById('ot-review-title').innerText = test.title;
  document.getElementById('ot-review-code').innerText = test.code;

  const statusBadge = document.getElementById('ot-review-status-badge');
  if (statusBadge) {
    statusBadge.className = test.status === 'draft' ? 'ot-badge ot-badge-draft' : 'ot-badge ot-badge-published';
    statusBadge.innerText = test.status === 'draft' ? 'Draft' : 'Published';
  }

  updateReviewTotalMarks();

  // Audio Player Bar
  const audioBar = document.getElementById('ot-review-audio-bar');
  const audioPlayer = document.getElementById('ot-review-audio-player');
  if (test.signed_audio_url && audioBar && audioPlayer) {
    audioBar.style.display = 'flex';
    audioPlayer.src = test.signed_audio_url;
  } else if (audioBar) {
    audioBar.style.display = 'none';
  }

  // Sections
  const sectionsContainer = document.getElementById('ot-review-sections-container');
  if (!sectionsContainer) return;

  if (currentReviewSections.length === 0) {
    sectionsContainer.innerHTML = '<div style="padding:20px; text-align:center; color:var(--ink-soft);">No sections found.</div>';
    return;
  }

  sectionsContainer.innerHTML = currentReviewSections.map((sec, sIdx) => {
    const secTypeBadge = getSectionTypeBadge(sec.section_type);
    const questionsHtml = (sec.questions || []).map((q, qIdx) => renderQuestionCard(sec.id, q, qIdx + 1)).join('');

    return `
      <div class="ot-section-card" id="ot-sec-${sec.id}">
        <div class="ot-section-header">
          <div style="display:flex; align-items:center; gap:10px; flex:1;">
            <span class="ot-part-badge">Part ${sec.part_number || (sIdx + 1)}</span>
            <input type="text" class="ot-section-title-input" value="${escapeHtml(sec.section_title)}"
              oninput="handleSectionTitleInput(${test.id}, ${sec.id}, this.value)" />
            ${secTypeBadge}
          </div>
          <button class="ghost" style="padding:4px 10px; font-size:12px;" onclick="addNewQuestionToSection(${test.id}, ${sec.id})">
            ➕ Add Question
          </button>
        </div>

        <div class="ot-stimulus-box">
          <div style="margin-bottom:8px;">
            <label class="ot-label">Instructions:</label>
            <textarea class="ot-textarea" rows="2" placeholder="e.g. For questions 1-5, choose the correct answer..."
              oninput="handleSectionInstructionsInput(${test.id}, ${sec.id}, this.value)">${escapeHtml(sec.instructions_text || '')}</textarea>
          </div>

          ${sec.passage_text !== undefined ? `
          <div style="margin-bottom:8px;">
            <label class="ot-label">Reading / Prompt Passage Text:</label>
            <textarea class="ot-textarea" rows="4" placeholder="Passage text for comprehension..."
              oninput="handleSectionPassageInput(${test.id}, ${sec.id}, this.value)">${escapeHtml(sec.passage_text || '')}</textarea>
          </div>
          ` : ''}

          ${sec.transcript ? `
          <details class="ot-transcript-details">
            <summary class="ot-transcript-summary">🎧 Verbatim Dialogue Transcript (${sec.transcript.length} chars)</summary>
            <pre class="ot-transcript-pre">${escapeHtml(sec.transcript)}</pre>
          </details>
          ` : ''}
        </div>

        <div class="ot-questions-list" id="ot-sec-questions-${sec.id}">
          ${questionsHtml}
        </div>
      </div>
    `;
  }).join('');
}

function getSectionTypeBadge(type) {
  const t = (type || 'general').toLowerCase();
  switch (t) {
    case 'listening': return '<span class="ot-type-badge ot-type-listening">🎧 Listening</span>';
    case 'reading': return '<span class="ot-type-badge ot-type-reading">📖 Reading</span>';
    case 'writing': return '<span class="ot-type-badge ot-type-writing">✍️ Writing</span>';
    case 'grammar': return '<span class="ot-type-badge ot-type-grammar">🔤 Grammar</span>';
    default: return '<span class="ot-type-badge">📝 General</span>';
  }
}

function renderQuestionCard(sectionId, q, displayNum) {
  const points = q.points || 1;
  const qType = q.question_type || 'mcq';

  let controlsHtml = '';

  if (qType === 'mcq') {
    const opts = Array.isArray(q.options) ? q.options : [];
    const correctIdx = Number(q.correct_answer) || 0;

    controlsHtml = `
      <div class="ot-mcq-options-container">
        <label class="ot-label">Options (Select radio for correct answer):</label>
        <div class="ot-options-list">
          ${opts.map((opt, oIdx) => `
            <div class="ot-option-row ${oIdx === correctIdx ? 'correct-opt' : ''}">
              <input type="radio" name="mcq-correct-${q.id}" ${oIdx === correctIdx ? 'checked' : ''}
                onchange="handleMcqOptionCorrectChange(${currentReviewTest.id}, ${q.id}, ${oIdx})" />
              <input type="text" class="ot-option-input" value="${escapeHtml(opt)}"
                oninput="handleMcqOptionTextInput(${currentReviewTest.id}, ${q.id}, ${oIdx}, this.value)" />
              <button type="button" class="ot-remove-opt-btn" onclick="removeMcqOption(${currentReviewTest.id}, ${q.id}, ${oIdx})">✕</button>
            </div>
          `).join('')}
        </div>
        <button type="button" class="ghost" style="margin-top:6px; font-size:11px; padding:3px 8px;"
          onclick="addMcqOption(${currentReviewTest.id}, ${q.id})">+ Add Option</button>
      </div>
    `;
  } else if (qType === 'matching') {
    const opts = Array.isArray(q.options) ? q.options : [];
    const correctIdx = Number(q.correct_answer) || 0;

    controlsHtml = `
      <div style="margin-top:8px;">
        <label class="ot-label">Shared Statement Match Pool:</label>
        <div style="display:flex; align-items:center; gap:8px; margin-top:4px;">
          <span style="font-size:12px; color:var(--ink-soft);">Correct Match:</span>
          <select class="ot-select" onchange="handleMatchingCorrectChange(${currentReviewTest.id}, ${q.id}, this.value)">
            ${opts.map((opt, oIdx) => `
              <option value="${oIdx}" ${oIdx === correctIdx ? 'selected' : ''}>Option ${oIdx + 1}: ${escapeHtml(opt.slice(0, 30))}</option>
            `).join('')}
          </select>
        </div>
      </div>
    `;
  } else if (['fill_blank', 'rewrite', 'short_answer'].includes(qType)) {
    let accepted = [];
    if (Array.isArray(q.correct_answer)) accepted = q.correct_answer;
    else if (typeof q.correct_answer === 'string') accepted = [q.correct_answer];

    controlsHtml = `
      <div style="margin-top:8px;">
        <label class="ot-label">Acceptable Answers (Comma-separated from Mark Scheme):</label>
        <input type="text" class="ot-input" value="${escapeHtml(accepted.join(', '))}"
          placeholder="e.g. 14, fourteen"
          oninput="handleAcceptableAnswersInput(${currentReviewTest.id}, ${q.id}, this.value)" />
      </div>
    `;
  } else if (qType === 'writing') {
    const rubric = typeof q.correct_answer === 'object' && q.correct_answer !== null ? q.correct_answer : {};
    const contentCriteria = Array.isArray(rubric.content_criteria) ? rubric.content_criteria.join('\n') : '';
    const langCriteria = Array.isArray(rubric.language_criteria) ? rubric.language_criteria.join('\n') : '';

    controlsHtml = `
      <div style="margin-top:8px; display:grid; grid-template-columns:1fr 1fr; gap:10px;">
        <div>
          <label class="ot-label">Min Words:</label>
          <input type="number" class="ot-input" value="${q.min_words || ''}" placeholder="None"
            oninput="handleWritingWordLimit(${currentReviewTest.id}, ${q.id}, 'min_words', this.value)" />
        </div>
        <div>
          <label class="ot-label">Max Words:</label>
          <input type="number" class="ot-input" value="${q.max_words || ''}" placeholder="None"
            oninput="handleWritingWordLimit(${currentReviewTest.id}, ${q.id}, 'max_words', this.value)" />
        </div>
      </div>
      <div style="margin-top:8px;">
        <label class="ot-label">Official Rubric Content Criteria (One per line):</label>
        <textarea class="ot-textarea" rows="2" oninput="handleRubricCriteriaChange(${currentReviewTest.id}, ${q.id}, 'content_criteria', this.value)">${escapeHtml(contentCriteria)}</textarea>
      </div>
      <div style="margin-top:8px;">
        <label class="ot-label">Language & Accuracy Criteria (One per line):</label>
        <textarea class="ot-textarea" rows="2" oninput="handleRubricCriteriaChange(${currentReviewTest.id}, ${q.id}, 'language_criteria', this.value)">${escapeHtml(langCriteria)}</textarea>
      </div>
    `;
  }

  return `
    <div class="ot-question-card" id="ot-q-${q.id}">
      <div class="ot-q-header">
        <div style="display:flex; align-items:center; gap:8px;">
          <span class="ot-q-num">Q${displayNum}</span>
          <span class="ot-badge" style="font-size:11px;">${qType.toUpperCase()}</span>
        </div>
        <div style="display:flex; align-items:center; gap:10px;">
          <div style="display:flex; align-items:center; gap:4px;">
            <label style="font-size:12px; color:var(--ink-soft);">Points:</label>
            <input type="number" step="0.5" min="0.5" class="ot-points-input" value="${points}"
              oninput="handleQuestionPointsInput(${currentReviewTest.id}, ${q.id}, this.value)" />
          </div>
          <button class="ghost ghost-danger" style="padding:2px 6px; font-size:12px;" onclick="deleteQuestion(${currentReviewTest.id}, ${q.id})">🗑️</button>
        </div>
      </div>

      <div style="margin-top:8px;">
        <label class="ot-label">Question Text:</label>
        <textarea class="ot-textarea" rows="2"
          oninput="handleQuestionTextInput(${currentReviewTest.id}, ${q.id}, this.value)">${escapeHtml(q.question_text || '')}</textarea>
      </div>

      ${controlsHtml}
    </div>
  `;
}

function updateReviewTotalMarks() {
  let total = 0;
  for (const s of currentReviewSections) {
    for (const q of (s.questions || [])) {
      total += Number(q.points || 0);
    }
  }
  const el = document.getElementById('ot-review-total-marks');
  if (el) el.innerText = total.toString();
}

// --- 4. Debounced Patching Pattern ---

function scheduleQuestionPatch(testId, questionId, field, value) {
  let entry = pendingQuestionEdits.get(questionId);
  if (!entry) {
    entry = { testId, questionId, patchData: {}, timer: null };
    pendingQuestionEdits.set(questionId, entry);
  }

  entry.patchData[field] = value;
  showAutosaveStatus('Saving...');

  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(async () => {
    try {
      const res = await fetch(`/api/online-tests/${entry.testId}/questions/${entry.questionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry.patchData)
      });
      if (!res.ok) throw new Error('Autosave failed.');
      showAutosaveStatus('Autosaved ✓');
      pendingQuestionEdits.delete(questionId);
    } catch (err) {
      console.error('Question patch error:', err);
      showAutosaveStatus('Error saving ✕');
    }
  }, 600);
}

function scheduleSectionPatch(testId, sectionId, field, value) {
  let entry = pendingSectionEdits.get(sectionId);
  if (!entry) {
    entry = { testId, sectionId, patchData: {}, timer: null };
    pendingSectionEdits.set(sectionId, entry);
  }

  entry.patchData[field] = value;
  showAutosaveStatus('Saving...');

  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(async () => {
    try {
      const res = await fetch(`/api/online-tests/${entry.testId}/sections/${entry.sectionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry.patchData)
      });
      if (!res.ok) throw new Error('Autosave failed.');
      showAutosaveStatus('Autosaved ✓');
      pendingSectionEdits.delete(sectionId);
    } catch (err) {
      console.error('Section patch error:', err);
      showAutosaveStatus('Error saving ✕');
    }
  }, 600);
}

function showAutosaveStatus(text) {
  const el = document.getElementById('ot-autosave-indicator');
  if (el) {
    el.innerText = text;
    el.style.opacity = '1';
    if (text.includes('✓')) {
      setTimeout(() => { if (el.innerText.includes('✓')) el.style.opacity = '0.7'; }, 2000);
    }
  }
}

// Handlers for interactive editing
function handleSectionTitleInput(testId, sectionId, val) {
  const sec = currentReviewSections.find(s => s.id === sectionId);
  if (sec) sec.section_title = val;
  scheduleSectionPatch(testId, sectionId, 'section_title', val);
}

function handleSectionInstructionsInput(testId, sectionId, val) {
  const sec = currentReviewSections.find(s => s.id === sectionId);
  if (sec) sec.instructions_text = val;
  scheduleSectionPatch(testId, sectionId, 'instructions_text', val);
}

function handleSectionPassageInput(testId, sectionId, val) {
  const sec = currentReviewSections.find(s => s.id === sectionId);
  if (sec) sec.passage_text = val;
  scheduleSectionPatch(testId, sectionId, 'passage_text', val);
}

function handleQuestionTextInput(testId, questionId, val) {
  const q = findQuestionInState(questionId);
  if (q) q.question_text = val;
  scheduleQuestionPatch(testId, questionId, 'question_text', val);
}

function handleQuestionPointsInput(testId, questionId, val) {
  const p = parseFloat(val);
  const pts = !isNaN(p) && p > 0 ? p : 1;
  const q = findQuestionInState(questionId);
  if (q) q.points = pts;
  updateReviewTotalMarks();
  scheduleQuestionPatch(testId, questionId, 'points', pts);
}

function handleMcqOptionCorrectChange(testId, questionId, correctIdx) {
  const q = findQuestionInState(questionId);
  if (q) q.correct_answer = correctIdx;

  const card = document.getElementById(`ot-q-${questionId}`);
  if (card) {
    card.querySelectorAll('.ot-option-row').forEach((row, idx) => {
      if (idx === correctIdx) row.classList.add('correct-opt');
      else row.classList.remove('correct-opt');
    });
  }

  scheduleQuestionPatch(testId, questionId, 'correct_answer', correctIdx);
}

function handleMcqOptionTextInput(testId, questionId, optIdx, val) {
  const q = findQuestionInState(questionId);
  if (q && Array.isArray(q.options)) {
    q.options[optIdx] = val;
    scheduleQuestionPatch(testId, questionId, 'options', q.options);
  }
}

function addMcqOption(testId, questionId) {
  const q = findQuestionInState(questionId);
  if (q) {
    if (!Array.isArray(q.options)) q.options = [];
    if (q.options.length >= 5) {
      alert('Maximum 5 options allowed.');
      return;
    }
    q.options.push(`Option ${String.fromCharCode(65 + q.options.length)}`);
    scheduleQuestionPatch(testId, questionId, 'options', q.options);
    renderOnlineTestReviewCanvas();
  }
}

function removeMcqOption(testId, questionId, optIdx) {
  const q = findQuestionInState(questionId);
  if (q && Array.isArray(q.options)) {
    if (q.options.length <= 2) {
      alert('MCQ questions must have at least 2 options.');
      return;
    }
    q.options.splice(optIdx, 1);
    if (q.correct_answer >= q.options.length) {
      q.correct_answer = 0;
      scheduleQuestionPatch(testId, questionId, 'correct_answer', 0);
    }
    scheduleQuestionPatch(testId, questionId, 'options', q.options);
    renderOnlineTestReviewCanvas();
  }
}

function handleMatchingCorrectChange(testId, questionId, val) {
  const idx = parseInt(val, 10) || 0;
  const q = findQuestionInState(questionId);
  if (q) q.correct_answer = idx;
  scheduleQuestionPatch(testId, questionId, 'correct_answer', idx);
}

function handleAcceptableAnswersInput(testId, questionId, val) {
  const list = val.split(',').map(s => s.trim()).filter(Boolean);
  const q = findQuestionInState(questionId);
  if (q) q.correct_answer = list;
  scheduleQuestionPatch(testId, questionId, 'correct_answer', list);
}

function handleWritingWordLimit(testId, questionId, field, val) {
  const num = parseInt(val, 10);
  const cleanVal = !isNaN(num) && num > 0 ? num : null;
  const q = findQuestionInState(questionId);
  if (q) q[field] = cleanVal;
  scheduleQuestionPatch(testId, questionId, field, cleanVal);
}

function handleRubricCriteriaChange(testId, questionId, field, val) {
  const lines = val.split('\n').map(s => s.trim()).filter(Boolean);
  const q = findQuestionInState(questionId);
  if (q) {
    if (!q.correct_answer || typeof q.correct_answer !== 'object') q.correct_answer = {};
    q.correct_answer[field] = lines;
    scheduleQuestionPatch(testId, questionId, 'correct_answer', q.correct_answer);
  }
}

function findQuestionInState(questionId) {
  for (const s of currentReviewSections) {
    for (const q of (s.questions || [])) {
      if (q.id === questionId) return q;
    }
  }
  return null;
}

async function addNewQuestionToSection(testId, sectionId) {
  try {
    const res = await fetch(`/api/online-tests/${testId}/sections/${sectionId}/questions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question_type: 'mcq', question_text: 'New Question Prompt' })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Failed to add question.');

    // Reload test to sync state
    const freshRes = await fetch(`/api/online-tests/${testId}`);
    const freshData = await freshRes.json();
    currentReviewSections = freshData.sections || [];
    renderOnlineTestReviewCanvas();
    showToast('Question added.');
  } catch (err) {
    alert('Error adding question: ' + err.message);
  }
}

async function deleteQuestion(testId, questionId) {
  if (!confirm('Are you sure you want to delete this question?')) return;

  try {
    const res = await fetch(`/api/online-tests/${testId}/questions/${questionId}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Failed to delete question.');

    // Remove from local state
    for (const s of currentReviewSections) {
      s.questions = (s.questions || []).filter(q => q.id !== questionId);
    }
    renderOnlineTestReviewCanvas();
    showToast('Question deleted.');
  } catch (err) {
    alert('Error deleting question: ' + err.message);
  }
}

// --- 5. Publishing Pipeline ---

async function publishOnlineTest(testId) {
  if (!testId && currentReviewTest) testId = currentReviewTest.id;
  if (!testId) return;

  const publishBtn = document.getElementById('btn-publish-online-test');
  if (publishBtn) publishBtn.disabled = true;

  try {
    const res = await fetch(`/api/online-tests/${testId}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json();

    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to publish test.');
    }

    if (currentReviewTest) currentReviewTest.status = 'published';
    const statusBadge = document.getElementById('ot-review-status-badge');
    if (statusBadge) {
      statusBadge.className = 'ot-badge ot-badge-published';
      statusBadge.innerText = 'Published';
    }

    showToast(`Test Published! Public link ready.`);
    copyOnlineTestStudentLink(data.code);
  } catch (err) {
    alert(`Publishing Blocked: ${err.message}`);
  } finally {
    if (publishBtn) publishBtn.disabled = false;
  }
}

// Helper escape
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// --- 4. Submissions View, Breakdown Modal & Printable Reports ---

let currentSubmissionsTestId = null;
let currentActiveAttempt = null;
let currentActiveSections = [];
const pendingAttemptOverrides = new Map();

function formatAcceptableKeys(correctAnswer) {
  if (Array.isArray(correctAnswer)) {
    return correctAnswer.map(k => String(k).trim()).filter(Boolean).join(' | ');
  }
  if (correctAnswer !== null && correctAnswer !== undefined) {
    return String(correctAnswer);
  }
  return '(None specified)';
}

async function viewOnlineTestSubmissions(testId) {
  currentSubmissionsTestId = testId;

  const listPane = document.getElementById('online-tests-list-view');
  const reviewCanvas = document.getElementById('online-test-review-canvas');
  const submissionsView = document.getElementById('online-test-submissions-view');
  const loading = document.getElementById('ot-submissions-loading');
  const emptyState = document.getElementById('ot-submissions-empty');
  const tableWrap = document.getElementById('ot-submissions-table-wrap');
  const tbody = document.getElementById('ot-submissions-tbody');

  if (listPane) listPane.style.display = 'none';
  if (reviewCanvas) reviewCanvas.style.display = 'none';
  if (submissionsView) submissionsView.style.display = 'block';

  if (loading) loading.style.display = 'block';
  if (emptyState) emptyState.style.display = 'none';
  if (tableWrap) tableWrap.style.display = 'none';
  if (tbody) tbody.innerHTML = '';

  try {
    const res = await fetch(`/api/online-tests/${testId}/attempts`);
    if (!res.ok) throw new Error('Failed to load student attempts.');
    const data = await res.json();

    if (loading) loading.style.display = 'none';

    const testTitleEl = document.getElementById('ot-submissions-test-title');
    if (testTitleEl) testTitleEl.innerText = data.test_title || 'Online Test Submissions';

    const countBadge = document.getElementById('ot-submissions-count-badge');
    const attempts = data.attempts || [];
    if (countBadge) countBadge.innerText = `${attempts.length} Attempt${attempts.length === 1 ? '' : 's'}`;

    if (attempts.length === 0) {
      if (emptyState) emptyState.style.display = 'block';
      if (tableWrap) tableWrap.style.display = 'none';
      return;
    }

    if (emptyState) emptyState.style.display = 'none';
    if (tableWrap) tableWrap.style.display = 'block';

    renderSubmissionsTable(attempts, testId);
  } catch (err) {
    if (loading) loading.style.display = 'none';
    alert('Error loading attempts: ' + err.message);
    backToOnlineTestsList();
  }
}

function refreshOnlineTestSubmissions() {
  if (currentSubmissionsTestId) {
    viewOnlineTestSubmissions(currentSubmissionsTestId);
  }
}

function renderSubmissionsTable(attempts, testId) {
  const tbody = document.getElementById('ot-submissions-tbody');
  if (!tbody) return;

  tbody.innerHTML = attempts.map(att => {
    const isGraded = att.status === 'graded';
    const statusBadge = isGraded
      ? `<span class="ot-badge ot-badge-published">Graded</span>`
      : `<span class="ot-badge ot-badge-draft" style="background:#FFFBEB; color:#B45309; border-color:#FDE68A;">Pending Review</span>`;

    const scoreDisplay = isGraded
      ? `<span class="ot-score-pill">${att.score} / ${att.max_score}</span>`
      : `<span class="ot-score-pill" style="opacity:0.75;">${att.score} / ${att.max_score} (Obj)</span>`;

    const duplicateWarning = att.possible_duplicate
      ? `<span class="ot-badge" style="background:#FEF2F2; color:#DC2626; border-color:#FECACA; font-size:11px; margin-left:6px;" title="Possible duplicate submission from same device/IP">⚠️ Dup</span>`
      : '';

    let proctorBadge = '';
    if (att.termination_reason === 'tab_switch_limit') {
      proctorBadge = `<span class="ot-badge" style="background:#FEF2F2; color:#DC2626; border-color:#FECACA; font-size:11px; margin-left:6px;" title="Terminated: 2 security infractions recorded (tab switch or fullscreen exit)">⛔ 2 Strikes</span>`;
    } else if (att.termination_reason === 'page_closed') {
      proctorBadge = `<span class="ot-badge" style="background:#FFFBEB; color:#B45309; border-color:#FDE68A; font-size:11px; margin-left:6px;" title="Auto-submitted on browser tab close or page navigation">🚪 Closed Page</span>`;
    } else if (att.termination_reason === 'timeout') {
      proctorBadge = `<span class="ot-badge" style="background:#EFF6FF; color:#1D4ED8; border-color:#BFDBFE; font-size:11px; margin-left:6px;" title="Submitted automatically when timer expired">⏳ Timeout</span>`;
    }

    const submittedDate = att.submitted_at
      ? new Date(att.submitted_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
      : 'Unknown';

    return `
      <tr style="border-bottom: 1px solid var(--border);">
        <td style="padding: 12px 14px; font-weight: 600; color: var(--ink);">
          ${escapeHtml(att.student_name)}
          ${duplicateWarning}
          ${proctorBadge}
        </td>
        <td style="padding: 12px 14px;">
          ${scoreDisplay}
        </td>
        <td style="padding: 12px 14px;">
          ${statusBadge}
        </td>
        <td style="padding: 12px 14px; font-size: 12.5px; color: var(--ink-soft); font-family: 'IBM Plex Mono', monospace;">
          ${submittedDate}
        </td>
        <td style="padding: 12px 14px; text-align: right; white-space: nowrap;">
          <button class="primary" style="padding: 6px 12px; font-size: 12px; margin-left:0; margin-top:0;" onclick="openAttemptDetailModal(${testId}, ${att.id})">
            👁️ Breakdown & Override
          </button>
          <button class="ghost" style="padding: 6px 10px; font-size: 12px; margin-left:4px;" onclick="printOnlineTestReport(${testId}, ${att.id}, 'full')" title="Print Full Report (With Marks)">
            🖨️ Full Report
          </button>
          <button class="ghost" style="padding: 6px 10px; font-size: 12px; margin-left:4px;" onclick="printOnlineTestReport(${testId}, ${att.id}, 'feedback')" title="Print Feedback Report (No Marks)">
            📋 Feedback
          </button>
          <button class="ghost ghost-danger" style="padding: 6px 8px; font-size: 12px; margin-left:4px;" onclick="deleteOnlineTestAttempt(${testId}, ${att.id})">
            🗑️
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

async function openAttemptDetailModal(testId, attemptId) {
  const modal = document.getElementById('online-test-attempt-modal');
  if (!modal) return;

  try {
    const res = await fetch(`/api/online-tests/${testId}/attempts/${attemptId}`);
    if (!res.ok) throw new Error('Failed to fetch attempt details.');
    const data = await res.json();

    currentActiveAttempt = data.attempt;
    currentActiveSections = data.sections || [];

    const attempt = data.attempt;
    document.getElementById('ot-modal-student-name').innerText = attempt.student_name;
    document.getElementById('ot-modal-test-title').innerText = data.test_title || 'Test Breakdown';

    const statusBadge = document.getElementById('ot-modal-status-badge');
    if (statusBadge) {
      statusBadge.className = attempt.status === 'graded' ? 'ot-badge ot-badge-published' : 'ot-badge ot-badge-draft';
      statusBadge.innerText = attempt.status === 'graded' ? 'Graded' : 'Pending Review';
    }

    updateModalScoreDisplay();

    // Proctoring & Security Alert Notice
    const proctorBox = document.getElementById('ot-modal-proctor-alert');
    if (proctorBox) {
      if (attempt.termination_reason && attempt.termination_reason !== 'normal') {
        let reasonLabel = attempt.termination_reason;
        let border = '#FECACA';
        let bg = '#FEF2F2';
        let color = '#991B1B';
        let icon = '⚠️';
        if (attempt.termination_reason === 'tab_switch_limit') {
          reasonLabel = 'Exceeded Proctoring Limit (Terminated on 2nd Strike - Tab Switch / Fullscreen Exit)';
          icon = '⛔';
        } else if (attempt.termination_reason === 'page_closed') {
          reasonLabel = 'Auto-Submitted upon Browser Close or Navigation Away from Test';
          border = '#FDE68A';
          bg = '#FFFBEB';
          color = '#92400E';
          icon = '🚪';
        } else if (attempt.termination_reason === 'timeout') {
          reasonLabel = 'Auto-Submitted when Exam Deadline / Countdown Expired';
          border = '#BFDBFE';
          bg = '#EFF6FF';
          color = '#1E40AF';
          icon = '⏳';
        }

        let violationsHtml = '';
        if (Array.isArray(attempt.security_violations) && attempt.security_violations.length > 0) {
          violationsHtml = `
            <div style="margin-top:8px; font-size:12px; font-family:'IBM Plex Mono',monospace;">
              <b>Logged Security Infractions:</b>
              <ul style="margin:4px 0 0 16px; padding:0;">
                ${attempt.security_violations.map((v, i) => `
                  <li>Strike ${v.strike || (i + 1)}: [${escapeHtml(v.type || '')}] ${escapeHtml(v.details || '')} (${v.timestamp ? new Date(v.timestamp).toLocaleTimeString() : ''})</li>
                `).join('')}
              </ul>
            </div>
          `;
        }

        proctorBox.innerHTML = `
          <div style="background:${bg}; border:1px solid ${border}; border-radius:8px; padding:12px 16px; color:${color}; font-size:13px;">
            <div style="display:flex; align-items:center; gap:8px; font-weight:700;">
              <span>${icon}</span>
              <span>Proctoring Alert: ${reasonLabel}</span>
            </div>
            ${violationsHtml}
          </div>
        `;
        proctorBox.style.display = 'block';
      } else {
        proctorBox.style.display = 'none';
        proctorBox.innerHTML = '';
      }
    }

    // Overall AI Diagnostic Summary
    const diagBox = document.getElementById('ot-modal-diag-summary');
    const diagText = document.getElementById('ot-modal-diag-summary-text');
    if (attempt.diagnostic_report?.summary?.overall_performance) {
      diagBox.style.display = 'block';
      let summaryHtml = `<div>${escapeHtml(attempt.diagnostic_report.summary.overall_performance)}</div>`;
      if (attempt.diagnostic_report.summary.mistakes_count !== undefined) {
        summaryHtml += `<div style="font-size:12px; color:var(--ink-soft); margin-top:6px;">Target Diagnostic Areas / Mistakes: <b>${attempt.diagnostic_report.summary.mistakes_count}</b></div>`;
      }
      diagText.innerHTML = summaryHtml;
    } else {
      diagBox.style.display = 'none';
    }

    renderAttemptQuestionsBreakdown(testId, attempt);
    modal.style.display = 'flex';
  } catch (err) {
    alert('Failed to open attempt: ' + err.message);
  }
}

function closeAttemptDetailModal() {
  const modal = document.getElementById('online-test-attempt-modal');
  if (modal) modal.style.display = 'none';
  const proctorBox = document.getElementById('ot-modal-proctor-alert');
  if (proctorBox) {
    proctorBox.style.display = 'none';
    proctorBox.innerHTML = '';
  }
  currentActiveAttempt = null;
  refreshOnlineTestSubmissions();
}

function renderAttemptQuestionsBreakdown(testId, attempt) {
  const container = document.getElementById('ot-modal-questions-list');
  if (!container) return;

  const answers = attempt.answers || [];
  const diagnosticsList = attempt.diagnostic_report?.diagnostics || [];

  container.innerHTML = answers.map((ans, qIdx) => {
    const qNum = qIdx + 1;
    const qType = ans.question_type || 'short_answer';
    const maxPts = Number(ans.max_points) || 1;
    const awardedPts = Number(ans.points_awarded) || 0;
    const isFullMarks = awardedPts >= maxPts;

    // Diagnostic item if present
    const diag = diagnosticsList.find(d => Number(d.question_id) === Number(ans.question_id));

    // Type badge label
    const typeLabel = qType === 'mcq' ? 'Multiple Choice'
      : qType === 'matching' ? 'Matching'
      : qType === 'fill_blank' ? 'Fill in Blank'
      : qType === 'rewrite' ? 'Rewrite / Sentence'
      : qType === 'writing' ? 'Writing / Extended Task'
      : 'Short Answer';

    let answerDetailsHtml = '';

    if (qType === 'mcq') {
      const options = Array.isArray(ans.options) ? ans.options : [];
      answerDetailsHtml = `
        <div style="display:flex; flex-direction:column; gap:6px; margin-top:8px;">
          ${options.map((opt, oIdx) => {
            const letter = String.fromCharCode(65 + oIdx);
            let optText = typeof opt === 'string' ? opt : (opt.text || opt.label || '');
            const isStudent = (ans.student_answer !== null && ans.student_answer !== undefined) &&
              (parseInt(ans.student_answer, 10) === oIdx || String(ans.student_answer).trim().toUpperCase() === letter);
            const isCorrect = (ans.correct_answer !== null && ans.correct_answer !== undefined) &&
              (parseInt(ans.correct_answer, 10) === oIdx || String(ans.correct_answer).trim().toUpperCase() === letter);

            let bg = '#F8FAFC';
            let border = 'var(--border)';
            let badgeHtml = '';

            if (isCorrect) {
              bg = '#ECFDF5';
              border = '#A7F3D0';
              badgeHtml += `<span class="ot-badge ot-badge-published" style="font-size:11px; margin-left:auto;">✓ Official Key</span>`;
            }
            if (isStudent) {
              if (isCorrect) {
                badgeHtml += `<span class="ot-badge ot-badge-published" style="font-size:11px; margin-left:4px;">Student Choice</span>`;
              } else {
                bg = '#FEF2F2';
                border = '#FECACA';
                badgeHtml += `<span class="ot-badge ot-badge-draft" style="font-size:11px; margin-left:auto; background:#FEE2E2; color:#DC2626; border-color:#FCA5A5;">✗ Student Choice</span>`;
              }
            }

            return `
              <div style="display:flex; align-items:center; gap:8px; padding:7px 10px; background:${bg}; border:1px solid ${border}; border-radius:6px; font-size:13px;">
                <b style="font-family:'IBM Plex Mono',monospace; width:22px;">(${letter})</b>
                <span style="flex:1;">${escapeHtml(optText)}</span>
                ${badgeHtml}
              </div>
            `;
          }).join('')}
        </div>
      `;
    } else if (qType === 'matching') {
      const options = Array.isArray(ans.options) ? ans.options : [];
      let studentText = '(No selection)';
      let correctText = '(No key)';

      const sIdx = parseInt(ans.student_answer, 10);
      if (!isNaN(sIdx) && options[sIdx]) {
        studentText = typeof options[sIdx] === 'string' ? options[sIdx] : (options[sIdx].text || options[sIdx].label || options[sIdx]);
      } else if (ans.student_answer) {
        studentText = String(ans.student_answer);
      }

      const cIdx = parseInt(ans.correct_answer, 10);
      if (!isNaN(cIdx) && options[cIdx]) {
        correctText = typeof options[cIdx] === 'string' ? options[cIdx] : (options[cIdx].text || options[cIdx].label || options[cIdx]);
      } else if (ans.correct_answer) {
        correctText = String(ans.correct_answer);
      }

      answerDetailsHtml = `
        <div style="margin-top:8px; display:flex; flex-direction:column; gap:6px;">
          <div style="font-size:13px;">
            <b>Student Match:</b>
            <span style="font-family:'IBM Plex Mono',monospace; padding:3px 8px; background:${isFullMarks ? '#ECFDF5' : '#FEF2F2'}; border:1px solid ${isFullMarks ? '#A7F3D0' : '#FECACA'}; border-radius:4px; font-weight:600;">
              ${escapeHtml(studentText)}
            </span>
          </div>
          <div style="font-size:13px; color:#059669;">
            <b>Official Correct Match:</b>
            <span style="font-family:'IBM Plex Mono',monospace; padding:3px 8px; background:#ECFDF5; border:1px solid #A7F3D0; border-radius:4px; font-weight:600;">
              ${escapeHtml(correctText)}
            </span>
          </div>
        </div>
      `;
    } else if (qType === 'writing') {
      const studentText = ans.student_answer || '(No response submitted)';
      const evalObj = ans.writing_evaluation || null;

      let rubricFeedbackHtml = '';
      if (evalObj) {
        const achieved = Array.isArray(evalObj.achieved_criteria) ? evalObj.achieved_criteria : [];
        const missed = Array.isArray(evalObj.missed_criteria) ? evalObj.missed_criteria : [];

        rubricFeedbackHtml = `
          <div style="margin-top:10px; background:#F8FAFC; border:1px solid var(--border); border-radius:8px; padding:12px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; flex-wrap:wrap; gap:8px;">
              <span style="font-size:12px; font-family:'IBM Plex Mono',monospace; font-weight:600; text-transform:uppercase; color:var(--pen);">
                Rubric Evaluation Breakdown
              </span>
              <div style="display:flex; gap:8px;">
                ${evalObj.content_score !== undefined ? `<span class="ot-code-badge" style="font-size:11.5px;">Content: ${evalObj.content_score}</span>` : ''}
                ${evalObj.language_score !== undefined ? `<span class="ot-code-badge" style="font-size:11.5px;">Language: ${evalObj.language_score}</span>` : ''}
              </div>
            </div>

            ${evalObj.commentary ? `<div style="font-size:13px; color:var(--ink); line-height:1.5; margin-bottom:10px; font-style:italic;">"${escapeHtml(evalObj.commentary)}"</div>` : ''}

            ${achieved.length > 0 ? `
              <div style="margin-bottom:6px;">
                <div style="font-size:11.5px; font-weight:600; color:#047857; margin-bottom:4px;">Achieved Criteria:</div>
                <div style="display:flex; flex-wrap:wrap; gap:4px;">
                  ${achieved.map(c => `<span style="background:#ECFDF5; color:#065F46; border:1px solid #A7F3D0; padding:2px 8px; border-radius:12px; font-size:11px;">✓ ${escapeHtml(c)}</span>`).join('')}
                </div>
              </div>
            ` : ''}

            ${missed.length > 0 ? `
              <div>
                <div style="font-size:11.5px; font-weight:600; color:#B91C1C; margin-bottom:4px;">Missed or Incomplete Requirements:</div>
                <div style="display:flex; flex-wrap:wrap; gap:4px;">
                  ${missed.map(m => `<span style="background:#FEF2F2; color:#991B1B; border:1px solid #FECACA; padding:2px 8px; border-radius:12px; font-size:11px;">✗ ${escapeHtml(m)}</span>`).join('')}
                </div>
              </div>
            ` : ''}
          </div>
        `;
      }

      answerDetailsHtml = `
        <div style="margin-top:8px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
            <span style="font-size:12px; font-weight:600; color:var(--ink-soft);">Student's Response:</span>
            <span class="ot-code-badge" style="font-size:11px;">📝 ${ans.word_count || 0} words ${ans.min_words ? `(Target: ${ans.min_words}–${ans.max_words || '∞'})` : ''}</span>
          </div>
          <div style="background:#fff; border:1px solid var(--border); border-radius:8px; padding:12px; font-family:'Source Serif 4',serif; font-size:13.5px; line-height:1.6; color:var(--ink); white-space:pre-wrap; max-height:220px; overflow-y:auto;">${escapeHtml(studentText)}</div>
          ${rubricFeedbackHtml}
        </div>
      `;
    } else {
      // fill_blank, short_answer, rewrite
      const studentAnsText = ans.student_answer || '(Blank)';
      const acceptableKeysText = formatAcceptableKeys(ans.correct_answer);

      answerDetailsHtml = `
        <div style="margin-top:8px; display:flex; flex-direction:column; gap:6px;">
          <div style="font-size:13px;">
            <b>Student Answer:</b>
            <code style="padding:3px 8px; background:${isFullMarks ? '#ECFDF5' : '#FEF2F2'}; border:1px solid ${isFullMarks ? '#A7F3D0' : '#FECACA'}; border-radius:4px; font-weight:600; color:${isFullMarks ? '#065F46' : '#991B1B'};">
              ${escapeHtml(studentAnsText)}
            </code>
          </div>
          <div style="font-size:13px; color:#059669;">
            <b>Acceptable Mark Scheme Key(s):</b>
            <code style="padding:3px 8px; background:#ECFDF5; border:1px solid #A7F3D0; border-radius:4px; font-weight:600; color:#047857;">
              ${escapeHtml(acceptableKeysText)}
            </code>
          </div>
        </div>
      `;
    }

    // Diagnostic Card HTML (if present)
    let diagCardHtml = '';
    if (diag) {
      if (diag.section_type === 'listening') {
        diagCardHtml = `
          <div class="ot-diag-card ot-diag-listening" style="margin-top:10px;">
            <div class="ot-diag-header">
              <span class="ot-diag-badge" style="background:#DBEAFE; color:#1E40AF;">🎯 IG Grade 9 Skill: ${escapeHtml(diag.framework_skill || 'Listening')}</span>
              ${diag.sub_skill ? `<span style="font-size:11.5px; color:#475569;">${escapeHtml(diag.sub_skill)}</span>` : ''}
            </div>
            ${diag.evidence_quote ? `<div class="ot-diag-evidence"><b>Verbatim Audio Transcript Evidence:</b><br/>"${escapeHtml(diag.evidence_quote)}"</div>` : ''}
            ${diag.misconception ? `<div class="ot-diag-misconception"><b>Distractor / Trap Diagnosis:</b> ${escapeHtml(diag.misconception)}</div>` : ''}
            ${diag.intervention_strategy ? `<div class="ot-diag-strategy"><b>Intervention Strategy:</b> ${escapeHtml(diag.intervention_strategy)}</div>` : ''}
          </div>
        `;
      } else if (diag.section_type === 'writing') {
        diagCardHtml = `
          <div class="ot-diag-card ot-diag-writing" style="margin-top:10px;">
            <div class="ot-diag-header">
              <span class="ot-diag-badge" style="background:#EDE9FE; color:#5B21B6;">✍️ Examiner Writing Assessment</span>
            </div>
            ${diag.misconception ? `<div class="ot-diag-misconception"><b>Assessment Note:</b> ${escapeHtml(diag.misconception)}</div>` : ''}
            ${diag.intervention_strategy ? `<div class="ot-diag-strategy"><b>Recommendation:</b> ${escapeHtml(diag.intervention_strategy)}</div>` : ''}
          </div>
        `;
      } else {
        // reading / grammar / rewrite
        diagCardHtml = `
          <div class="ot-diag-card ot-diag-reading" style="margin-top:10px;">
            <div class="ot-diag-header">
              <span class="ot-diag-badge" style="background:#FEF3C7; color:#92400E;">📖 ${diag.section_type === 'grammar' ? 'Grammar Rule' : 'Reading Clue'}: ${escapeHtml(diag.framework_skill || 'Passage Citation')}</span>
              ${diag.sub_skill ? `<span style="font-size:11.5px; color:#475569;">${escapeHtml(diag.sub_skill)}</span>` : ''}
            </div>
            ${diag.evidence_quote ? `<div class="ot-diag-evidence"><b>Passage / Rule Evidence:</b><br/>"${escapeHtml(diag.evidence_quote)}"</div>` : ''}
            ${diag.misconception ? `<div class="ot-diag-misconception"><b>Misconception Diagnosis:</b> ${escapeHtml(diag.misconception)}</div>` : ''}
            ${diag.intervention_strategy ? `<div class="ot-diag-strategy"><b>Pedagogical Strategy:</b> ${escapeHtml(diag.intervention_strategy)}</div>` : ''}
          </div>
        `;
      }
    }

    // Teacher feedback input
    const teacherFeedbackValue = ans.teacher_feedback || '';

    return `
      <div class="ot-question-card" id="ot-attempt-q-${ans.question_id}" style="background:var(--card); border:1px solid var(--border); border-radius:10px; padding:14px;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px; flex-wrap:wrap; gap:8px;">
          <div>
            <div style="display:flex; align-items:center; gap:6px; margin-bottom:3px;">
              <span class="ot-code-badge" style="font-size:11px;">Q${qNum}</span>
              <span style="font-size:11.5px; color:var(--ink-soft);">${escapeHtml(ans.section_title || typeLabel)}</span>
            </div>
            <div style="font-size:14px; font-weight:600; color:var(--ink);">${escapeHtml(ans.question_text || '')}</div>
          </div>

          <!-- Points & Teacher Override Input -->
          <div style="display:flex; align-items:center; gap:6px; background:#fff; border:1px solid var(--border); border-radius:8px; padding:4px 8px;">
            <span style="font-size:11.5px; color:var(--ink-soft); font-weight:600;">Marks:</span>
            <input type="number" min="0" max="${maxPts}" step="0.5"
              class="ot-score-override-input"
              value="${awardedPts}"
              data-question-id="${ans.question_id}"
              onchange="scheduleAttemptQuestionOverride(${testId}, ${attempt.id}, ${ans.question_id}, this.value)"
              title="Teacher Override: Edit awarded marks" />
            <span style="font-size:12px; font-family:'IBM Plex Mono',monospace; color:var(--ink-soft);">/ ${maxPts}</span>
          </div>
        </div>

        ${answerDetailsHtml}
        ${diagCardHtml}

        <!-- Optional Teacher Feedback Note -->
        <div style="margin-top:10px; border-top:1px dashed var(--border); padding-top:8px;">
          <input type="text"
            placeholder="Teacher comment / feedback for this question (optional)..."
            value="${escapeHtml(teacherFeedbackValue)}"
            onchange="scheduleAttemptFeedbackOverride(${testId}, ${attempt.id}, ${ans.question_id}, this.value)"
            style="width:100%; font-size:12.5px; padding:6px 10px; border:1px solid var(--border); border-radius:6px; background:#FAFAFA;" />
        </div>
      </div>
    `;
  }).join('');
}

function scheduleAttemptQuestionOverride(testId, attemptId, questionId, pointsVal) {
  const newPts = parseFloat(pointsVal);
  if (isNaN(newPts) || newPts < 0) return;

  // Optimistically update local active attempt
  if (currentActiveAttempt && currentActiveAttempt.answers) {
    const item = currentActiveAttempt.answers.find(a => Number(a.question_id) === Number(questionId));
    if (item) {
      item.points_awarded = newPts;
    }
    updateModalScoreDisplay();
  }

  const key = `pts_${attemptId}_${questionId}`;
  if (pendingAttemptOverrides.has(key)) {
    clearTimeout(pendingAttemptOverrides.get(key));
  }

  const timer = setTimeout(async () => {
    pendingAttemptOverrides.delete(key);
    try {
      const res = await fetch(`/api/online-tests/${testId}/attempts/${attemptId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question_id: questionId,
          points_awarded: newPts
        })
      });
      const data = await res.json();
      if (data.success) {
        showToast('Teacher marks override saved.');
        if (currentActiveAttempt) {
          currentActiveAttempt.score = data.score;
          updateModalScoreDisplay();
        }
      } else {
        alert(data.error || 'Failed to save score override.');
      }
    } catch (err) {
      console.error('Error saving question override:', err);
    }
  }, 500);

  pendingAttemptOverrides.set(key, timer);
}

function scheduleAttemptFeedbackOverride(testId, attemptId, questionId, feedbackVal) {
  const cleanFeedback = String(feedbackVal || '').trim();

  if (currentActiveAttempt && currentActiveAttempt.answers) {
    const item = currentActiveAttempt.answers.find(a => Number(a.question_id) === Number(questionId));
    if (item) item.teacher_feedback = cleanFeedback;
  }

  const key = `fb_${attemptId}_${questionId}`;
  if (pendingAttemptOverrides.has(key)) {
    clearTimeout(pendingAttemptOverrides.get(key));
  }

  const timer = setTimeout(async () => {
    pendingAttemptOverrides.delete(key);
    try {
      await fetch(`/api/online-tests/${testId}/attempts/${attemptId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question_id: questionId,
          teacher_feedback: cleanFeedback
        })
      });
      showToast('Teacher comment saved.');
    } catch (err) {
      console.error('Error saving teacher feedback:', err);
    }
  }, 600);

  pendingAttemptOverrides.set(key, timer);
}

function updateModalScoreDisplay() {
  if (!currentActiveAttempt) return;
  const answers = currentActiveAttempt.answers || [];
  const currentTotal = answers.reduce((sum, a) => sum + (Number(a.points_awarded) || 0), 0);
  const displayEl = document.getElementById('ot-modal-score-display');
  if (displayEl) {
    displayEl.innerText = `${currentTotal} / ${currentActiveAttempt.max_score}`;
  }
}

function printActiveAttemptReport(reportType) {
  if (currentActiveAttempt) {
    printOnlineTestReport(currentActiveAttempt.test_id, currentActiveAttempt.id, reportType);
  }
}

async function printOnlineTestReport(testId, attemptId, reportType) {
  let attempt = currentActiveAttempt;
  let testTitle = '';

  if (!attempt || Number(attempt.id) !== Number(attemptId)) {
    try {
      const res = await fetch(`/api/online-tests/${testId}/attempts/${attemptId}`);
      if (!res.ok) throw new Error('Failed to fetch attempt for printing.');
      const data = await res.json();
      attempt = data.attempt;
      testTitle = data.test_title;
    } catch (err) {
      alert('Failed to generate report: ' + err.message);
      return;
    }
  } else {
    const titleEl = document.getElementById('ot-modal-test-title');
    testTitle = titleEl ? titleEl.innerText : 'Online Test';
  }

  const isFeedbackOnly = reportType === 'feedback';
  const printContainer = document.getElementById('ot-print-container');
  if (!printContainer) return;

  const formattedDate = attempt.submitted_at
    ? new Date(attempt.submitted_at).toLocaleString([], { dateStyle: 'long', timeStyle: 'short' })
    : new Date().toLocaleString();

  const answers = attempt.answers || [];
  const diagnostics = attempt.diagnostic_report?.diagnostics || [];
  const overallSummary = attempt.diagnostic_report?.summary?.overall_performance || '';

  const reportSubtitle = isFeedbackOnly
    ? 'Pedagogical Diagnostic & Formative Feedback Report'
    : 'Comprehensive Student Assessment & Performance Report';

  // Build Diagnostic Error Log Table rows
  const errorLogRows = diagnostics.length > 0
    ? diagnostics.map((d, idx) => {
        return `
          <tr style="border-bottom: 1px solid #E5E7EB;">
            <td style="padding: 8px 10px; font-weight:600; font-family:'IBM Plex Mono',monospace; font-size:12px;">#${idx + 1} (Q${d.question_id || '–'})</td>
            <td style="padding: 8px 10px; font-size:12px;">
              <span style="font-weight:600; color:#1E3A8A;">${escapeHtml(d.framework_skill || d.section_type || 'Skill')}</span>
              ${d.sub_skill ? `<div style="font-size:11px; color:#4B5563;">${escapeHtml(d.sub_skill)}</div>` : ''}
            </td>
            <td style="padding: 8px 10px; font-size:11.5px; font-style:italic; color:#374151;">"${escapeHtml(d.evidence_quote || 'Mark Scheme Key')}"</td>
            <td style="padding: 8px 10px; font-size:12px; color:#B91C1C;">${escapeHtml(d.misconception || '–')}</td>
            <td style="padding: 8px 10px; font-size:12px; color:#047857; font-weight:500;">${escapeHtml(d.intervention_strategy || '–')}</td>
          </tr>
        `;
      }).join('')
    : `<tr><td colspan="5" style="padding:12px; text-align:center; color:#6B7280; font-style:italic;">No pedagogical errors identified. Full marks achieved across all criteria!</td></tr>`;

  // Build Questions Breakdown
  const questionsBreakdownHtml = answers.map((ans, qIdx) => {
    const qNum = qIdx + 1;
    const qType = ans.question_type || 'short_answer';
    const diag = diagnostics.find(d => Number(d.question_id) === Number(ans.question_id));

    let optionsHtml = '';
    if (qType === 'mcq' && Array.isArray(ans.options)) {
      optionsHtml = `
        <div style="margin-top:6px; display:flex; flex-direction:column; gap:4px;">
          ${ans.options.map((opt, oIdx) => {
            const letter = String.fromCharCode(65 + oIdx);
            const optText = typeof opt === 'string' ? opt : (opt.text || opt.label || '');
            const isStudent = (ans.student_answer !== null && ans.student_answer !== undefined) &&
              (parseInt(ans.student_answer, 10) === oIdx || String(ans.student_answer).trim().toUpperCase() === letter);
            const isCorrect = (ans.correct_answer !== null && ans.correct_answer !== undefined) &&
              (parseInt(ans.correct_answer, 10) === oIdx || String(ans.correct_answer).trim().toUpperCase() === letter);

            let marker = '○';
            let style = 'padding: 4px 8px; border-radius: 4px; font-size: 12px; border: 1px solid #E5E7EB;';
            if (isCorrect) {
              style += ' background: #ECFDF5; border-color: #A7F3D0; font-weight:600; color:#065F46;';
              marker = '✓';
            }
            if (isStudent && !isCorrect) {
              style += ' background: #FEF2F2; border-color: #FECACA; color:#991B1B;';
              marker = '✗';
            }

            return `
              <div style="${style}">
                <b>${marker} (${letter})</b> ${escapeHtml(optText)}
                ${isStudent ? '<span style="font-size:11px; margin-left:6px; font-weight:bold;">[Student]</span>' : ''}
                ${isCorrect ? '<span style="font-size:11px; margin-left:6px; font-weight:bold;">[Key]</span>' : ''}
              </div>
            `;
          }).join('')}
        </div>
      `;
    } else if (qType === 'writing') {
      optionsHtml = `
        <div style="margin-top:6px; background:#F9FAFB; border:1px solid #E5E7EB; border-radius:6px; padding:10px; font-size:12.5px; font-family:'Source Serif 4',serif; line-height:1.5;">
          <b>Candidate Response (${ans.word_count || 0} words):</b>
          <p style="margin:4px 0 0 0; white-space:pre-wrap;">${escapeHtml(ans.student_answer || '(Blank)')}</p>
        </div>
      `;
    } else {
      optionsHtml = `
        <div style="margin-top:6px; font-size:12px;">
          <div><b>Student Answer:</b> <code style="padding:2px 6px; background:#F3F4F6; border-radius:3px;">${escapeHtml(ans.student_answer || '(Blank)')}</code></div>
          <div style="margin-top:3px; color:#047857;"><b>Official Key(s):</b> <code style="padding:2px 6px; background:#ECFDF5; border-radius:3px;">${escapeHtml(formatAcceptableKeys(ans.correct_answer))}</code></div>
        </div>
      `;
    }

    return `
      <div style="border: 1px solid #E5E7EB; border-radius: 8px; padding: 12px; margin-bottom: 12px; page-break-inside: avoid;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:4px;">
          <div>
            <span style="font-weight:700; font-size:13px; color:#111827;">Q${qNum}. ${escapeHtml(ans.question_text || '')}</span>
            <div style="font-size:11px; color:#6B7280;">Section: ${escapeHtml(ans.section_title || 'General')} (${escapeHtml(qType)})</div>
          </div>
          <div class="ot-score-col" style="text-align:right;">
            <span style="font-family:'IBM Plex Mono',monospace; font-weight:700; font-size:13px; color:#1E3A8A;">${ans.points_awarded} / ${ans.max_points} pts</span>
          </div>
        </div>

        ${optionsHtml}

        ${diag ? `
          <div style="margin-top:8px; background:#F0FDF4; border:1px solid #BBF7D0; border-radius:6px; padding:8px 10px; font-size:11.5px; line-height:1.4;">
            <div style="font-weight:700; color:#15803D; margin-bottom:2px;">Examiner Diagnostic: [${escapeHtml(diag.framework_skill || diag.section_type)}]</div>
            ${diag.evidence_quote ? `<div><b>Evidence:</b> <i>"${escapeHtml(diag.evidence_quote)}"</i></div>` : ''}
            ${diag.misconception ? `<div><b>Diagnosis:</b> ${escapeHtml(diag.misconception)}</div>` : ''}
            ${diag.intervention_strategy ? `<div><b>Intervention Strategy:</b> ${escapeHtml(diag.intervention_strategy)}</div>` : ''}
          </div>
        ` : ''}

        ${ans.teacher_feedback ? `
          <div style="margin-top:6px; font-size:12px; color:#1E3A8A; font-style:italic;">
            <b>Teacher Feedback:</b> ${escapeHtml(ans.teacher_feedback)}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');

  printContainer.innerHTML = `
    <div class="report-sheet report-container" style="background:#fff; color:#111827; padding:24px 30px; font-family:'Inter',sans-serif; max-width:900px; margin:0 auto;">
      <!-- Header -->
      <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:2px solid #1E3A8A; padding-bottom:14px; margin-bottom:18px;">
        <div style="display:flex; align-items:center; gap:12px;">
          <img src="/mimir.jpg" alt="Mimir" style="width:48px; height:48px; border-radius:50%; object-fit:cover;" />
          <div>
            <h1 style="font-family:'Source Serif 4',serif; font-size:22px; margin:0; color:#111827; font-weight:700;">Mimir Marking Online Assessment</h1>
            <div style="font-size:12.5px; color:#4B5563; font-weight:500;">${reportSubtitle}</div>
          </div>
        </div>
        <div style="text-align:right;">
          <div class="ot-score-col" style="font-family:'IBM Plex Mono',monospace; font-size:20px; font-weight:700; color:#1E3A8A;">
            ${attempt.score} / ${attempt.max_score} <span style="font-size:13px; font-weight:600;">(${Math.round((attempt.score / (attempt.max_score || 1)) * 100)}%)</span>
          </div>
          <div style="font-size:11.5px; color:#6B7280; margin-top:2px;">EduPlanet Educational Services</div>
        </div>
      </div>

      <!-- Candidate & Test Details Card -->
      <div style="background:#F8FAFC; border:1px solid #E2E8F0; border-radius:8px; padding:12px 16px; margin-bottom:18px; display:flex; justify-content:space-between; flex-wrap:wrap; gap:10px; font-size:12.5px;">
        <div>
          <div><b>Candidate Name:</b> ${escapeHtml(attempt.student_name)}</div>
          <div><b>Test Title:</b> ${escapeHtml(testTitle)}</div>
        </div>
        <div>
          <div><b>Date Submitted:</b> ${formattedDate}</div>
          <div><b>Grading Status:</b> ${attempt.status === 'graded' ? 'Finalized / Graded' : 'Provisional / Pending Review'}</div>
          <div><b>Security Status:</b> ${(() => {
            if (attempt.termination_reason === 'tab_switch_limit') {
              return '<span style="color:#DC2626; font-weight:700;">⛔ Terminated: 2 Strikes (Tab Switch / Fullscreen Exit)</span>';
            } else if (attempt.termination_reason === 'page_closed') {
              return '<span style="color:#B45309; font-weight:600;">🚪 Auto-Submitted (Page Closed)</span>';
            } else if (attempt.termination_reason === 'timeout') {
              return '<span style="color:#1D4ED8; font-weight:600;">⏳ Auto-Submitted (Time Expired)</span>';
            }
            return '<span style="color:#059669; font-weight:600;">Verified Normal (No Violations)</span>';
          })()}</div>
        </div>
      </div>

      <!-- Executive Diagnostic Summary -->
      ${overallSummary ? `
        <div style="background:#EEF2FF; border:1px solid #C7D2FE; border-left:4px solid #1E3A8A; border-radius:8px; padding:12px 14px; margin-bottom:20px; font-size:13px; line-height:1.5;">
          <div style="font-size:11px; font-family:'IBM Plex Mono',monospace; font-weight:700; text-transform:uppercase; color:#1E3A8A; margin-bottom:4px;">
            Senior Examiner Diagnostic Summary
          </div>
          <div style="color:#1E293B;">${escapeHtml(overallSummary)}</div>
        </div>
      ` : ''}

      <!-- Questions & Feedback Section -->
      <div style="margin-bottom:24px;">
        <h2 style="font-family:'Source Serif 4',serif; font-size:16px; margin:0 0 12px 0; color:#111827; border-bottom:1px solid #E5E7EB; padding-bottom:6px;">
          Question-by-Question Response Analysis
        </h2>
        ${questionsBreakdownHtml}
      </div>

      <!-- Complete Diagnostic Error Log & Intervention Summary Table -->
      <div style="margin-top:28px; page-break-inside:avoid;">
        <h2 style="font-family:'Source Serif 4',serif; font-size:16px; margin:0 0 10px 0; color:#111827; border-bottom:1px solid #E5E7EB; padding-bottom:6px;">
          Pedagogical Diagnostic Error Log & Strategic Interventions
        </h2>
        <table style="width:100%; border-collapse:collapse; background:#fff; border:1px solid #E5E7EB; border-radius:6px; overflow:hidden;">
          <thead>
            <tr style="background:#F9FAFB; border-bottom:1px solid #E5E7EB; text-align:left; font-size:11.5px; text-transform:uppercase; color:#4B5563;">
              <th style="padding:8px 10px;">Item</th>
              <th style="padding:8px 10px;">Skill / Framework</th>
              <th style="padding:8px 10px;">Evidence (Audio/Passage)</th>
              <th style="padding:8px 10px;">Misconception / Distractor</th>
              <th style="padding:8px 10px;">Pedagogical Intervention</th>
            </tr>
          </thead>
          <tbody>
            ${errorLogRows}
          </tbody>
        </table>
      </div>

      <!-- Report Footer -->
      <div style="margin-top:30px; border-top:1px solid #E5E7EB; padding-top:10px; display:flex; justify-content:space-between; font-size:11px; color:#9CA3AF;">
        <span>Generated by Mimir Marking Dual Diagnostic Engine</span>
        <span>Strict Marking Scheme Standardized Grading</span>
      </div>
    </div>
  `;

  // Apply print CSS mode class
  document.body.classList.remove('printing-ot-full', 'printing-ot-feedback');
  if (isFeedbackOnly) {
    document.body.classList.add('printing-ot-feedback');
  } else {
    document.body.classList.add('printing-ot-full');
  }

  // Trigger print
  setTimeout(() => {
    window.print();
  }, 100);

  // Cleanup after print
  const cleanup = () => {
    document.body.classList.remove('printing-ot-full', 'printing-ot-feedback');
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  setTimeout(cleanup, 2500);
}

async function deleteOnlineTestAttempt(testId, attemptId) {
  if (!confirm('Are you sure you want to permanently delete this student submission?')) {
    return;
  }

  try {
    const res = await fetch(`/api/online-tests/${testId}/attempts/${attemptId}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (data.success) {
      showToast('Student submission deleted.');
      refreshOnlineTestSubmissions();
    } else {
      alert(data.error || 'Failed to delete submission.');
    }
  } catch (err) {
    alert('Error deleting submission: ' + err.message);
  }
}

// Window bindings
window.loadOnlineTestsList = loadOnlineTestsList;
window.openOnlineTestCreateModal = openOnlineTestCreateModal;
window.closeOnlineTestCreateModal = closeOnlineTestCreateModal;
window.handleOnlineTestCreateSubmit = handleOnlineTestCreateSubmit;
window.openOnlineTestReview = openOnlineTestReview;
window.backToOnlineTestsList = backToOnlineTestsList;
window.publishOnlineTest = publishOnlineTest;
window.copyOnlineTestStudentLink = copyOnlineTestStudentLink;
window.confirmDeleteOnlineTest = confirmDeleteOnlineTest;
window.updateFileInputLabel = updateFileInputLabel;
window.addNewQuestionToSection = addNewQuestionToSection;
window.deleteQuestion = deleteQuestion;
window.addMcqOption = addMcqOption;
window.removeMcqOption = removeMcqOption;
window.handleSectionTitleInput = handleSectionTitleInput;
window.handleSectionInstructionsInput = handleSectionInstructionsInput;
window.handleSectionPassageInput = handleSectionPassageInput;
window.handleQuestionTextInput = handleQuestionTextInput;
window.handleQuestionPointsInput = handleQuestionPointsInput;
window.handleMcqOptionCorrectChange = handleMcqOptionCorrectChange;
window.handleMcqOptionTextInput = handleMcqOptionTextInput;
window.handleMatchingCorrectChange = handleMatchingCorrectChange;
window.handleAcceptableAnswersInput = handleAcceptableAnswersInput;
window.handleWritingWordLimit = handleWritingWordLimit;
window.handleRubricCriteriaChange = handleRubricCriteriaChange;

window.viewOnlineTestSubmissions = viewOnlineTestSubmissions;
window.refreshOnlineTestSubmissions = refreshOnlineTestSubmissions;
window.openAttemptDetailModal = openAttemptDetailModal;
window.closeAttemptDetailModal = closeAttemptDetailModal;
window.scheduleAttemptQuestionOverride = scheduleAttemptQuestionOverride;
window.scheduleAttemptFeedbackOverride = scheduleAttemptFeedbackOverride;
window.printOnlineTestReport = printOnlineTestReport;
window.printActiveAttemptReport = printActiveAttemptReport;
window.deleteOnlineTestAttempt = deleteOnlineTestAttempt;

