// ==========================================
// SHARED.JS - Global State & Core Utilities
// ==========================================

var currentUser = null;
var activeCode = '';
var allAssignmentsMap = {};
var currentBundleTasks = [];
var portalSubmissions = [];
var manualResults = [];
var livePollTimer = null;

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function showToast(message) {
  const toast = document.getElementById('custom-toast');
  const text = document.getElementById('custom-toast-text');
  if (!toast || !text) return;
  text.textContent = message;
  toast.style.display = 'flex';
  setTimeout(() => {
    toast.style.display = 'none';
  }, 4000);
}

function showConfirmModal(message, title = 'Confirm Deletion') {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirm-modal') || document.getElementById('custom-modal-overlay');
    const msgEl = document.getElementById('confirm-modal-message') || document.getElementById('custom-modal-message');
    const titleEl = document.getElementById('confirm-modal-title') || document.getElementById('custom-modal-title');
    const okBtn = document.getElementById('confirm-modal-ok-btn') || document.getElementById('custom-modal-confirm');
    const cancelBtn = document.getElementById('confirm-modal-cancel-btn') || document.getElementById('custom-modal-cancel');

    msgEl.textContent = message;
    if (titleEl) titleEl.textContent = title;
    modal.style.display = 'flex';

    function cleanup(result) {
      modal.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    }

    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
  });
}

function setMinDateOnly() {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const minDate = `${yyyy}-${mm}-${dd}`;
  const dateInput = document.getElementById('assign-deadline-date');
  if (dateInput) {
    dateInput.min = minDate;
  }
}

function getIsoFrom12h(dateId, hourId, minId, ampmId) {
  const dVal = document.getElementById(dateId).value;
  const hVal = document.getElementById(hourId).value;
  const mVal = document.getElementById(minId).value;
  const ampmVal = document.getElementById(ampmId).value;

  if (!dVal || !hVal || !mVal || !ampmVal) return null;

  let hour = parseInt(hVal, 10);
  if (ampmVal === 'PM' && hour < 12) hour += 12;
  if (ampmVal === 'AM' && hour === 12) hour = 0;

  const dateObj = new Date(`${dVal}T${String(hour).padStart(2, '0')}:${mVal}:00`);
  return isNaN(dateObj.getTime()) ? null : dateObj.toISOString();
}

function formatDeadlineString(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return 'Due: ' + isoStr;
    const formattedCairo = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Cairo',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    }).format(d);
    return 'Due: ' + formattedCairo;
  } catch (e) {
    return 'Due: ' + isoStr;
  }
}

function getIntegrityPill(label, score) {
  const s = parseInt(score, 10) || 0;
  if (s >= 50) return `<span class="pill-badge pill-red">⚠️ ${label}: ${s}%</span>`;
  if (s >= 25) return `<span class="pill-badge pill-amber">${label}: ${s}%</span>`;
  return `<span class="pill-badge pill-green">${label}: ${s}%</span>`;
}

// Authentication Check & Initialization
fetch('/api/auth/me')
  .then(res => res.json())
  .then(data => {
    if (data.success && data.user) {
      currentUser = data.user;
      let displayRole = 'Teacher';
      if (data.user.role === 'root') displayRole = 'Root User';
      else if (data.user.role === 'admin') displayRole = 'Admin';

      document.getElementById('user-display').textContent = `👤 ${data.user.name} (${displayRole})`;
      
      if (['root', 'admin'].includes(data.user.role)) {
        document.getElementById('admin-panel-btn').style.display = 'inline-block';
      }

      if (data.user.status !== 'approved' && !['root', 'admin'].includes(data.user.role)) {
        document.getElementById('pending-banner').style.display = 'block';
        const mb = document.getElementById('mark-btn');
        if (mb) mb.disabled = true;
      }
      setMinDateOnly();
      if (typeof renderTaskDefinitions === 'function') renderTaskDefinitions();
      if (typeof loadTeacherAssignments === 'function') loadTeacherAssignments();
    } else {
      window.location.replace('/login.html');
    }
  })
  .catch(() => { window.location.replace('/login.html'); });

function logout() {
  fetch('/api/auth/logout', { method: 'POST' }).then(() => window.location.replace('/login.html'));
}
