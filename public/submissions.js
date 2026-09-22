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
  if (typeof stopMcqLivePolling === 'function') {
    stopMcqLivePolling();
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
    if (typeof stopMcqLivePolling === 'function') {
      stopMcqLivePolling();
    }
  } else {
    if (typeof activeViewMode !== 'undefined' && activeViewMode === 'mcq') {
      if (typeof activeMcqCode !== 'undefined' && activeMcqCode && typeof startMcqLivePolling === 'function') {
        startMcqLivePolling();
      }
    } else if (activeCode) {
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

// ==========================================
// REPORT PRINTING & DIAGNOSTIC UTILITIES
// ==========================================

function getAuthHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const token = (typeof localStorage !== 'undefined' && localStorage.getItem('token')) ||
                (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('token'));
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

function ensurePrintStylesInjected() {
  let styleEl = document.getElementById('mimir-report-print-styles');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'mimir-report-print-styles';
    styleEl.textContent = `
      html, body {
        overflow: visible !important;
        height: auto !important;
        min-height: 100% !important;
      }
      .report-sheet, .printable-report, .report-container {
        overflow: visible !important;
        height: auto !important;
        max-height: none !important;
        box-shadow: none !important;
        page-break-inside: auto;
      }
      .report-table-wrapper, .table-responsive, .breakdown-box {
        overflow: visible !important;
        max-height: none !important;
      }
      @media print {
        body, .report-container, .report-table-wrapper {
          overflow: visible !important;
          height: auto !important;
        }
      }
    `;
    document.head.appendChild(styleEl);
  }
}

function resizeReportIframes() {
  document.querySelectorAll('iframe').forEach((iframe) => {
    try {
      const doc = iframe.contentWindow?.document || iframe.contentDocument;
      if (doc && doc.body) {
        iframe.style.height = `${doc.body.scrollHeight + 30}px`;
        iframe.style.maxHeight = 'none';
        iframe.style.overflow = 'visible';
      }
    } catch (_) {}
  });
}

const inFlightDiagnostics = new Set();

async function autoTriggerListeningDiagnostics(testId, attemptId) {
  try {
    const res = await fetch(`/api/mcq/${testId}/attempts/${attemptId}/diagnose`, {
      method: 'POST',
      headers: getAuthHeaders()
    });
    const d = await res.json();
    if (d.success) {
      if (typeof fetchLiveMcqAttempts === 'function') {
        await fetchLiveMcqAttempts();
      }
    }
  } catch (err) {
    console.warn('Auto-diagnostic trigger failed for attempt', attemptId, err);
  } finally {
    setTimeout(() => {
      inFlightDiagnostics.delete(attemptId);
    }, 30000);
  }
}

function resolveMcqQuestionAnswers(q, rawStudentVal, optionLetters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']) {
  const qType = q.question_type || 'mcq';
  let isMistake = false;
  let isUnanswered = false;
  let html = '';
  let studentDisplayText = '';
  let correctDisplayText = '';

  if (qType === 'fill_blank') {
    const studentAns = (rawStudentVal !== undefined && rawStudentVal !== null) ? String(rawStudentVal).trim() : '';
    const acceptable = Array.isArray(q.acceptable_answers) ? q.acceptable_answers : [];
    const normStudent = studentAns.toLowerCase().replace(/['"]/g, '');
    const isCorrect = normStudent !== '' && acceptable.some((a) => (a || '').toString().trim().toLowerCase().replace(/['"]/g, '') === normStudent);

    studentDisplayText = studentAns || '(empty)';
    correctDisplayText = `[${acceptable.join(', ')}]`;

    if (!studentAns) {
      isMistake = true;
      isUnanswered = true;
      html = `⚪ <span style="color: #6B7280;">(empty)</span> &rarr; Expected: <strong style="color: #166534;">[${escapeHtml(acceptable.join(', '))}]</strong>`;
    } else if (isCorrect) {
      html = `<span style="font-weight: 700; color: #166534;">✓</span> <strong style="color: #166534;">"${escapeHtml(studentAns)}"</strong>`;
    } else {
      isMistake = true;
      html = `<span style="font-weight: 700; color: #991b1b;">✕</span> <del style="color: #991b1b;">"${escapeHtml(studentAns)}"</del> &rarr; Correct: <strong style="color: #166534;">[${escapeHtml(acceptable.join(', '))}]</strong>`;
    }
  } else if (qType === 'matching') {
    const studentAns = (rawStudentVal !== undefined && rawStudentVal !== null && rawStudentVal !== '') ? rawStudentVal : -1;
    const studentNum = Number(studentAns);
    const correctAns = q.correct_index;
    const correctNum = Number(correctAns);

    const isAnswered = studentAns !== -1 && !isNaN(studentNum) && studentNum >= 0;
    const isCorrect = isAnswered && studentNum === correctNum;

    const studentText = isAnswered
      ? ((q.options && q.options[studentNum] !== undefined) ? q.options[studentNum] : (optionLetters[studentNum] || `Option ${studentNum + 1}`))
      : '(unanswered)';
    const correctText = (q.options && q.options[correctNum] !== undefined)
      ? q.options[correctNum]
      : (optionLetters[correctNum] || `Option ${correctNum + 1}`);

    studentDisplayText = studentText;
    correctDisplayText = correctText;

    if (!isAnswered) {
      isMistake = true;
      isUnanswered = true;
      html = `⚪ <span style="color: #6B7280;">Unanswered</span> &bull; Correct: <strong style="color: #166534;">${escapeHtml(correctText)}</strong>`;
    } else if (isCorrect) {
      html = `<span style="font-weight: 700; color: #166534;">✓</span> <strong style="color: #166534;">${escapeHtml(correctText)}</strong>`;
    } else {
      isMistake = true;
      html = `<span style="font-weight: 700; color: #991b1b;">✕</span> <del style="color: #991b1b;">${escapeHtml(studentText)}</del> &rarr; Correct: <strong style="color: #166534;">${escapeHtml(correctText)}</strong>`;
    }
  } else {
    // Standard MCQ
    const studentAns = (rawStudentVal !== undefined && rawStudentVal !== null && rawStudentVal !== '') ? rawStudentVal : -1;
    const studentNum = Number(studentAns);
    const correctAns = q.correct_index;
    const correctNum = Number(correctAns);

    const isAnswered = studentAns !== -1 && !isNaN(studentNum) && studentNum >= 0;
    const isCorrect = isAnswered && studentNum === correctNum;

    const studentText = isAnswered
      ? ((q.options && q.options[studentNum] !== undefined) ? q.options[studentNum] : (optionLetters[studentNum] || `Option ${studentNum + 1}`))
      : '(unanswered)';
    const correctText = (q.options && q.options[correctNum] !== undefined)
      ? q.options[correctNum]
      : (optionLetters[correctNum] || `Option ${correctNum + 1}`);

    studentDisplayText = studentText;
    correctDisplayText = correctText;

    if (!isAnswered) {
      isMistake = true;
      isUnanswered = true;
      html = `⚪ <span style="color: #6B7280;">Unanswered</span> &bull; Correct: <strong style="color: #166534;">${escapeHtml(correctText)}</strong>`;
    } else if (isCorrect) {
      html = `<span style="font-weight: 700; color: #166534;">✓</span> <strong style="color: #166534;">${escapeHtml(correctText)}</strong>`;
    } else {
      isMistake = true;
      html = `<span style="font-weight: 700; color: #991b1b;">✕</span> <del style="color: #991b1b;">${escapeHtml(studentText)}</del> &rarr; Correct: <strong style="color: #166534;">${escapeHtml(correctText)}</strong>`;
    }
  }

  return {
    isMistake,
    isUnanswered,
    html,
    studentDisplayText,
    correctDisplayText
  };
}

function generateMcqPrintableReport(type = 'full') {
  if (!mcqAttemptsData || mcqAttemptsData.length === 0) {
    alert('No student MCQ submissions found to print.');
    return;
  }

  ensurePrintStylesInjected();

  const isListening = Boolean(activeMcqTestObj && activeMcqTestObj.audio_path);
  const baseTitle = (activeMcqTestObj && activeMcqTestObj.title) ? activeMcqTestObj.title : (activeMcqCode || 'MCQ Assessment');
  const fullReportTitle = isListening ? `${baseTitle} (🎧 Listening Assessment)` : baseTitle;
  const teacherDisplay = (currentUser && currentUser.name) ? currentUser.name : 'Teacher';
  const studentCount = mcqAttemptsData.length;
  const countText = `${studentCount} Student${studentCount === 1 ? '' : 's'}`;

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

  if (reportSubEl) reportSubEl.textContent = `Teacher: ${teacherDisplay} | Total Assessed: ${countText}`;

  // For listening assessments, append the IG Grade 9 Listening Skills Diagnostic Log table to portal-results-list
  const resultsContainer = document.getElementById('portal-results-list');
  if (resultsContainer) {
    if (isListening) {
      const diagnosticLogsHtml = mcqAttemptsData.map((att) => {
        let diags = att.diagnostic_feedback;
        if (typeof diags === 'string') {
          try { diags = JSON.parse(diags); } catch (_) { diags = []; }
        }
        if (!Array.isArray(diags) || diags.length === 0) return '';

        return `
          <div class="result-card print-diagnostic-log report-sheet printable-report" style="page-break-before: always; margin-top: 24px; padding-top: 10px; overflow: visible !important; max-height: none !important; box-shadow: none !important;">
            <div style="border-bottom: 2px solid var(--pen); padding-bottom: 8px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: baseline;">
              <h3 style="font-family: 'Source Serif 4', serif; font-size: 18px; margin: 0; color: var(--ink);">
                🎧 IG Grade 9 Listening Skills Diagnostic Log &mdash; ${escapeHtml(att.student_name || 'Student')}
              </h3>
              ${type !== 'feedback' ? `<span style="font-family: 'IBM Plex Mono', monospace; font-size: 14px; font-weight: 700; color: var(--pen);">${escapeHtml(att.score || '')}</span>` : ''}
            </div>
            <table class="summary-table report-table-wrapper" style="width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 11.5px; overflow: visible !important; max-height: none !important;">
              <thead>
                <tr style="background: #F3F4F6;">
                  <th style="width: 7%; padding: 6px 8px; border: 1px solid #777;">Question</th>
                  <th style="width: 15%; padding: 6px 8px; border: 1px solid #777;">Your Answer</th>
                  <th style="width: 15%; padding: 6px 8px; border: 1px solid #777;">Correct Answer</th>
                  <th style="width: 13%; padding: 6px 8px; border: 1px solid #777;">Main Skill</th>
                  <th style="width: 13%; padding: 6px 8px; border: 1px solid #777;">Sub-Skill</th>
                  <th style="width: 17%; padding: 6px 8px; border: 1px solid #777;">Audio Evidence</th>
                  <th style="width: 20%; padding: 6px 8px; border: 1px solid #777;">Strategy / Intervention</th>
                </tr>
              </thead>
              <tbody>
                ${diags.map((diag, dIdx) => {
                  let qNum = diag.question_number || diag.question_id || (dIdx + 1);
                  let studentAns = diag.student_answer;
                  let correctAns = diag.correct_answer;

                  if (!studentAns || studentAns.length <= 2 || !correctAns || correctAns.length <= 2) {
                    const q = (mcqQuestionsData || []).find((x, qIndex) =>
                      Number(x.id) === Number(diag.question_id) ||
                      Number(x.order_index) === Number(diag.question_id) ||
                      (qIndex + 1) === Number(qNum)
                    );
                    if (q) {
                      const res = resolveMcqQuestionAnswers(q, att.answers && att.answers[q.id]);
                      if (!studentAns || studentAns.length <= 2) studentAns = res.studentDisplayText;
                      if (!correctAns || correctAns.length <= 2) correctAns = res.correctDisplayText;
                    }
                  }

                  return `
                    <tr>
                      <td style="padding: 6px 8px; border: 1px solid #777; font-family: 'IBM Plex Mono', monospace; font-weight: 600;">Q${escapeHtml(String(qNum))}</td>
                      <td style="padding: 6px 8px; border: 1px solid #777; color: #991B1B; font-weight: 500;">${escapeHtml(studentAns || '—')}</td>
                      <td style="padding: 6px 8px; border: 1px solid #777; color: #065F46; font-weight: 600;">${escapeHtml(correctAns || '—')}</td>
                      <td style="padding: 6px 8px; border: 1px solid #777; font-weight: 600;">${escapeHtml(diag.main_skill || 'Listening Strategy')}</td>
                      <td style="padding: 6px 8px; border: 1px solid #777;">${escapeHtml(diag.sub_skill || '—')}</td>
                      <td style="padding: 6px 8px; border: 1px solid #777; font-style: italic;">"${escapeHtml(diag.spoken_quote || '—')}"</td>
                      <td style="padding: 6px 8px; border: 1px solid #777;">
                        ${diag.diagnosis_and_strategy ? `<div><b>Strategy:</b> ${escapeHtml(diag.diagnosis_and_strategy)}</div>` : ''}
                        ${diag.intervention ? `<div style="margin-top: 4px; color: #166534;"><b>Recommended Drill:</b> ${escapeHtml(diag.intervention)}</div>` : ''}
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        `;
      }).filter(Boolean).join('');

      resultsContainer.innerHTML = diagnosticLogsHtml;
    } else {
      resultsContainer.innerHTML = '';
    }
  }

  resizeReportIframes();

  setTimeout(() => {
    window.print();
    setTimeout(() => {
      document.body.classList.remove('printing-portal');
      document.body.classList.remove('print-feedback-only');
      if (resultsContainer && isListening) {
        resultsContainer.innerHTML = '';
      }
    }, 1000);
  }, 250);
}

// Native direct report printing with combined title
function printReport(type) {
  if (typeof activeViewMode !== 'undefined' && activeViewMode === 'mcq') {
    return generateMcqPrintableReport(type);
  }

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

// ==========================================
// STAGE 5: MCQ TEACHER RESULTS INTEGRATION
// ==========================================

let activeViewMode = 'essay';
let activeMcqCode = null;
let activeMcqTestObj = null;
let mcqAttemptsData = [];
let mcqQuestionsData = [];
let mcqLivePollTimer = null;
let isMcqPollingActive = false;

function stopMcqLivePolling() {
  if (mcqLivePollTimer) {
    clearInterval(mcqLivePollTimer);
    mcqLivePollTimer = null;
  }
}

function startMcqLivePolling() {
  stopMcqLivePolling();
  fetchLiveMcqAttempts();
  mcqLivePollTimer = setInterval(fetchLiveMcqAttempts, 10000);
}

function switchSubmissionsView(mode) {
  activeViewMode = mode;
  const btnEssay = document.getElementById('btn-sub-view-essay');
  const btnMcq = document.getElementById('btn-sub-view-mcq');
  const selectEssay = document.getElementById('past-assignments-select');
  const selectMcq = document.getElementById('mcq-tests-select');
  const btnLogs = document.getElementById('portal-btn-logs') || document.getElementById('btn-view-logs');
  const bundleTabs = document.getElementById('bundle-task-tabs');
  const btnEditDdl = document.getElementById('portal-btn-edit-deadline');
  const btnManageBundle = document.getElementById('portal-btn-manage-bundle');
  const btnDelForm = document.getElementById('portal-btn-delete-form');

  if (mode === 'mcq') {
    if (btnMcq) {
      btnMcq.style.background = '#fff';
      btnMcq.style.color = 'var(--pen)';
      btnMcq.style.boxShadow = '0 1px 2px rgba(0,0,0,0.06)';
    }
    if (btnEssay) {
      btnEssay.style.background = 'transparent';
      btnEssay.style.color = 'var(--ink-soft)';
      btnEssay.style.boxShadow = 'none';
    }
    if (selectEssay) selectEssay.style.display = 'none';
    if (selectMcq) selectMcq.style.display = 'block';

    // Issue 1: Hide "View Submission Logs" button in MCQ view
    if (btnLogs) btnLogs.style.display = 'none';

    // Issue 2: Explicitly hide and empty package task tabs container
    if (bundleTabs) {
      bundleTabs.style.display = 'none';
      bundleTabs.innerHTML = '';
    }

    // Issue 2: Hide essay-only controls
    if (btnEditDdl) btnEditDdl.style.display = 'none';
    if (btnManageBundle) btnManageBundle.style.display = 'none';
    if (btnDelForm) btnDelForm.style.display = 'none';

    // Show delete MCQ test button if test is currently selected
    const btnDeleteMcq = document.getElementById('btn-delete-mcq-test');
    if (btnDeleteMcq) {
      btnDeleteMcq.style.display = (activeMcqCode && activeMcqTestObj) ? 'inline-block' : 'none';
    }

    if (typeof stopLivePolling === 'function') stopLivePolling();
    loadTeacherMcqTests();

    if (activeMcqCode && selectMcq) {
      selectMcq.value = activeMcqCode;
      loadSelectedMcqTest(activeMcqCode);
    } else {
      const resultsCard = document.getElementById('portal-results-card');
      if (resultsCard) resultsCard.style.display = 'none';
    }
  } else {
    // Essay mode
    if (btnEssay) {
      btnEssay.style.background = '#fff';
      btnEssay.style.color = 'var(--pen)';
      btnEssay.style.boxShadow = '0 1px 2px rgba(0,0,0,0.06)';
    }
    if (btnMcq) {
      btnMcq.style.background = 'transparent';
      btnMcq.style.color = 'var(--ink-soft)';
      btnMcq.style.boxShadow = 'none';
    }
    if (selectEssay) selectEssay.style.display = 'block';
    if (selectMcq) selectMcq.style.display = 'none';

    // Issue 1: Restore "View Submission Logs" button in Essay mode
    if (btnLogs) btnLogs.style.display = '';

    // Restore essay-only controls
    if (btnEditDdl) btnEditDdl.style.display = '';
    if (btnManageBundle) btnManageBundle.style.display = '';
    if (btnDelForm) btnDelForm.style.display = '';

    // Hide delete MCQ test button in Essay mode
    const btnDeleteMcq = document.getElementById('btn-delete-mcq-test');
    if (btnDeleteMcq) btnDeleteMcq.style.display = 'none';

    stopMcqLivePolling();

    if (activeCode && selectEssay) {
      selectEssay.value = activeCode;
      if (typeof loadSelectedAssignment === 'function') {
        loadSelectedAssignment(activeCode);
      }
    } else {
      const resultsCard = document.getElementById('portal-results-card');
      if (resultsCard) resultsCard.style.display = 'none';
    }
  }
}

async function loadTeacherMcqTests() {
  try {
    const res = await fetch('/api/mcq/teacher/tests');
    const d = await res.json();
    if (d.success && Array.isArray(d.tests)) {
      const select = document.getElementById('mcq-tests-select');
      if (!select) return;

      select.innerHTML = '<option value="">-- Select an MCQ Assessment to view results --</option>' +
        d.tests.map((t) => {
          const count = Number(t.attempt_count) || 0;
          const countText = `${count} submission${count === 1 ? '' : 's'}`;
          let deadlineText = 'No Deadline';
          if (t.deadline) {
            const dObj = new Date(t.deadline);
            if (!isNaN(dObj.getTime())) {
              deadlineText = 'Due: ' + new Intl.DateTimeFormat('en-US', {
                timeZone: 'Africa/Cairo',
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                hour12: true
              }).format(dObj);
            }
          }
          return `<option value="${t.code}">🎧 ${escapeHtml(t.title)} (${countText}) — ${escapeHtml(deadlineText)} [${t.status}]</option>`;
        }).join('');

      if (activeMcqCode) {
        select.value = activeMcqCode;
      }
    }
  } catch (err) {
    console.error('Failed to load teacher MCQ tests:', err);
  }
}

async function loadSelectedMcqTest(code) {
  if (!code) {
    const resultsCard = document.getElementById('portal-results-card');
    if (resultsCard) resultsCard.style.display = 'none';
    const btnDeleteMcq = document.getElementById('btn-delete-mcq-test');
    if (btnDeleteMcq) btnDeleteMcq.style.display = 'none';
    stopMcqLivePolling();
    activeMcqCode = null;
    return;
  }

  activeMcqCode = code;
  activeViewMode = 'mcq';
  if (typeof stopLivePolling === 'function') stopLivePolling();

  try {
    const res = await fetch(`/api/mcq/${encodeURIComponent(code)}/attempts`);
    const d = await res.json();
    if (d.success && d.test) {
      activeMcqTestObj = d.test;
      mcqAttemptsData = d.attempts || [];
      mcqQuestionsData = d.questions || [];

      // Update titles
      const isListening = Boolean(d.test.audio_path);
      const liveTitle = document.getElementById('live-portal-title');
      if (liveTitle) {
        liveTitle.innerHTML = isListening
          ? `Live Submissions: ${escapeHtml(d.test.title)} <span class="pill-badge pill-purple" style="font-size: 11.5px; vertical-align: middle; margin-left: 6px;">🎧 Listening Assessment</span>`
          : `Live Submissions: ${escapeHtml(d.test.title)} (MCQ Assessment)`;
      }

      let deadlineText = 'No Deadline';
      if (d.test.deadline) {
        const dObj = new Date(d.test.deadline);
        if (!isNaN(dObj.getTime())) {
          deadlineText = 'Due: ' + new Intl.DateTimeFormat('en-US', {
            timeZone: 'Africa/Cairo',
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
          }).format(dObj);
        }
      }
      const deadlineSub = document.getElementById('live-portal-deadline-sub');
      if (deadlineSub) deadlineSub.textContent = deadlineText;

      const teacherDisplay = (currentUser && currentUser.name) ? currentUser.name : 'Teacher';
      const studentCount = mcqAttemptsData.length;
      const countText = `${studentCount} Student${studentCount === 1 ? '' : 's'}`;

      const printTitle = document.getElementById('portal-print-report-title');
      if (printTitle) {
        printTitle.textContent = isListening
          ? `Class Evaluation Summary: ${d.test.title} (🎧 Listening Assessment)`
          : `Class Evaluation Summary: ${d.test.title}`;
      }

      const printSub = document.getElementById('portal-print-report-sub');
      if (printSub) printSub.textContent = `Teacher: ${teacherDisplay} | Total Assessed: ${countText}`;

      // Show public test link
      const fullUrl = `${window.location.origin}/mcq-test.html?code=${d.test.code}`;
      const linkUrlEl = document.getElementById('generated-link-url');
      if (linkUrlEl) linkUrlEl.textContent = fullUrl;
      const linkBox = document.getElementById('generated-link-box');
      if (linkBox) linkBox.style.display = 'flex';

      // Hide and empty essay bundle task tabs
      const bundleTabs = document.getElementById('bundle-task-tabs');
      if (bundleTabs) {
        bundleTabs.style.display = 'none';
        bundleTabs.innerHTML = '';
      }

      const btnEditDdl = document.getElementById('portal-btn-edit-deadline');
      const btnManageBundle = document.getElementById('portal-btn-manage-bundle');
      const btnDelForm = document.getElementById('portal-btn-delete-form');
      if (btnEditDdl) btnEditDdl.style.display = 'none';
      if (btnManageBundle) btnManageBundle.style.display = 'none';
      if (btnDelForm) btnDelForm.style.display = 'none';

      // Show delete MCQ test button for active test
      const btnDeleteMcq = document.getElementById('btn-delete-mcq-test');
      if (btnDeleteMcq) btnDeleteMcq.style.display = 'inline-block';

      // Hide submission logs button in MCQ mode
      const btnLogs = document.getElementById('portal-btn-logs') || document.getElementById('btn-view-logs');
      if (btnLogs) btnLogs.style.display = 'none';

      // Show MCQ table headers and hide essay headers
      const essayHeaders = document.getElementById('portal-table-headers-essay');
      const mcqHeaders = document.getElementById('portal-table-headers-mcq');
      if (essayHeaders) essayHeaders.style.display = 'none';
      if (mcqHeaders) mcqHeaders.style.display = 'table-row';

      // Show results card
      const resultsCard = document.getElementById('portal-results-card');
      if (resultsCard) resultsCard.style.display = 'block';

      // Render read-only attempts table
      renderMcqAttemptsTable(mcqAttemptsData, mcqQuestionsData);

      // Start live polling
      startMcqLivePolling();
    } else {
      alert(d.error || 'Failed to load MCQ assessment.');
    }
  } catch (err) {
    console.error('Error loading MCQ attempts:', err);
    alert('Failed to load MCQ assessment details.');
  }
}

async function fetchLiveMcqAttempts() {
  if (!activeMcqCode || isMcqPollingActive || activeViewMode !== 'mcq') return;

  isMcqPollingActive = true;
  try {
    const res = await fetch(`/api/mcq/${encodeURIComponent(activeMcqCode)}/attempts`);
    const d = await res.json();
    if (d.success) {
      activeMcqTestObj = d.test;
      mcqAttemptsData = d.attempts || [];
      mcqQuestionsData = d.questions || [];

      renderMcqAttemptsTable(mcqAttemptsData, mcqQuestionsData);

      const teacherDisplay = (currentUser && currentUser.name) ? currentUser.name : 'Teacher';
      const studentCount = mcqAttemptsData.length;
      const countText = `${studentCount} Student${studentCount === 1 ? '' : 's'}`;
      const subEl = document.getElementById('portal-print-report-sub');
      if (subEl) subEl.textContent = `Teacher: ${teacherDisplay} | Total Assessed: ${countText}`;
    }
  } catch (_) {
    // Silently handle background poll error
  } finally {
    isMcqPollingActive = false;
  }
}

function renderMcqAttemptsTable(attempts, questions) {
  const summaryTbody = document.getElementById('portal-summary-table-body');
  const resultsContainer = document.getElementById('portal-results-list');

  if (resultsContainer) resultsContainer.innerHTML = '';
  if (!summaryTbody) return;

  summaryTbody.innerHTML = '';

  if (!attempts || attempts.length === 0) {
    summaryTbody.innerHTML = `
      <tr>
        <td colspan="3" style="text-align: center; color: var(--ink-soft); padding: 36px 20px; font-size: 14px;">
          Waiting for students to take this assessment... Share the link above with your class.
        </td>
      </tr>
    `;
    return;
  }

  ensurePrintStylesInjected();
  resizeReportIframes();

  const isListeningTest = Boolean(activeMcqTestObj && activeMcqTestObj.audio_path);
  const optionLetters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];

  attempts.forEach((att, idx) => {
    const displayName = escapeHtml(att.student_name || 'Student');

    let formattedDate = '—';
    if (att.submitted_at) {
      const dObj = new Date(att.submitted_at);
      if (!isNaN(dObj.getTime())) {
        formattedDate = new Intl.DateTimeFormat('en-US', {
          timeZone: 'Africa/Cairo',
          dateStyle: 'medium',
          timeStyle: 'short'
        }).format(dObj);
      }
    }

    const dupPill = att.possible_duplicate
      ? `<span class="pill-badge pill-amber" title="Multiple submissions from same IP within 10 minutes">⚠️ Rapid IP Resubmit</span>`
      : '';

    let diagnosticsList = att.diagnostic_feedback;
    if (typeof diagnosticsList === 'string') {
      try { diagnosticsList = JSON.parse(diagnosticsList); } catch (_) { diagnosticsList = []; }
    }
    if (!Array.isArray(diagnosticsList)) diagnosticsList = [];

    const diagMap = new Map();
    diagnosticsList.forEach((d) => {
      if (d.question_id !== undefined && d.question_id !== null) {
        diagMap.set(Number(d.question_id), d);
        diagMap.set(String(d.question_id), d);
      }
      if (d.question_number !== undefined && d.question_number !== null) {
        diagMap.set(Number(d.question_number), d);
        diagMap.set(String(d.question_number), d);
      }
    });

    let mistakesCount = 0;

    // Question-by-question objective breakdown using resolveMcqQuestionAnswers
    const breakdownRows = (questions || []).map((q, qIdx) => {
      const rawAns = (att.answers && att.answers[q.id] !== undefined && att.answers[q.id] !== null) ? att.answers[q.id] : undefined;
      const res = resolveMcqQuestionAnswers(q, rawAns, optionLetters);
      const isMistake = res.isMistake;

      let diagHtml = '';
      if (isMistake) {
        mistakesCount++;
        if (isListeningTest) {
          const diag = diagMap.get(Number(q.id)) || diagMap.get(Number(qIdx + 1)) || diagMap.get(String(q.id)) || diagMap.get(String(qIdx + 1));
          if (diag) {
            diagHtml = `
              <div class="listening-diag-box" style="margin: 6px 0 12px 14px; padding: 8px 12px; background: #f8fafc; border-left: 3px solid #2563eb; font-size: 12px; border-radius: 4px;">
                <div style="font-weight: 600; color: #1e40af;">🎯 ${escapeHtml(diag.main_skill || 'Listening')} → ${escapeHtml(diag.sub_skill || 'Strategy')}</div>${diag.observable_error ? `<div style="color: #475569; margin-top: 2px;">⚠️ <strong>Error:</strong> ${escapeHtml(diag.observable_error)}</div>` : ''}
                <div style="color: #334155; margin-top: 2px;">🎧 <strong>Audio Quote:</strong> <em>"${escapeHtml(diag.spoken_quote || '')}"</em></div>
                <div style="color: #0f172a; margin-top: 2px;">💡 <strong>Strategy:</strong> ${escapeHtml(diag.diagnosis_and_strategy || '')}</div>${diag.intervention ? `<div style="color: #166534; margin-top: 2px;">🎯 <strong>Recommended Drill:</strong> ${escapeHtml(diag.intervention)}</div>` : ''}
              </div>
            `;
          }
        }
      }

      return `
        <div style="border-bottom: 1px dashed #E5E7EB; padding: 4px 0;">
          <div style="font-size: 12.5px; padding: 2px 0; font-family: 'IBM Plex Mono', monospace;">
            <b>Q${qIdx + 1}:</b> ${res.html}
          </div>
          ${diagHtml}
        </div>
      `;
    }).join('');

    // Task 3: Auto-Trigger when an attempt is viewed for a listening test and has mistakes without diagnostic_feedback
    if (isListeningTest && mistakesCount > 0 && activeMcqTestObj && activeMcqTestObj.id) {
      const hasDiags = Array.isArray(diagnosticsList) && diagnosticsList.length > 0;
      if (!hasDiags && !inFlightDiagnostics.has(att.id)) {
        inFlightDiagnostics.add(att.id);
        autoTriggerListeningDiagnostics(activeMcqTestObj.id, att.id);
      }
    }

    let diagnosticActionHtml = '';
    if (isListeningTest) {
      if (diagnosticsList.length > 0) {
        diagnosticActionHtml = `
          <div style="margin-top: 8px; padding-top: 6px; border-top: 1px dashed #DDD6FE; display: flex; justify-content: space-between; align-items: center;" class="no-print">
            <span style="font-size: 11px; color: #6D28D9; font-weight: 600;">✓ IG Grade 9 Skills Diagnosed (${diagnosticsList.length} error${diagnosticsList.length === 1 ? '' : 's'})</span>
            <button type="button" class="ghost" id="btn-diag-${att.id}" onclick="runListeningDiagnostics(${activeMcqTestObj.id}, ${att.id})" style="font-size: 11px; padding: 2px 7px; color: #6B7280; border-color: #E5E7EB; cursor: pointer; border-radius: 4px;" title="Re-run Gemini Listening Diagnostic Engine">🔄 Re-analyze</button>
          </div>
        `;
      } else if (mistakesCount > 0) {
        diagnosticActionHtml = `
          <div style="margin-top: 8px; padding-top: 6px; border-top: 1px dashed #E5E7EB; display: flex; justify-content: space-between; align-items: center;" class="no-print">
            <span style="font-size: 11px; color: #2563eb; font-weight: 600;">⏳ Auto-diagnosing IG Grade 9 Skills...</span>
            <button type="button" class="ghost" id="btn-diag-${att.id}" onclick="runListeningDiagnostics(${activeMcqTestObj.id}, ${att.id})" style="font-size: 11px; padding: 2px 7px; font-weight: 600; color: #5B21B6; border-color: #DDD6FE; background: #F5F3FF; cursor: pointer; border-radius: 4px; display: inline-flex; align-items: center; gap: 4px;">🔍 Run Now</button>
          </div>
        `;
      } else {
        diagnosticActionHtml = `
          <div style="margin-top: 8px; font-size: 11.5px; color: #059669; font-weight: 600;">✓ Perfect score &bull; 0 listening errors detected</div>
        `;
      }
    }

    const tr = document.createElement('tr');
    tr.id = `mcq-summary-tr-${idx}`;
    tr.className = 'report-sheet';
    tr.innerHTML = `
      <td style="vertical-align: top; padding: 12px 14px;">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px;">
          <div>
            <b style="font-size: 14.5px; color: var(--ink);">${displayName}</b>
            ${isListeningTest ? `<div style="margin-top: 2px;"><span class="pill-badge pill-purple" style="font-size: 10px;">🎧 Listening</span></div>` : ''}
            <div style="margin-top: 3px; font-size: 11.5px; color: var(--ink-soft); font-family: 'IBM Plex Mono', monospace;">
              🕒 ${formattedDate}
            </div>
            <div class="integrity-pills no-print" style="margin-top: 6px;">${dupPill}</div>
          </div>
          <button class="line-delete-btn no-print" onclick="deleteMcqAttempt(${att.id}, '${escapeHtml(att.student_name || 'Student')}')" title="Delete attempt & allow student to retake test" style="font-size: 15px; color: #DC2626; padding: 2px 5px; cursor: pointer; background: transparent; border: 1px solid transparent; border-radius: 4px; transition: all 0.2s;">🗑️</button>
        </div>
      </td>
      <td style="vertical-align: top; padding: 12px 14px;" class="mcq-score-col">
        <div style="display: inline-block; padding: 6px 12px; background: var(--pen-soft); color: var(--pen); border-radius: 6px; font-family: 'IBM Plex Mono', monospace; font-size: 15px; font-weight: 700; border: 1px solid rgba(0,0,0,0.06);">
          ${escapeHtml(att.score || '0')}
        </div>
      </td>
      <td style="vertical-align: top; padding: 12px 14px;">
        <div class="breakdown-box report-table-wrapper" style="background: #F9FAFB; border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px; overflow: visible !important; max-height: none !important;">
          ${breakdownRows || '<span style="color:var(--ink-soft); font-size:12px;">No question breakdown available</span>'}
          ${diagnosticActionHtml}
        </div>
      </td>
    `;
    summaryTbody.appendChild(tr);
  });
}

async function deleteMcqAttempt(attemptId, studentName) {
  const numericId = parseInt(attemptId, 10);
  if (!activeMcqCode || isNaN(numericId) || numericId <= 0) {
    alert('Unable to identify assessment attempt ID.');
    return;
  }

  const confirmed = await showConfirmModal(
    `Delete attempt for "${studentName}"? This permanently removes their score and unlocks their device to retake the test.`,
    'Remove Student Attempt'
  );
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/mcq/${encodeURIComponent(activeMcqCode)}/attempts/${numericId}`, {
      method: 'DELETE'
    });
    const d = await res.json();
    if (d.success) {
      showToast(d.message || 'Student attempt deleted.');
      await fetchLiveMcqAttempts();
      await loadTeacherMcqTests();
    } else {
      alert(d.error || 'Failed to remove attempt.');
    }
  } catch (err) {
    console.error('Error deleting MCQ attempt:', err);
    alert('Network error while deleting assessment attempt.');
  }
}

async function confirmDeleteCurrentMcqTest() {
  if (!activeMcqTestObj || !activeMcqTestObj.id) {
    alert('No active MCQ assessment selected to delete.');
    return;
  }

  const confirmed = await showConfirmModal(
    'Are you sure you want to delete this MCQ Assessment? This will permanently remove the test, all audio references, and all student attempts. This action cannot be undone.',
    'Delete MCQ Assessment'
  );
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/mcq/${activeMcqTestObj.id}`, {
      method: 'DELETE'
    });
    const d = await res.json();
    if (d.success) {
      showToast('MCQ test deleted successfully.');
      stopMcqLivePolling();
      activeMcqCode = null;
      activeMcqTestObj = null;
      mcqAttemptsData = [];
      mcqQuestionsData = [];

      const selectMcq = document.getElementById('mcq-tests-select');
      if (selectMcq) selectMcq.value = '';

      const resultsCard = document.getElementById('portal-results-card');
      if (resultsCard) resultsCard.style.display = 'none';

      const btnDeleteMcq = document.getElementById('btn-delete-mcq-test');
      if (btnDeleteMcq) btnDeleteMcq.style.display = 'none';

      await loadTeacherMcqTests();
    } else {
      alert(d.error || 'Failed to delete MCQ test.');
    }
  } catch (err) {
    console.error('Error deleting MCQ test:', err);
    alert('Network error while deleting MCQ test.');
  }
}

async function runListeningDiagnostics(testId, attemptId) {
  const btn = document.getElementById(`btn-diag-${attemptId}`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Analyzing with IG Framework...';
  }
  try {
    const res = await fetch(`/api/mcq/${testId}/attempts/${attemptId}/diagnose`, {
      method: 'POST',
      headers: getAuthHeaders()
    });
    const d = await res.json();
    if (!res.ok || !d.success) {
      throw new Error(d.error || 'Diagnostic evaluation failed.');
    }
    if (typeof showToast === 'function') {
      showToast('Listening skills diagnosed successfully!');
    }
    await fetchLiveMcqAttempts();
  } catch (err) {
    console.error('Diagnostic error:', err);
    alert('Error running diagnostics: ' + err.message);
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🔍 Diagnose Listening Skills';
    }
  }
}

// Global window exports
window.renderCardsAndSummaryTable = renderCardsAndSummaryTable;
window.startLivePolling = startLivePolling;
window.stopLivePolling = stopLivePolling;
window.fetchLiveSubmissions = fetchLiveSubmissions;
window.printReport = printReport;
window.generateMcqPrintableReport = generateMcqPrintableReport;
window.resolveMcqQuestionAnswers = resolveMcqQuestionAnswers;
window.getAuthHeaders = getAuthHeaders;
window.autoTriggerListeningDiagnostics = autoTriggerListeningDiagnostics;
window.deleteStudentSubmission = deleteStudentSubmission;
window.toggleSubmissionLogsModal = toggleSubmissionLogsModal;
window.deleteLineItem = deleteLineItem;
window.addNewSectionLine = addNewSectionLine;
window.recalculateTotal = recalculateTotal;

// Stage 5 MCQ exports
window.switchSubmissionsView = switchSubmissionsView;
window.loadTeacherMcqTests = loadTeacherMcqTests;
window.loadSelectedMcqTest = loadSelectedMcqTest;
window.fetchLiveMcqAttempts = fetchLiveMcqAttempts;
window.renderMcqAttemptsTable = renderMcqAttemptsTable;
window.deleteMcqAttempt = deleteMcqAttempt;
window.confirmDeleteCurrentMcqTest = confirmDeleteCurrentMcqTest;
window.startMcqLivePolling = startMcqLivePolling;
window.stopMcqLivePolling = stopMcqLivePolling;
window.runListeningDiagnostics = runListeningDiagnostics;


