// ==========================================
// SUBMISSIONS.JS - Viewing, Editing & Deleting
// ==========================================

// Map of submission ID -> pending edit state
// { code, subId, fields: {}, timer, lastEditedAt, inFlight }
const pendingEdits = new Map();

function stopLivePolling() {
  if (livePollTimer) {
    clearInterval(livePollTimer);
    livePollTimer = null;
  }
}

function isSubmissionProtected(subId) {
  const entry = pendingEdits.get(subId);
  if (!entry) return false;
  if (entry.inFlight) return true;
  if (Object.keys(entry.fields).length > 0) return true;
  if (Date.now() - entry.lastEditedAt < 5000) return true;
  return false;
}

function getContainerLinesText(idx, fieldName, modePrefix = 'portal', sourceContainer = null) {
  let container = sourceContainer ? (sourceContainer.classList && sourceContainer.classList.contains('line-list') ? sourceContainer : sourceContainer.closest?.('.line-list')) : null;
  if (!container) {
    const cardContainerId = `${modePrefix}-${fieldName === 'category_breakdown' ? 'bd' : fieldName === 'mistakes' ? 'm' : 'w'}-container-${idx}`;
    const summaryContainerId = `${modePrefix}-summary-${fieldName === 'category_breakdown' ? 'bd' : 'm'}-container-${idx}`;
    container = document.getElementById(cardContainerId) || document.getElementById(summaryContainerId);
  }
  if (!container) return '';
  const lines = Array.from(container.querySelectorAll('.line-item'))
    .map(el => el.innerText.trim())
    .filter(Boolean);
  return lines.join('\n');
}

function scheduleSubmissionPatch(idx, fieldName, sourceContainer = null) {
  if (typeof activeCode === 'undefined' || !activeCode) return;
  if (!portalSubmissions || !portalSubmissions[idx]) return;

  const sub = portalSubmissions[idx];
  const subId = sub.id;
  if (!subId) return;

  let fieldKey = fieldName;
  if (fieldName === 'name') fieldKey = 'student_name';

  // Extract fresh value from DOM / data model
  if (fieldKey === 'student_name') {
    const nameEl = document.querySelector(`.editable-field[data-idx="${idx}"][data-field="name"][data-mode="portal"]`);
    if (nameEl) {
      const val = nameEl.innerText.trim();
      sub.student_name = val;
      sub.name = val;
    }
  } else if (fieldKey === 'total_score') {
    const totalEl = document.getElementById(`portal-summary-total-${idx}`) || document.getElementById(`portal-total-score-val-${idx}`);
    if (totalEl) {
      sub.total_score = totalEl.innerText.trim();
    }
  } else if (['category_breakdown', 'mistakes', 'weaknesses'].includes(fieldKey)) {
    const text = getContainerLinesText(idx, fieldKey, 'portal', sourceContainer);
    sub[fieldKey] = text;
  }

  let entry = pendingEdits.get(subId);
  if (!entry) {
    entry = {
      subId,
      code: activeCode,
      fields: {},
      timer: null,
      lastEditedAt: Date.now(),
      inFlight: false
    };
    pendingEdits.set(subId, entry);
  }

  entry.lastEditedAt = Date.now();
  entry.code = activeCode;
  entry.fields[fieldKey] = sub[fieldKey];

  if (fieldKey === 'category_breakdown' && sub.total_score) {
    entry.fields.total_score = sub.total_score;
  }

  if (entry.timer) {
    clearTimeout(entry.timer);
  }

  entry.timer = setTimeout(() => {
    executeSubmissionPatch(subId);
  }, 800);
}

async function executeSubmissionPatch(subId) {
  const entry = pendingEdits.get(subId);
  if (!entry || Object.keys(entry.fields).length === 0) return;

  const payload = { ...entry.fields };
  entry.fields = {};
  entry.inFlight = true;

  try {
    const res = await fetch(`/api/assignments/${encodeURIComponent(entry.code)}/submissions/${encodeURIComponent(subId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Server error while saving.');
    }

    if (typeof showToast === 'function') {
      showToast('Saved');
    }
  } catch (err) {
    console.error('Error saving submission changes:', err);
    // Restore unsaved fields while keeping any newer edits made in-flight
    entry.fields = { ...payload, ...entry.fields };
    if (typeof showToast === 'function') {
      showToast(`Save failed: ${err.message}`);
    } else {
      alert(`Save failed: ${err.message}`);
    }
  } finally {
    entry.inFlight = false;
    entry.lastEditedAt = Date.now();
    // Keep protected for 5s grace period so polls don't immediately clobber
    setTimeout(() => {
      const cur = pendingEdits.get(subId);
      if (cur && !cur.inFlight && Object.keys(cur.fields).length === 0 && (Date.now() - cur.lastEditedAt >= 4500)) {
        pendingEdits.delete(subId);
      }
    }, 5000);
  }
}

function renderLineList(rawText, idx, fieldName, modePrefix = 'portal') {
  if (!rawText) return `<div class="line-item-wrap"><div class="line-item editable-line" contenteditable="true" data-idx="${idx}" data-field="${fieldName}" data-mode="${modePrefix}">- None</div><button class="line-delete-btn no-print" onclick="deleteLineItem(this, ${idx}, '${fieldName}', '${modePrefix}')" title="Delete item">&times;</button></div>`;
  
  const lines = rawText.split(/\n|(?=- Section)|(?=- Question)|(?=- Q\d)/g)
    .map(line => line.trim())
    .filter(line => line.length > 0);

  if (lines.length === 0) {
    return `<div class="line-item-wrap"><div class="line-item editable-line" contenteditable="true" data-idx="${idx}" data-field="${fieldName}" data-mode="${modePrefix}">- None</div><button class="line-delete-btn no-print" onclick="deleteLineItem(this, ${idx}, '${fieldName}', '${modePrefix}')" title="Delete item">&times;</button></div>`;
  }

  return lines.map(line => {
    const formatted = line.startsWith('-') ? line : `- ${line}`;
    return `
      <div class="line-item-wrap">
        <div contenteditable="true" class="line-item editable-line" data-idx="${idx}" data-field="${fieldName}" data-mode="${modePrefix}">${formatted}</div>
        <button class="line-delete-btn no-print" onclick="deleteLineItem(this, ${idx}, '${fieldName}', '${modePrefix}')" title="Delete item">&times;</button>
      </div>
    `;
  }).join('');
}

window.deleteLineItem = function(btn, idx, fieldName, modePrefix = 'portal') {
  const wrap = btn.closest('.line-item-wrap');
  const container = btn.closest('.line-list');
  if (wrap) {
    wrap.remove();
    const dataset = modePrefix === 'portal' ? portalSubmissions : manualResults;
    if (dataset && dataset[idx]) {
      dataset[idx][fieldName] = getContainerLinesText(idx, fieldName, modePrefix, container);
    }
    if (fieldName === 'category_breakdown') {
      recalculateTotal(idx, modePrefix, container);
    }
    if (modePrefix === 'portal') {
      scheduleSubmissionPatch(idx, fieldName, container);
    }
  }
};

window.addNewSectionLine = function(idx, fieldName, defaultPrefix = '- ', modePrefix = 'portal') {
  let containerId = `${modePrefix}-${fieldName === 'category_breakdown' ? 'bd' : fieldName === 'mistakes' ? 'm' : 'w'}-container-${idx}`;
  let summaryContainerId = `${modePrefix}-summary-${fieldName === 'category_breakdown' ? 'bd' : 'm'}-container-${idx}`;

  const container = document.getElementById(containerId);
  const summaryContainer = (fieldName === 'mistakes' || fieldName === 'category_breakdown') ? document.getElementById(summaryContainerId) : null;

  function createWrap() {
    const wrap = document.createElement('div');
    wrap.className = 'line-item-wrap';

    const newLine = document.createElement('div');
    newLine.className = 'line-item editable-line';
    newLine.contentEditable = 'true';
    newLine.dataset.idx = idx;
    newLine.dataset.field = fieldName;
    newLine.dataset.mode = modePrefix;
    newLine.textContent = defaultPrefix;

    newLine.addEventListener('input', (e) => {
      const lineContainer = e.target.closest('.line-list');
      const dataset = modePrefix === 'portal' ? portalSubmissions : manualResults;
      if (dataset && dataset[idx]) {
        dataset[idx][fieldName] = getContainerLinesText(idx, fieldName, modePrefix, lineContainer);
      }
      if (fieldName === 'category_breakdown') recalculateTotal(idx, modePrefix, lineContainer);
      if (modePrefix === 'portal') {
        scheduleSubmissionPatch(idx, fieldName, lineContainer);
      }
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'line-delete-btn no-print';
    delBtn.innerHTML = '&times;';
    delBtn.title = 'Delete item';
    delBtn.onclick = function() { deleteLineItem(delBtn, idx, fieldName, modePrefix); };

    wrap.appendChild(newLine);
    wrap.appendChild(delBtn);
    return { wrap, newLine };
  }

  if (container) {
    const { wrap, newLine } = createWrap();
    container.appendChild(wrap);
    newLine.focus();

    const range = document.createRange();
    const sel = window.getSelection();
    range.selectNodeContents(newLine);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  if (summaryContainer) {
    const { wrap } = createWrap();
    summaryContainer.appendChild(wrap);
  }
};

function recalculateTotal(idx, modePrefix = 'portal', sourceContainer = null) {
  let container = sourceContainer ? (sourceContainer.classList && sourceContainer.classList.contains('line-list') ? sourceContainer : sourceContainer.closest?.('.line-list')) : null;
  if (!container) {
    container = document.getElementById(`${modePrefix}-bd-container-${idx}`) || document.getElementById(`${modePrefix}-summary-bd-container-${idx}`);
  }
  if (!container) return;

  const lines = container.querySelectorAll('.line-item');
  let totalEarned = 0;
  let totalPossible = 0;
  let matchesFound = false;

  lines.forEach(line => {
    const text = line.innerText.trim();
    const match = text.match(/[:\s](\d+)\s*\/\s*(\d+)(?:\s|$)/) || text.match(/^[-•*]?\s*.*?(\d+)\s*\/\s*(\d+)$/);
    if (match) {
      totalEarned += parseInt(match[1], 10);
      totalPossible += parseInt(match[2], 10);
      matchesFound = true;
    }
  });

  if (matchesFound && totalPossible > 0) {
    const newTotal = `${totalEarned}/${totalPossible}`;
    const dataset = modePrefix === 'portal' ? portalSubmissions : manualResults;
    if (dataset[idx]) dataset[idx].total_score = newTotal;

    const cardScore = document.getElementById(`${modePrefix}-card-score-${idx}`);
    const badge = document.getElementById(`${modePrefix}-badge-${idx}`);
    const summaryTotal = document.getElementById(`${modePrefix}-summary-total-${idx}`);
    const totalEl = document.getElementById(`${modePrefix}-total-score-val-${idx}`);

    if (cardScore) cardScore.innerText = newTotal;
    if (badge) badge.innerText = `${totalEarned}`;
    if (summaryTotal) summaryTotal.innerText = newTotal;
    if (totalEl) totalEl.innerText = newTotal;

    if (modePrefix === 'portal') {
      scheduleSubmissionPatch(idx, 'total_score');
      scheduleSubmissionPatch(idx, 'category_breakdown', container);
    }
  }
}

function renderCardsAndSummaryTable(dataList, modePrefix = 'portal') {
  const summaryTbody = document.getElementById(modePrefix === 'portal' ? 'portal-summary-table-body' : 'summary-table-body');
  const resultsContainer = document.getElementById(modePrefix === 'portal' ? 'portal-results-list' : 'results');

  const openCardIndices = new Set();
  resultsContainer.querySelectorAll('.result-body.open').forEach(el => {
    const card = el.closest('.result-card');
    const head = card ? card.querySelector('.result-head') : null;
    if (head && head.dataset.idx !== undefined) {
      openCardIndices.add(head.dataset.idx);
    }
  });

  summaryTbody.innerHTML = '';
  resultsContainer.innerHTML = '';

  if (!dataList || !dataList.length) {
    summaryTbody.innerHTML = '<tr><td colspan="3" style="text-align:center; color:var(--ink-soft); padding:20px;">No student submissions available yet.</td></tr>';
    return;
  }

  dataList.forEach((r, idx) => {
    const displayName = r.name || r.student_name || 'Student';
    const totalScoreVal = r.total_score || '—';

    const peerPill = getIntegrityPill('Peer Copy', r.similarity_score);
    const aiPill = getIntegrityPill('AI Match', r.ai_score);
    const webPill = r.web_score && r.web_score > 25 ? `<span class="pill-badge pill-amber">Web: ${r.web_score}%</span>` : '';
    const dupPill = r.possible_duplicate ? `<span class="pill-badge pill-red" title="Multiple submissions from same IP within 10 minutes">⚠️ Duplicate</span>` : '';

    const tr = document.createElement('tr');
    tr.id = `${modePrefix}-summary-tr-${idx}`;
    tr.innerHTML = `
      <td class="summary-col-name">
        <div style="display: flex; justify-content: space-between; align-items: flex-start;">
          <div>
            <b contenteditable="true" class="editable-field" data-idx="${idx}" data-field="name" data-mode="${modePrefix}">${displayName}</b><br>
            <div class="integrity-pills no-print">${peerPill} ${aiPill} ${webPill} ${dupPill}</div>
          </div>
          ${modePrefix === 'portal' && r.id ? `
            <button class="line-delete-btn no-print" onclick="deleteStudentSubmission('${r.id}', '${escapeHtml(displayName)}')" title="Delete submission & allow student to resubmit" style="font-size: 15px; color: #DC2626; padding: 2px 4px; cursor: pointer;">🗑️</button>
          ` : ''}
        </div>
        <small class="summary-score-tag" style="color:var(--pen); font-family:'IBM Plex Mono',monospace; margin-top:2px; display:inline-block;">
          Total: <span contenteditable="true" class="editable-field" id="${modePrefix}-summary-total-${idx}" data-idx="${idx}" data-field="total_score" data-mode="${modePrefix}">${totalScoreVal}</span> (${r.pageCount || 1} page${r.pageCount > 1 ? 's' : ''})
        </small>
      </td>
      <td class="col-score-breakdown">
        <div class="line-list" id="${modePrefix}-summary-bd-container-${idx}">${renderLineList(r.category_breakdown, idx, 'category_breakdown', modePrefix)}</div>
        <button class="table-add-btn no-print" onclick="addNewSectionLine(${idx}, 'category_breakdown', '- Section: 0/10', '${modePrefix}')">+ Add Section</button>
      </td>
      <td class="summary-col-mistakes">
        <div class="line-list" id="${modePrefix}-summary-m-container-${idx}">${renderLineList(r.mistakes, idx, 'mistakes', modePrefix)}</div>
        <button class="table-add-btn no-print" onclick="addNewSectionLine(${idx}, 'mistakes', '- ', '${modePrefix}')">+ Add Mistake</button>
      </td>
    `;
    summaryTbody.appendChild(tr);

    const isOpen = openCardIndices.has(String(idx));

    const card = document.createElement('div');
    card.className = 'result-card';
    card.innerHTML = `
      <div class="result-head" data-idx="${idx}" data-mode="${modePrefix}">
        <div class="badge card-score-badge" id="${modePrefix}-badge-${idx}">${totalScoreVal.split('/')[0]}</div>
        <div class="result-name" id="${modePrefix}-card-name-${idx}">
          ${displayName} 
          <span style="font-size:12px; font-weight:normal; color:var(--ink-soft);">(${r.pageCount || 1} page${r.pageCount > 1 ? 's' : ''})</span>
          <div class="integrity-pills" style="margin-top: 3px;">${peerPill} ${aiPill} ${dupPill}</div>
        </div>
        <div class="result-score card-score-text" id="${modePrefix}-card-score-${idx}">${totalScoreVal}</div>
      </div>
      <div class="result-body ${isOpen ? 'open' : ''}" id="${modePrefix}-body-${idx}">
        <div class="result-body-inner">
          <div class="fb-section fb-integrity-box no-print" style="background:#F8FAFC; border:1px solid var(--border); border-radius:8px; padding:12px; margin-bottom:14px;">
            <div class="fb-label">🛡️ Academic Integrity & Similarity Audit <span class="edit-hint">(Visible to Teacher Only)</span></div>
            <div style="font-size:12px; color:var(--ink-soft); line-height:1.6;">
              <div>• <b>Classmate Overlap:</b> ${r.similarity_score || 0}% match — <i>${escapeHtml(r.similarity_details || 'No duplicate passages found among classmates.')}</i></div>
              ${r.possible_duplicate ? `<div>• <b style="color:#DC2626;">⚠️ Duplicate Submission Flag:</b> <span style="background:#FEE2E2; color:#DC2626; border:1px solid #FCA5A5; padding:1px 6px; border-radius:4px; font-weight:600; font-size:11px;">Possible Duplicate</span> — <i>Another submission from this IP address was recorded within 10 minutes.</i></div>` : ''}
              <div>• <b>AI-Generation Risk:</b> ${r.ai_score || 0}% — <i>${escapeHtml(r.ai_details || 'Writing matches natural student cadence.')}</i></div>
              <div>• <b>Web Source Plagiarism:</b> ${r.web_score || 0}% similarity to public archives</div>
            </div>
          </div>

          <div class="fb-section fb-score-section">
            <div class="fb-label">
              <span>Score Breakdown by Category <span class="edit-hint">(Edit marks below to auto-update total)</span></span>
            </div>
            <div class="line-list" id="${modePrefix}-bd-container-${idx}">${renderLineList(r.category_breakdown, idx, 'category_breakdown', modePrefix)}</div>
            <button class="section-add-btn no-print" onclick="addNewSectionLine(${idx}, 'category_breakdown', '- Section: 0/10', '${modePrefix}')">+ Add Category</button>
          </div>

          <div class="fb-section fb-score-section">
            <div class="fb-label">Total Score</div>
            <b id="${modePrefix}-total-score-val-${idx}">${totalScoreVal}</b>
          </div>

          <div class="fb-section">
            <div class="fb-label">
              <span>Mistakes in Your Work <span class="edit-hint">(Click text to edit or ✕ to remove)</span></span>
            </div>
            <div class="line-list" id="${modePrefix}-m-container-${idx}">${renderLineList(r.mistakes, idx, 'mistakes', modePrefix)}</div>
            <button class="section-add-btn mistake-theme no-print" onclick="addNewSectionLine(${idx}, 'mistakes', '- ', '${modePrefix}')">+ Add Mistake</button>
          </div>

          <div class="fb-section">
            <div class="fb-label">
              <span>What to Practice Next <span class="edit-hint">(Click text to edit or ✕ to remove)</span></span>
            </div>
            <div class="line-list" id="${modePrefix}-w-container-${idx}">${renderLineList(r.weaknesses, idx, 'weaknesses', modePrefix)}</div>
            <button class="section-add-btn practice-theme no-print" onclick="addNewSectionLine(${idx}, 'weaknesses', '- ', '${modePrefix}')">+ Add Recommendation</button>
          </div>
        </div>
      </div>
    `;
    resultsContainer.appendChild(card);
  });

  document.querySelectorAll(`.editable-line[data-mode="${modePrefix}"]`).forEach(el => {
    el.addEventListener('input', e => {
      const idx = e.target.dataset.idx;
      const field = e.target.dataset.field;
      const container = e.target.closest('.line-list');
      const dataset = modePrefix === 'portal' ? portalSubmissions : manualResults;
      if (dataset && dataset[idx]) {
        dataset[idx][field] = getContainerLinesText(idx, field, modePrefix, container);
      }
      if (field === 'category_breakdown') recalculateTotal(idx, modePrefix, container);
      if (modePrefix === 'portal') {
        scheduleSubmissionPatch(idx, field, container);
      }
    });
  });

  document.querySelectorAll(`.editable-field[data-mode="${modePrefix}"]`).forEach(el => {
    el.addEventListener('input', e => {
      const idx = e.target.dataset.idx;
      const field = e.target.dataset.field;
      const newValue = e.target.innerText.trim();
      const dataset = modePrefix === 'portal' ? portalSubmissions : manualResults;

      if (dataset[idx]) {
        if (field === 'name') {
          dataset[idx].name = newValue;
          dataset[idx].student_name = newValue;
          const cardName = document.getElementById(`${modePrefix}-card-name-${idx}`);
          if (cardName) cardName.innerHTML = `${newValue} <span style="font-size:12px; font-weight:normal; color:var(--ink-soft);">(${dataset[idx].pageCount || 1} page${dataset[idx].pageCount > 1 ? 's' : ''})</span>`;
          if (modePrefix === 'portal') {
            scheduleSubmissionPatch(idx, 'student_name');
          }
        } else if (field === 'total_score') {
          dataset[idx].total_score = newValue;
          const cardScore = document.getElementById(`${modePrefix}-card-score-${idx}`);
          const totalScoreValEl = document.getElementById(`${modePrefix}-total-score-val-${idx}`);
          const badge = document.getElementById(`${modePrefix}-badge-${idx}`);

          if (cardScore) cardScore.innerText = newValue;
          if (totalScoreValEl) totalScoreValEl.innerText = newValue;
          if (badge) badge.innerText = newValue.split('/')[0] || newValue;
          if (modePrefix === 'portal') {
            scheduleSubmissionPatch(idx, 'total_score');
          }
        }
      }
    });
  });

  resultsContainer.querySelectorAll('.result-head').forEach(head => {
    head.addEventListener('click', () => {
      const idx = head.dataset.idx;
      const mode = head.dataset.mode;
      const body = document.getElementById(`${mode}-body-${idx}`);
      if (body) body.classList.toggle('open');
    });
  });
}

function startLivePolling() {
  if (livePollTimer) clearInterval(livePollTimer);
  fetchLiveSubmissions();
  livePollTimer = setInterval(fetchLiveSubmissions, 10000);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (livePollTimer) {
      clearInterval(livePollTimer);
      livePollTimer = null;
    }
  } else {
    if (activeCode) {
      startLivePolling();
    }
  }
});

let isPollingActive = false;

async function fetchLiveSubmissions() {
  if (!activeCode || isPollingActive) return;

  const activeEl = document.activeElement;
  if (activeEl && (activeEl.isContentEditable || activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
    return;
  }

  isPollingActive = true;
  try {
    const res = await fetch(`/api/assignments/${encodeURIComponent(activeCode)}/submissions`);
    const d = await res.json();
    if (d.success) {
      const incoming = d.submissions || [];

      // Merge poll results without clobbering fields with unsaved-but-pending or recent local edits
      portalSubmissions = incoming.map(inc => {
        const local = (portalSubmissions || []).find(p => p.id === inc.id);
        if (local && isSubmissionProtected(inc.id)) {
          return {
            ...inc,
            student_name: local.student_name !== undefined ? local.student_name : inc.student_name,
            name: local.name !== undefined ? local.name : inc.name,
            total_score: local.total_score !== undefined ? local.total_score : inc.total_score,
            category_breakdown: local.category_breakdown !== undefined ? local.category_breakdown : inc.category_breakdown,
            mistakes: local.mistakes !== undefined ? local.mistakes : inc.mistakes,
            weaknesses: local.weaknesses !== undefined ? local.weaknesses : inc.weaknesses,
          };
        }
        return inc;
      });

      renderCardsAndSummaryTable(portalSubmissions, 'portal');

      const teacherDisplay = (currentUser && currentUser.name) ? currentUser.name : 'Teacher';
      const studentCount = portalSubmissions.length;
      const countText = `${studentCount} Student${studentCount === 1 ? '' : 's'}`;
      const subEl = document.getElementById('portal-print-report-sub');
      if (subEl) subEl.textContent = `Teacher: ${teacherDisplay} | Total Assessed: ${countText}`;
    }
  } catch (e) {
    console.warn('Live poll sync notice');
  } finally {
    isPollingActive = false;
  }
}

// Native direct report printing with combined title
function printReport(type) {
  if (!portalSubmissions || portalSubmissions.length === 0) {
    alert('No student submissions found to print.');
    return;
  }

  const fullReportTitle = typeof getFullActiveTitle === 'function' ? getFullActiveTitle() : (activeCode || 'Assignment');
  const teacherDisplay = (currentUser && currentUser.name) ? currentUser.name : 'Teacher';
  const studentCount = portalSubmissions.length;
  const countText = `${studentCount} Student${studentCount === 1 ? '' : 's'}`;

  document.querySelectorAll('#portal-results-list .result-body').forEach(b => b.classList.add('open'));
  document.body.classList.add('printing-portal');
  document.body.classList.remove('printing-manual');

  const reportTitleEl = document.getElementById('portal-print-report-title');
  const reportSubEl = document.getElementById('portal-print-report-sub');

  if (type === 'feedback') {
    document.body.classList.add('print-feedback-only');
    if (reportTitleEl) reportTitleEl.textContent = `Student Feedback & Correction Report: ${fullReportTitle}`;
  } else {
    document.body.classList.remove('print-feedback-only');
    if (reportTitleEl) reportTitleEl.textContent = `Class Evaluation Summary: ${fullReportTitle}`;
  }

  if (reportSubEl) {
    reportSubEl.textContent = `Teacher: ${teacherDisplay} | Total Assessed: ${countText}`;
  }
  
  setTimeout(() => {
    window.print();
    setTimeout(() => { 
      document.body.classList.remove('print-feedback-only');
      document.body.classList.remove('printing-portal');
    }, 1000);
  }, 250);
}

// Remove single student submission strictly by numeric ID
async function deleteStudentSubmission(subId, studentName) {
  const numericId = parseInt(subId, 10);
  if (!activeCode || isNaN(numericId) || numericId <= 0) {
    alert('Unable to identify submission record ID.');
    return;
  }

  const confirmed = await showConfirmModal(
    `Delete submission for "${studentName}"? This removes their evaluation and unlocks them to submit their paper again.`,
    'Remove Student Submission'
  );
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/assignments/${encodeURIComponent(activeCode)}/submissions/${numericId}`, { 
      method: 'DELETE' 
    });
    const d = await res.json();
    if (d.success) {
      pendingEdits.delete(numericId);
      showToast(d.message);
      await fetchLiveSubmissions();
      if (typeof loadTeacherAssignments === 'function') {
        await loadTeacherAssignments();
      }
    } else {
      alert(d.error || 'Failed to remove submission.');
    }
  } catch (err) {
    alert('Network error while deleting submission.');
  }
}

// Open and load submission timestamp audit logs
async function toggleSubmissionLogsModal() {
  const modal = document.getElementById('submission-logs-modal');
  if (modal.style.display === 'flex') {
    modal.style.display = 'none';
    return;
  }

  if (!activeCode) {
    alert('Please select or create an assignment first.');
    return;
  }

  modal.style.display = 'flex';
  const tbody = document.getElementById('submission-logs-tbody');
  tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:12px;">Loading timestamps...</td></tr>';

  try {
    const res = await fetch(`/api/assignments/${activeCode}/logs`);
    const d = await res.json();
    if (d.success && d.logs && d.logs.length > 0) {
      tbody.innerHTML = d.logs.map(log => {
        const dateObj = new Date(log.submitted_at);
        const formattedDate = !isNaN(dateObj.getTime())
          ? new Intl.DateTimeFormat('en-US', {
              timeZone: 'Africa/Cairo',
              dateStyle: 'medium',
              timeStyle: 'short'
            }).format(dateObj)
          : log.submitted_at;

        return `
          <tr>
            <td><b>${escapeHtml(log.student_name)}</b></td>
            <td>${escapeHtml(log.assignment_title || '—')}</td>
            <td>${escapeHtml(log.teacher_name || '—')}</td>
            <td><code style="font-family:'IBM Plex Mono',monospace;">${formattedDate}</code></td>
          </tr>
        `;
      }).join('');
    } else {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#666; padding:14px;">No submission logs recorded yet.</td></tr>';
    }
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#DC2626; padding:14px;">Failed to load logs.</td></tr>';
  }
}

// Global window exports
window.renderCardsAndSummaryTable = renderCardsAndSummaryTable;
window.startLivePolling = startLivePolling;
window.stopLivePolling = stopLivePolling;
window.fetchLiveSubmissions = fetchLiveSubmissions;
window.printReport = printReport;
window.deleteStudentSubmission = deleteStudentSubmission;
window.toggleSubmissionLogsModal = toggleSubmissionLogsModal;
window.deleteLineItem = deleteLineItem;
window.addNewSectionLine = addNewSectionLine;
window.recalculateTotal = recalculateTotal;
