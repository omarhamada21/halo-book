// ==========================================
// CLIENT-SIDE EXAM RUNTIME & PROCTORING LOCKDOWN
// ==========================================

const urlParams = new URLSearchParams(window.location.search);
const testCode = (urlParams.get('code') || '').trim();

let testData = null;
let clientAnswers = new Map(); // questionId -> { answer, word_count }
let allQuestionIds = [];
let wasAudioPlayingBeforeExit = false;
let audioKey = 'online_audio_started_' + testCode;

// Security & Proctoring State
let strikesCount = 0;
const MAX_STRIKES = 2;
let securityViolations = [];
let lastInfractionTime = 0;
let isExamActive = false;
let isSubmitted = false;
let countdownTimerId = null;

function getOrCreateDeviceId() {
  let stored = localStorage.getItem('mimir_device_token');
  // Guard against legacy truncated collision tokens (e.g. dev_NDE0eDg5...) that lacked true UUID randomness
  const isLegacyTruncated = stored && (
    stored.startsWith('dev_NDE0eDg5') ||
    stored.startsWith('dev_NDQweDk1') ||
    stored.startsWith('dev_NDI4eDky') ||
    stored.startsWith('dev_MzYweDgw') ||
    stored.length < 35 ||
    (stored.length <= 36 && !stored.includes('-'))
  );
  if (stored && !isLegacyTruncated) return stored;

  let uuid = '';
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try { uuid = crypto.randomUUID(); } catch (_) {}
  }
  if (!uuid) {
    uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }
  stored = 'dev_' + uuid;
  try { localStorage.setItem('mimir_device_token', stored); } catch (_) {}
  return stored;
}

const clientDeviceId = getOrCreateDeviceId();

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatCairoDateTime(dateObj) {
  return dateObj.toLocaleString('en-US', {
    timeZone: 'Africa/Cairo',
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true
  });
}

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('exam-toast');
  if (!el) return;
  el.innerText = msg;
  el.style.display = 'block';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = 'none'; }, 3000);
}

function showClosedScreen(type, options = {}) {
  const splash = document.getElementById('exam-splash-screen');
  if (splash) splash.style.display = 'none';
  const mainContent = document.getElementById('exam-main-content');
  if (mainContent) mainContent.style.display = 'none';
  const intro = document.getElementById('exam-intro-card');
  if (intro) intro.style.display = 'none';
  const sec = document.getElementById('exam-sections-container');
  if (sec) sec.style.display = 'none';
  const bar = document.getElementById('exam-bottom-bar');
  if (bar) bar.style.display = 'none';
  const nav = document.getElementById('exam-section-nav') || document.querySelector('.section-tabs-wrap');
  if (nav) nav.style.display = 'none';
  const audio = document.getElementById('exam-audio-box');
  if (audio) audio.style.display = 'none';
  const lock = document.getElementById('exam-locked-screen');
  if (lock) lock.style.display = 'none';

  const closedCard = document.getElementById('exam-closed-screen');
  const iconEl = document.getElementById('closed-screen-icon');
  const titleEl = document.getElementById('closed-screen-title');
  const msgEl = document.getElementById('closed-screen-message');
  const subEl = document.getElementById('closed-screen-subtext');

  if (type === 'deadline') {
    if (iconEl) iconEl.textContent = '⛔';
    if (titleEl) titleEl.textContent = 'Submissions Closed';
    const formattedDate = options.deadline ? formatCairoDateTime(new Date(options.deadline)) : '';
    if (msgEl) {
      msgEl.innerHTML = `⛔ <b>Submissions Closed:</b> This test's submission window has closed. The deadline was ${formattedDate || 'the scheduled deadline'} (Cairo Time). Contact your teacher if you believe this is a mistake.`;
    }
    if (subEl) subEl.textContent = 'Submissions are no longer accepted for this exam session.';
  } else {
    // 'invalid' or 'draft' (unpublished) — treat draft identically to invalid link from student's perspective
    if (iconEl) iconEl.textContent = '🔗';
    if (titleEl) titleEl.textContent = 'Invalid Test Link';
    if (msgEl) {
      msgEl.innerHTML = `This test link appears to be invalid or has been removed. Please check the link with your teacher.`;
    }
    if (subEl) subEl.textContent = 'Please confirm the test link with your instructor.';
  }

  if (closedCard) closedCard.style.display = 'block';
}

function showLockedScreen() {
  const splash = document.getElementById('exam-splash-screen');
  if (splash) splash.style.display = 'none';
  const mainContent = document.getElementById('exam-main-content');
  if (mainContent) mainContent.style.display = 'none';
  const intro = document.getElementById('exam-intro-card');
  if (intro) intro.style.display = 'none';
  const sec = document.getElementById('exam-sections-container');
  if (sec) sec.style.display = 'none';
  const bar = document.getElementById('exam-bottom-bar');
  if (bar) bar.style.display = 'none';
  const nav = document.getElementById('exam-section-nav') || document.getElementById('section-nav-strip') || document.querySelector('.section-tabs-wrap');
  if (nav) nav.style.display = 'none';
  const audio = document.getElementById('exam-audio-box');
  if (audio) audio.style.display = 'none';
  const closedCard = document.getElementById('exam-closed-screen');
  if (closedCard) closedCard.style.display = 'none';
  const lock = document.getElementById('exam-locked-screen');
  if (lock) lock.style.display = 'block';
  const dev = document.getElementById('locked-device-id');
  if (dev) dev.innerText = clientDeviceId;
}

// ----------------- 1. INITIALIZATION -----------------

window.addEventListener('DOMContentLoaded', async () => {
  if (!testCode) {
    showClosedScreen('invalid');
    return;
  }

  // Restore candidate name if previously typed
  const savedName = sessionStorage.getItem('online_student_name') || '';
  const splashInput = document.getElementById('splash-student-name');
  const bottomInput = document.getElementById('student-name-input');
  if (savedName) {
    if (splashInput) splashInput.value = savedName;
    if (bottomInput) bottomInput.value = savedName;
  }

  if (splashInput) {
    splashInput.addEventListener('input', (e) => {
      const val = e.target.value.trim();
      sessionStorage.setItem('online_student_name', val);
      if (bottomInput) bottomInput.value = val;
      const err = document.getElementById('splash-name-error');
      if (err) err.style.display = 'none';
    });
  }

  if (bottomInput) {
    bottomInput.addEventListener('input', (e) => {
      const val = e.target.value.trim();
      sessionStorage.setItem('online_student_name', val);
      if (splashInput) splashInput.value = val;
    });
  }

  await loadOnlineTest();
});

async function loadOnlineTest() {
  try {
    // 1. Authoritative Server Submission & Device Status Check
    let hasServerAttempt = false;
    let isStatusCheckSuccessful = false;
    try {
      const statusRes = await fetch(`/api/public/online-tests/${encodeURIComponent(testCode)}/status?deviceId=${encodeURIComponent(clientDeviceId)}`);
      if (statusRes.ok) {
        const statusData = await statusRes.json();
        isStatusCheckSuccessful = true;
        hasServerAttempt = Boolean(statusData && (statusData.hasSubmitted || statusData.already_submitted));
      }
    } catch (statusErr) {
      console.warn('[Status Check Warning]', statusErr);
    }

    if (hasServerAttempt) {
      // Server confirms active submission exists for this device
      localStorage.setItem('online_test_locked_' + testCode, 'true');
      localStorage.setItem('online_test_submitted_' + testCode, 'true');
      showLockedScreen();
      return;
    } else if (isStatusCheckSuccessful) {
      // Server confirms NO attempt exists (fresh attempt or teacher deleted attempt!)
      // Purge all client-side lockout flags to allow student to retake/resubmit
      localStorage.removeItem('online_test_locked_' + testCode);
      localStorage.removeItem('online_test_submitted_' + testCode);
      localStorage.removeItem('online_audio_started_' + testCode);
      localStorage.removeItem('online_test_draft_' + testCode);
      sessionStorage.removeItem('online_test_submitted_' + testCode);
      sessionStorage.removeItem('online_test_draft_' + testCode);
      if (typeof clientAnswers !== 'undefined' && clientAnswers.clear) {
        clientAnswers.clear();
      }
      isSubmitted = false;
      isExamActive = false;
      isProctoringLocked = false;
      violationCount = 0;
      strikesCount = 0;
      securityViolations = [];
      const lockedScreen = document.getElementById('exam-locked-screen');
      if (lockedScreen) lockedScreen.style.display = 'none';
    } else {
      // Fallback only if offline/network error connecting to status endpoint
      const isLocallyLocked = localStorage.getItem('online_test_locked_' + testCode) === 'true';
      if (isLocallyLocked) {
        showLockedScreen();
        return;
      }
    }

    // 2. Fetch sanitized exam payload (answers & rubrics stripped)
    const res = await fetch(`/api/public/online-tests/${encodeURIComponent(testCode)}`);
    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.success || !data.test) {
      if (res.status === 403 || data.error === 'deadline_passed') {
        showClosedScreen('deadline', { deadline: data.deadline });
        return;
      }
      showClosedScreen('invalid');
      return;
    }

    testData = data.test;
    window.examData = testData;

    // Check if client-side time has passed deadline
    if (testData.deadline) {
      const dlDate = new Date(testData.deadline);
      if (!isNaN(dlDate.getTime()) && Date.now() > dlDate.getTime()) {
        showClosedScreen('deadline', { deadline: testData.deadline });
        return;
      }
    }

    // Render splash screen info
    document.getElementById('splash-code-badge').innerText = `ACCESS CODE: ${escapeHtml(testCode)}`;
    document.getElementById('splash-exam-title').innerText = testData.title;
    document.getElementById('splash-exam-teacher').innerText = `Instructor / Examination Center: ${testData.teacher_name || 'Teacher'}`;

    if (testData.deadline) {
      const dlDate = new Date(testData.deadline);
      const splashDdl = document.getElementById('splash-deadline-box');
      splashDdl.style.display = 'block';
      splashDdl.innerHTML = `⏳ <b>Deadline:</b> ${formatCairoDateTime(dlDate)} (Cairo Time)`;
    }

    // Pre-render exam components in background (remain hidden inside #exam-main-content until fullscreen entry)
    renderExamHeader();
    renderSectionNav();
    renderSections();

    updateCompletionCount();

    // Show lockdown splash screen gate
    document.getElementById('exam-splash-screen').style.display = 'block';
  } catch (err) {
    console.error('Failed to load exam:', err);
    showClosedScreen('invalid');
  }
}

// ----------------- 2. LOCKDOWN & FULLSCREEN ENTRY GATE -----------------

async function startExamWithLockdown(e) {
  if (e && e.preventDefault) {
    try { e.preventDefault(); } catch (_) {}
  }
  const splashInput = document.getElementById('splash-student-name');
  const studentName = (splashInput?.value || document.getElementById('student-name-input')?.value || '').trim();
  const errEl = document.getElementById('splash-name-error');

  if (!studentName) {
    if (errEl) errEl.style.display = 'block';
    if (splashInput) splashInput.focus();
    return;
  }
  if (errEl) errEl.style.display = 'none';

  sessionStorage.setItem('online_student_name', studentName);
  const bottomInput = document.getElementById('student-name-input');
  if (bottomInput) bottomInput.value = studentName;

  // Request Fullscreen synchronously upon user gesture
  try {
    const promise = requestNativeFullscreen();
    if (promise && promise.then) {
      promise.then(() => {
        window.isMobileFallbackFullscreenActive = false;
        document.documentElement.classList.remove('ot-mobile-pseudo-fullscreen');
        document.body.classList.remove('ot-mobile-pseudo-fullscreen');
      }).catch(err => {
        console.warn('[StartExam] Native fullscreen rejected. Activating mobile fallback:', err ? err.message : err);
        activateMobileFallbackFullscreen();
      });
    }
  } catch (fsErr) {
    console.warn('[StartExam] Fullscreen API unsupported. Activating mobile fallback:', fsErr ? fsErr.message : fsErr);
    activateMobileFallbackFullscreen();
  }

  revealExamContent();
}

function revealExamContent() {
  document.getElementById('exam-splash-screen').style.display = 'none';
  const mainContent = document.getElementById('exam-main-content');
  if (mainContent) mainContent.style.display = 'block';
  document.getElementById('exam-intro-card').style.display = 'block';
  document.getElementById('exam-sections-container').style.display = 'block';
  document.getElementById('exam-bottom-bar').style.display = 'flex';

  const navContainer = document.getElementById('exam-section-nav') || document.getElementById('section-nav-strip') || document.querySelector('.section-tabs-wrap');
  if (navContainer && testData?.sections && testData.sections.length > 1) {
    navContainer.style.display = 'flex';
  }
  const audioBox = document.getElementById('exam-audio-box');
  if (audioBox) {
    audioBox.style.display = 'block';
  }

  isExamActive = true;

  if (testData?.deadline) {
    startCountdownTimer(new Date(testData.deadline));
  }
}

// ----------------- 3. PROCTORING & SECURITY INFRACTION HANDLER -----------------

// Photo-Capture Grace Period State (2 minutes / 120 seconds)
window.isCapturingPhoto = false;
window.photoCaptureStartTime = null;
window.activePhotoGraceTimeout = 120000;
window.lastBlurTimestamp = null;
window.photoGraceTimer = null;

function markPhotoCaptureStart(qId) {
  window.isCapturingPhoto = true;
  window.photoCaptureStartTime = Date.now();
  window.activePhotoGraceTimeout = 120000;
  console.log(`[Proctoring] Student opened camera/photo picker for question ${qId || ''}. 2-minute grace active.`);

  if (window.photoGraceTimer) clearTimeout(window.photoGraceTimer);
  window.photoGraceTimer = setTimeout(() => {
    if (window.isCapturingPhoto) {
      console.warn('[Proctoring] Photo grace period (120s) expired while unfocused.');
      if (document.hidden || !document.hasFocus()) {
        registerStrike('photo_timeout_exceeded', 'Photo capture exceeded 120-second limit.');
      }
      window.isCapturingPhoto = false;
      window.photoCaptureStartTime = null;
    }
  }, 120000);
}

// Fullscreen Compliance Recovery State (1-minute compliance window for attached essay papers)
window.fullscreenRecoveryDeadline = null;
window.fullscreenRecoveryTimerId = null;
window.fullscreenRecoveryTickInterval = null;
window.isPostPhotoRecoveryActive = false;
window.lastAttachedPhotoQuestionId = null;

function startOrResetFullscreenRecoveryTimer(pageCount = 1, questionId = null) {
  if (!isExamActive || isSubmitted) return;

  // Clear existing recovery timer and interval if active
  if (window.fullscreenRecoveryTimerId) {
    clearTimeout(window.fullscreenRecoveryTimerId);
    window.fullscreenRecoveryTimerId = null;
  }
  if (window.fullscreenRecoveryTickInterval) {
    clearInterval(window.fullscreenRecoveryTickInterval);
    window.fullscreenRecoveryTickInterval = null;
  }

  const durationMs = 60000; // 1 minute (60,000 ms)
  const now = Date.now();
  window.fullscreenRecoveryDeadline = now + durationMs;
  window.isPostPhotoRecoveryActive = true;
  if (questionId) window.lastAttachedPhotoQuestionId = questionId;

  const overlay = document.getElementById('ot-fullscreen-recovery-overlay');
  const titleEl = document.getElementById('ot-fs-recovery-title');
  const descEl = document.getElementById('ot-fs-recovery-desc');
  const timerDisplay = document.getElementById('ot-fs-timer-display');

  const pageNum = Number(pageCount) || 1;
  if (titleEl) {
    titleEl.textContent = pageNum > 1 ? `📸 Page ${pageNum} Attached!` : '📸 Paper Attached!';
  }
  if (descEl) {
    descEl.textContent = pageNum > 1
      ? `Page ${pageNum} has been saved. Please return to fullscreen mode to continue your exam securely, or attach additional pages if needed.`
      : 'Your page has been saved. Please return to fullscreen mode to continue your exam securely, or attach additional pages if needed.';
  }

  // Dismiss generic fullscreen resume overlay if open to avoid conflicting dialogs
  const resumeOverlay = document.getElementById('fullscreen-resume-overlay');
  if (resumeOverlay) resumeOverlay.style.display = 'none';
  const warningModal = document.getElementById('lockdown-warning-modal');
  if (warningModal) warningModal.style.display = 'none';

  if (overlay) overlay.style.display = 'flex';

  function updateRecoveryCountdown() {
    if (!window.isPostPhotoRecoveryActive) return;
    const remainingMs = Math.max(0, (window.fullscreenRecoveryDeadline || 0) - Date.now());
    const remainingSec = Math.ceil(remainingMs / 1000);
    const mins = Math.floor(remainingSec / 60);
    const secs = remainingSec % 60;
    const formatted = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

    if (timerDisplay) {
      timerDisplay.textContent = formatted;
      timerDisplay.style.color = remainingSec <= 15 ? '#DC2626' : '#B45309';
    }

    if (remainingMs <= 0) {
      handleRecoveryTimeoutExpired();
    }
  }

  updateRecoveryCountdown();
  window.fullscreenRecoveryTickInterval = setInterval(updateRecoveryCountdown, 500);

  window.fullscreenRecoveryTimerId = setTimeout(() => {
    handleRecoveryTimeoutExpired();
  }, durationMs);

  console.log(`[Proctoring] Fullscreen recovery compliance window started/reset: 1m (${pageNum} page(s) attached).`);
}

function handleRecoveryTimeoutExpired() {
  if (!window.isPostPhotoRecoveryActive) return;
  console.warn('[Proctoring] 1-minute photo fullscreen compliance window expired without returning to fullscreen.');

  dismissFullscreenRecoveryTimer({ timeoutExpired: true });

  registerStrike(
    'fullscreen_not_restored_after_photo',
    'Failed to return to fullscreen mode within 1 minute of the last attached paper.'
  );

  if (isExamActive && !isSubmitted && strikesCount < MAX_STRIKES) {
    const resumeOverlay = document.getElementById('fullscreen-resume-overlay');
    if (resumeOverlay) resumeOverlay.style.display = 'flex';
  }
}

function dismissFullscreenRecoveryTimer(opts = {}) {
  if (window.fullscreenRecoveryTimerId) {
    clearTimeout(window.fullscreenRecoveryTimerId);
    window.fullscreenRecoveryTimerId = null;
  }
  if (window.fullscreenRecoveryTickInterval) {
    clearInterval(window.fullscreenRecoveryTickInterval);
    window.fullscreenRecoveryTickInterval = null;
  }
  window.fullscreenRecoveryDeadline = null;
  window.isPostPhotoRecoveryActive = false;

  const overlay = document.getElementById('ot-fullscreen-recovery-overlay');
  if (overlay) overlay.style.display = 'none';

  if (!opts.timeoutExpired) {
    console.log('[Proctoring] Fullscreen recovery overlay dismissed. 0 strikes recorded.');
  }
}

// Mobile Fullscreen & Fallback State
window.isMobileFallbackFullscreenActive = false;
let lastReenterTs = 0;

function isNativeFullscreenSupported() {
  const doc = document;
  return !!(
    doc.fullscreenEnabled ||
    doc.webkitFullscreenEnabled ||
    doc.mozFullScreenEnabled ||
    doc.msFullscreenEnabled
  );
}

function requestNativeFullscreen() {
  const el = document.documentElement;
  const rfs = el.requestFullscreen ||
              el.webkitRequestFullscreen ||
              el.mozRequestFullScreen ||
              el.msRequestFullscreen;
  if (rfs) {
    return rfs.call(el);
  }
  return Promise.reject(new Error('Fullscreen API not supported'));
}

function isExamInFullscreen() {
  const nativeFs = !!(
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.mozFullScreenElement ||
    document.msFullscreenElement
  );
  return nativeFs || window.isMobileFallbackFullscreenActive === true;
}

function activateMobileFallbackFullscreen() {
  document.documentElement.classList.add('ot-mobile-pseudo-fullscreen');
  document.body.classList.add('ot-mobile-pseudo-fullscreen');
  try {
    window.scrollTo(0, 1);
  } catch (_) {}
  window.isMobileFallbackFullscreenActive = true;

  // Reveal exam content if hidden
  const resumeOverlay = document.getElementById('fullscreen-resume-overlay');
  if (resumeOverlay) resumeOverlay.style.display = 'none';
  const warningModal = document.getElementById('lockdown-warning-modal');
  if (warningModal) warningModal.style.display = 'none';

  const mainContent = document.getElementById('exam-main-content');
  const bottomBar = document.getElementById('exam-bottom-bar');
  if (mainContent) mainContent.style.display = 'block';
  if (bottomBar) bottomBar.style.display = 'flex';
  const navStrip = document.getElementById('exam-section-nav') || document.getElementById('section-nav-strip') || document.querySelector('.section-tabs-wrap');
  if (navStrip && testData?.sections && testData.sections.length > 1) {
    navStrip.style.display = 'flex';
  }

  // Resume audio playback if it was active before exiting
  if (wasAudioPlayingBeforeExit) {
    const player = document.getElementById('exam-audio-element');
    if (player && !player.ended) {
      player.play().catch(() => {});
    }
    wasAudioPlayingBeforeExit = false;
  }
}

function triggerReenterFullscreen(e) {
  if (e && e.preventDefault) {
    try { e.preventDefault(); } catch (_) {}
  }
  const now = Date.now();
  if (now - lastReenterTs < 400) return;
  lastReenterTs = now;

  // 1. Try Native Fullscreen synchronously to preserve user gesture
  try {
    const promise = requestNativeFullscreen();
    if (promise && promise.then) {
      promise.then(() => {
        console.log('[Fullscreen] Native fullscreen granted successfully.');
        window.isMobileFallbackFullscreenActive = false;
        document.documentElement.classList.remove('ot-mobile-pseudo-fullscreen');
        document.body.classList.remove('ot-mobile-pseudo-fullscreen');
        dismissFullscreenRecoveryTimer();
      }).catch(err => {
        console.warn('[Fullscreen] Native request rejected/blocked. Activating Mobile Fallback Fullscreen:', err ? err.message : err);
        activateMobileFallbackFullscreen();
        dismissFullscreenRecoveryTimer();
      });
      return;
    }
  } catch (err) {
    console.warn('[Fullscreen] Native call failed synchronously. Activating Fallback:', err ? err.message : err);
  }

  // 2. If API is unsupported (iOS Safari / WebView)
  activateMobileFallbackFullscreen();
  dismissFullscreenRecoveryTimer();
}

window.triggerReenterFullscreen = triggerReenterFullscreen;

function registerStrike(type, details) {
  handleSecurityInfraction(type, details);
}

function handleWindowBlur(e) {
  if (!isExamActive || isSubmitted) return;
  const now = Date.now();
  window.lastBlurTimestamp = now;

  // If user initiated photo capture or is in post-photo fullscreen recovery window:
  if (window.isCapturingPhoto || window.isPostPhotoRecoveryActive) {
    console.log('[Proctoring] Student taking/handling photo. Blur strike waived.');
    return; // Do NOT trigger strike immediately
  }

  // For any other blur/tab-switch, trigger normal warning/strike
  registerStrike('window_blur', 'Exam window lost focus.');
}

function handleWindowFocus(e) {
  if (!isExamActive || isSubmitted) return;
  const now = Date.now();
  if (window.isCapturingPhoto && window.photoCaptureStartTime) {
    const elapsedMs = now - window.photoCaptureStartTime;
    const elapsedSec = Math.round(elapsedMs / 1000);

    // Reset photo capture flag
    window.isCapturingPhoto = false;
    window.photoCaptureStartTime = null;
    if (window.photoGraceTimer) {
      clearTimeout(window.photoGraceTimer);
      window.photoGraceTimer = null;
    }

    if (elapsedMs <= 120000) {
      console.log(`[Proctoring] Returned from photo capture in ${elapsedSec}s (within 2 min limit). Strike waived.`);
      return; // Waived! No strike recorded.
    } else {
      console.warn(`[Proctoring] Photo capture took ${elapsedSec}s (> 120s limit). Recording strike.`);
      registerStrike('photo_timeout_exceeded', `Photo capture took ${elapsedSec}s (> 120s limit).`);
      return;
    }
  }
}

function handleSecurityInfraction(type, details) {
  if (!isExamActive || isSubmitted) return;

  const now = Date.now();
  // Debounce duplicate triggers within 1500ms
  if (now - lastInfractionTime < 1500) {
    return;
  }
  lastInfractionTime = now;
  strikesCount++;

  const violation = {
    type: type,
    strike: strikesCount,
    timestamp: new Date().toISOString(),
    details: details || ''
  };
  securityViolations.push(violation);

  // Update top bar strike badge
  const strikePill = document.getElementById('exam-strikes-pill');
  const strikeText = document.getElementById('exam-strikes-text');
  if (strikePill && strikeText) {
    strikePill.style.display = 'inline-flex';
    strikeText.innerText = `Strike ${strikesCount} of ${MAX_STRIKES}`;
  }

  if (strikesCount >= MAX_STRIKES) {
    // Strike 2 Termination & Auto-Submission
    const warningModal = document.getElementById('lockdown-warning-modal');
    if (warningModal) warningModal.style.display = 'none';
    const resumeOverlay = document.getElementById('fullscreen-resume-overlay');
    if (resumeOverlay) resumeOverlay.style.display = 'none';
    document.getElementById('lockdown-terminated-modal').style.display = 'flex';
    executeSubmission('tab_switch_limit');
  }
}

function resumeFullscreenFromGate(e) {
  triggerReenterFullscreen(e);
}

function resumeFullscreen(e) {
  triggerReenterFullscreen(e);
}

// Fullscreen exit & resume detection
function handleFullscreenChange() {
  const isFs = isExamInFullscreen();

  if (!isFs && isExamActive && !isSubmitted) {
    if (window.isCapturingPhoto) {
      console.log('[Proctoring] Fullscreen exited during camera/photo capture. 2-minute grace active.');
      return;
    }
    if (window.isPostPhotoRecoveryActive) {
      console.log('[Proctoring] Fullscreen absent during photo recovery window. Compliance timer active.');
      const recOverlay = document.getElementById('ot-fullscreen-recovery-overlay');
      if (recOverlay) recOverlay.style.display = 'flex';
      const resumeOverlay = document.getElementById('fullscreen-resume-overlay');
      if (resumeOverlay) resumeOverlay.style.display = 'none';
      return;
    }

    // Hide exam content immediately to deter tab switching / unauthorized inspection
    const mainContent = document.getElementById('exam-main-content');
    const bottomBar = document.getElementById('exam-bottom-bar');
    const navStrip = document.getElementById('exam-section-nav') || document.getElementById('section-nav-strip') || document.querySelector('.section-tabs-wrap');
    if (mainContent) mainContent.style.display = 'none';
    if (bottomBar) bottomBar.style.display = 'none';
    if (navStrip) navStrip.style.display = 'none';

    // Pause audio without resetting progress
    const player = document.getElementById('exam-audio-element');
    if (player && !player.paused && !player.ended && player.currentTime > 0) {
      wasAudioPlayingBeforeExit = true;
      player.pause();
    }

    // Show Resume Gate Prompt
    const resumeOverlay = document.getElementById('fullscreen-resume-overlay');
    if (resumeOverlay) resumeOverlay.style.display = 'flex';

    registerStrike('fullscreen_exit', 'Candidate exited fullscreen mode.');
  } else if (isFs && isExamActive && !isSubmitted) {
    // Return to fullscreen: cancel recovery timer, dismiss overlay, 0 strikes!
    if (document.fullscreenElement) {
      window.isMobileFallbackFullscreenActive = false;
      document.documentElement.classList.remove('ot-mobile-pseudo-fullscreen');
      document.body.classList.remove('ot-mobile-pseudo-fullscreen');
    }
    dismissFullscreenRecoveryTimer();

    const resumeOverlay = document.getElementById('fullscreen-resume-overlay');
    if (resumeOverlay) resumeOverlay.style.display = 'none';
    const warningModal = document.getElementById('lockdown-warning-modal');
    if (warningModal) warningModal.style.display = 'none';

    const mainContent = document.getElementById('exam-main-content');
    const bottomBar = document.getElementById('exam-bottom-bar');
    if (mainContent) mainContent.style.display = 'block';
    if (bottomBar) bottomBar.style.display = 'flex';
    const navStrip = document.getElementById('exam-section-nav') || document.getElementById('section-nav-strip') || document.querySelector('.section-tabs-wrap');
    if (navStrip && testData?.sections && testData.sections.length > 1) {
      navStrip.style.display = 'flex';
    }

    // Resume audio playback if it was active before exiting
    if (wasAudioPlayingBeforeExit) {
      const player = document.getElementById('exam-audio-element');
      if (player && !player.ended) {
        player.play().catch(() => {});
      }
      wasAudioPlayingBeforeExit = false;
    }
  }
}

['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'].forEach(evtName => {
  document.addEventListener(evtName, handleFullscreenChange);
});

// Tab visibility detection
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && isExamActive && !isSubmitted) {
    if (window.isCapturingPhoto || window.isPostPhotoRecoveryActive) {
      console.log('[Proctoring] Tab hidden during photo capture/recovery. Grace active.');
      return;
    }
    registerStrike('tab_switch', 'Candidate switched browser tab or minimized window.');
  } else if (document.visibilityState === 'visible' && isExamActive && !isSubmitted) {
    handleWindowFocus();
  }
});

// Window blur & focus detection
window.addEventListener('blur', handleWindowBlur);
window.addEventListener('focus', handleWindowFocus);

// Disable right-click context menu
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  return false;
});

// Disable keyboard shortcuts (Ctrl+C, Ctrl+V, Ctrl+U, Ctrl+S, Ctrl+P, F12, PrintScreen)
document.addEventListener('keydown', (e) => {
  if (e.key === 'F12' || e.key === 'PrintScreen') {
    e.preventDefault();
    e.stopPropagation();
    return false;
  }
  if (e.ctrlKey || e.metaKey) {
    const k = (e.key || '').toLowerCase();
    if (['c', 'v', 'u', 's', 'p'].includes(k)) {
      e.preventDefault();
      e.stopPropagation();
      return false;
    }
    if (e.shiftKey && ['i', 'j', 'c'].includes(k)) {
      e.preventDefault();
      e.stopPropagation();
      return false;
    }
  }
});

// ----------------- 4. AUTO-SUBMIT ON PAGE CLOSE / NAVIGATE (BEACON) -----------------

function handlePageUnload() {
  if (!isExamActive || isSubmitted) return;
  isSubmitted = true;

  try {
    localStorage.setItem('online_test_locked_' + testCode, 'true');
  } catch (_) {}

  const studentName = (
    document.getElementById('student-name-input')?.value ||
    document.getElementById('splash-student-name')?.value ||
    'Candidate'
  ).trim();

  const formattedAnswers = [];
  allQuestionIds.forEach(qId => {
    const entry = clientAnswers.get(qId);
    formattedAnswers.push({
      question_id: qId,
      answer: entry ? entry.answer : '',
      word_count: entry ? entry.word_count : null
    });
  });

  const termReason = strikesCount >= MAX_STRIKES ? 'tab_switch_limit' : 'page_closed';
  const payload = JSON.stringify({
    student_name: studentName,
    device_id: clientDeviceId,
    answers: formattedAnswers,
    termination_reason: termReason,
    security_violations: securityViolations
  });

  const url = `/api/public/online-tests/${encodeURIComponent(testCode)}/submit`;
  if (navigator.sendBeacon) {
    const blob = new Blob([payload], { type: 'application/json' });
    navigator.sendBeacon(url, blob);
  }
}

window.addEventListener('beforeunload', handlePageUnload);
window.addEventListener('pagehide', handlePageUnload);

// ----------------- 5. HEADER & COUNTDOWN TIMER -----------------

function renderExamHeader() {
  document.getElementById('exam-code-badge').innerText = `ACCESS CODE: ${escapeHtml(testCode)}`;
  document.getElementById('exam-title').innerText = testData.title;
  document.getElementById('exam-teacher').innerText = `Instructor / Examination Center: ${testData.teacher_name || 'Teacher'}`;

  if (testData.extra_instructions) {
    const instBox = document.getElementById('exam-instructions-box');
    instBox.style.display = 'block';
    instBox.innerHTML = `<b>Candidate Guidance:</b> ${escapeHtml(testData.extra_instructions)}`;
  }

  if (testData.deadline) {
    const dlDate = new Date(testData.deadline);
    const ddlBox = document.getElementById('exam-deadline-box');
    ddlBox.style.display = 'block';
    ddlBox.innerHTML = `⏳ <b>Deadline:</b> ${formatCairoDateTime(dlDate)} (Cairo Time)`;
  }
}

function startCountdownTimer(deadlineDate) {
  const timerPill = document.getElementById('exam-timer-pill');
  const timerText = document.getElementById('exam-timer-text');
  timerPill.style.display = 'inline-flex';

  function updateClock() {
    const diffMs = deadlineDate.getTime() - Date.now();
    if (diffMs <= 0) {
      timerText.innerText = '00:00:00 (Deadline Reached)';
      timerPill.className = 'timer-pill timer-urgent';
      if (countdownTimerId) {
        clearInterval(countdownTimerId);
        countdownTimerId = null;
      }
      if (isExamActive && !isSubmitted) {
        showToast('⚠️ Examination deadline reached. Please complete your work and submit.');
      }
      return;
    }

    const totalSeconds = Math.floor(diffMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const pad = (n) => String(n).padStart(2, '0');
    timerText.innerText = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;

    if (totalSeconds < 900) { // < 15 mins
      timerPill.className = 'timer-pill timer-urgent';
    }
  }

  updateClock();
  countdownTimerId = setInterval(updateClock, 1000);
}

function renderSectionNav() {
  const navContainer = document.getElementById('exam-section-nav') || document.querySelector('.section-tabs-wrap') || document.getElementById('section-nav-strip');
  if (!navContainer) return;
  navContainer.innerHTML = '';

  const rawSections = (testData && testData.sections) || (window.examData && (window.examData.sections || window.examData.test?.sections)) || [];
  if (rawSections.length <= 1) {
    navContainer.style.display = 'none';
    return;
  }

  // Deduplicate sections using a Set on sec.id to guarantee zero duplicate tabs
  const uniqueSections = [];
  const seenIds = new Set();
  for (const sec of rawSections) {
    if (sec && !seenIds.has(sec.id)) {
      seenIds.add(sec.id);
      uniqueSections.push(sec);
    }
  }

  if (uniqueSections.length <= 1) {
    navContainer.style.display = 'none';
    return;
  }

  uniqueSections.forEach((sec, idx) => {
    const tabBtn = document.createElement('button');
    tabBtn.type = 'button';
    tabBtn.className = `section-tab-btn ${idx === 0 ? 'active' : ''}`;
    tabBtn.id = `sec-tab-${sec.id}`;
    
    let icon = '📖';
    if (sec.section_type === 'listening') icon = '🎧';
    else if (sec.section_type === 'writing') icon = '✍️';
    else if (sec.section_type === 'grammar') icon = '🔤';

    tabBtn.innerHTML = `<span>${icon} Part ${idx + 1}</span>`;
    tabBtn.onclick = () => switchSection(sec.id);
    navContainer.appendChild(tabBtn);
  });

  navContainer.style.display = 'flex';
}

function switchSection(sectionId) {
  scrollToSection(sectionId);
}

function scrollToSection(sectionId) {
  const el = document.getElementById(`section-card-${sectionId}`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.querySelectorAll('.section-tab-btn, .section-nav-btn').forEach(btn => btn.classList.remove('active'));
    const targetNav = document.getElementById(`sec-tab-${sectionId}`) || document.getElementById(`nav-btn-sec-${sectionId}`);
    if (targetNav) targetNav.classList.add('active');
  }
}

// ----------------- 6. AUDIO PLAYER & TRUE SINGLE-PLAY ENFORCEMENT -----------------

function setupAudioTrack(audioUrl) {
  const box = document.getElementById('exam-audio-box');
  const player = document.getElementById('exam-audio-element');
  const btnStart = document.getElementById('btn-start-audio');
  const badge = document.getElementById('audio-plays-badge');
  const lockedNotice = document.getElementById('audio-locked-notice');
  const progressWrap = document.getElementById('audio-progress-wrap');
  const progressBar = document.getElementById('audio-progress-fill') || document.getElementById('audio-progress-bar');
  const timerDisplay = document.getElementById('audio-timer-display') || document.getElementById('audio-time-label');

  if (!box || !player || !btnStart) return;

  if (audioUrl) {
    player.src = audioUrl;
  }
  player.controlsList = "nodownload noplaybackrate nofullscreen";
  player.preload = "auto";

  box.addEventListener('contextmenu', (e) => e.preventDefault());

  const hasPlayed = localStorage.getItem('online_audio_started_' + testCode) === 'true';

  if (hasPlayed) {
    btnStart.style.display = 'none';
    if (progressWrap) progressWrap.style.display = 'none';
    if (timerDisplay) timerDisplay.style.display = 'none';
    if (badge) badge.innerText = 'Audio: Consumed (1/1)';
    if (lockedNotice) {
      lockedNotice.style.display = 'block';
      lockedNotice.innerHTML = '🔒 <b>Single-Play Audio Locked:</b> Audio track has already been played. Under examination regulations, it cannot be re-played or restarted.';
    }
    return;
  }

  if (badge) badge.innerText = 'Single Play Enforced';
  btnStart.style.display = 'inline-flex';
  btnStart.disabled = false;
  btnStart.innerHTML = '<span>▶ Play Audio Track</span>';
  btnStart.onclick = () => startAudioPlayback();

  player.onpause = () => {
    // If not paused by the exit gate handler and not finished, resume immediately
    if (!player.ended && player.currentTime > 0 && !wasAudioPlayingBeforeExit) {
      player.play().catch(() => {});
      showToast('⚠️ Exam audio cannot be paused during the test.');
    }
  };

  player.ontimeupdate = () => {
    if (player.duration && progressWrap && progressBar && timerDisplay) {
      progressWrap.style.display = 'block';
      timerDisplay.style.display = 'inline-block';
      const pct = (player.currentTime / player.duration) * 100;
      progressBar.style.width = `${pct}%`;

      const curM = Math.floor(player.currentTime / 60);
      const curS = Math.floor(player.currentTime % 60);
      const durM = Math.floor(player.duration / 60);
      const durS = Math.floor(player.duration % 60);
      const pad = (n) => String(n).padStart(2, '0');
      timerDisplay.innerText = `${pad(curM)}:${pad(curS)} / ${pad(durM)}:${pad(durS)}`;
    }
  };

  player.onended = () => {
    btnStart.style.display = 'none';
    if (progressWrap) progressWrap.style.display = 'none';
    if (timerDisplay) timerDisplay.style.display = 'none';
    if (badge) badge.innerText = 'Audio: Complete';
    if (lockedNotice) {
      lockedNotice.style.display = 'block';
      lockedNotice.innerHTML = '🔒 <b>Single-Play Audio Locked:</b> Audio track has already been played. Under examination regulations, it cannot be re-played or restarted.';
    }
  };

  player.onerror = async () => {
    if (player.currentTime > 0 && !player.ended) {
      try {
        const refreshRes = await fetch(`/api/public/online-tests/${encodeURIComponent(testCode)}/audio-url`);
        const refreshData = await refreshRes.json();
        if (refreshData.success && refreshData.audio_url) {
          const curTime = player.currentTime;
          player.src = refreshData.audio_url;
          player.currentTime = curTime;
          player.play().catch(() => {});
        }
      } catch (err) {
        console.error('Audio stream refresh error:', err);
      }
    }
  };
}

function startAudioPlayback() {
  const player = document.getElementById('exam-audio-element');
  const btnStart = document.getElementById('btn-start-audio');
  const progressWrap = document.getElementById('audio-progress-wrap');
  const timerDisplay = document.getElementById('audio-timer-display') || document.getElementById('audio-time-label');

  if (!player || localStorage.getItem('online_audio_started_' + testCode) === 'true') return;

  // HARD SINGLE-PLAY LOCK: Persist immediately to localStorage keyed to testCode
  localStorage.setItem('online_audio_started_' + testCode, 'true');

  btnStart.disabled = true;
  btnStart.innerHTML = '<span>🔊 Playing Audio Track...</span>';
  if (progressWrap) progressWrap.style.display = 'block';
  if (timerDisplay) timerDisplay.style.display = 'inline-block';

  player.play().catch((err) => {
    console.error('Audio playback error:', err);
    showToast('Click again to start audio playback.');
    btnStart.disabled = false;
    btnStart.innerHTML = '<span>▶ Play Audio Track</span>';
    localStorage.removeItem('online_audio_started_' + testCode);
  });
}

// ----------------- 7. SECTIONS & QUESTIONS RENDERING -----------------

function formatSectionInstructions(text) {
  if (!text) return '';
  const pipeMatch = text.match(/(?:\[\s*)?([A-Za-z0-9_\-']+(?:\s+[A-Za-z0-9_\-']+)?(?:\s*\|\s*[A-Za-z0-9_\-']+(?:\s+[A-Za-z0-9_\-']+)?)+)(?:\s*\])?/);
  if (pipeMatch) {
    const rawWords = pipeMatch[1].split('|').map(w => w.trim()).filter(Boolean);
    if (rawWords.length >= 2) {
      const cleanPrompt = text.replace(pipeMatch[0], '').trim();
      return `
        <div class="section-instructions">
          <div>${escapeHtml(cleanPrompt)}</div>
          <div class="word-bank-chips" style="margin-top: 10px;">
            ${rawWords.map(w => `<span class="word-chip page-chip" style="cursor: default;">${escapeHtml(w)}</span>`).join('')}
          </div>
        </div>
      `;
    }
  }
  return `<div class="section-instructions">${escapeHtml(text)}</div>`;
}

function renderSections() {
  const container = document.getElementById('exam-sections-container');
  if (!container) return;
  container.innerHTML = '';
  allQuestionIds = [];

  const examData = window.examData || { test: testData, sections: (testData && testData.sections) || [] };
  const rawSections = (testData && testData.sections) || (examData && examData.sections) || [];
  
  // Deduplicate sections using a Set on sec.id to guarantee zero duplicate sections
  const uniqueSections = [];
  const seenIds = new Set();
  for (const sec of rawSections) {
    if (sec && !seenIds.has(sec.id)) {
      seenIds.add(sec.id);
      uniqueSections.push(sec);
    }
  }

  const hasListeningTypeSection = uniqueSections.some(s => s.section_type === 'listening');

  uniqueSections.forEach((sec, sIdx) => {
    const secTypeBadge = getSectionTypeBadge(sec.section_type);
    const questions = sec.questions || [];
    questions.forEach(q => allQuestionIds.push(q.id));

    let prevGroupKey = null;
    const questionsHtml = questions.map((q, qIdx) => {
      let groupHeaderHtml = '';
      const currentGroupTitle = (q.group_title || '').trim();
      const currentGroupInstructions = (q.group_instructions || '').trim();

      let currentSharedBank = null;
      if (Array.isArray(q.shared_word_bank) && q.shared_word_bank.length > 0) {
        currentSharedBank = q.shared_word_bank;
      } else if (typeof q.shared_word_bank === 'string' && q.shared_word_bank.trim()) {
        try {
          let parsed = JSON.parse(q.shared_word_bank);
          if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch (_) {} }
          if (Array.isArray(parsed) && parsed.length > 0) currentSharedBank = parsed;
        } catch (_) {
          const parts = q.shared_word_bank.split(/[|,]/).map(s => s.trim()).filter(Boolean);
          if (parts.length > 0) currentSharedBank = parts;
        }
      }

      // Group key based on title, instructions, or word bank
      const groupKey = currentGroupTitle || currentGroupInstructions || (currentSharedBank ? currentSharedBank.join('|') : '');
      const hasGroup = Boolean(groupKey);

      // Render group header once at the start of each distinct group of questions
      if (hasGroup && groupKey !== prevGroupKey) {
        prevGroupKey = groupKey;
        let wordBankChipsHtml = '';
        if (currentSharedBank && currentSharedBank.length > 0) {
          wordBankChipsHtml = `
            <div class="q-group-word-bank">
              <div class="q-group-bank-label">🔤 Word Bank / Reference Terms (Click to insert):</div>
              <div class="q-group-bank-chips">
                ${currentSharedBank.map(word => `
                  <span class="word-chip q-group-chip page-chip" onclick="insertWordIntoActiveInput('${escapeHtml(word).replace(/'/g, "\\'")}')">
                    ${escapeHtml(word)}
                  </span>
                `).join('')}
              </div>
            </div>
          `;
        }

        groupHeaderHtml = `
          <div class="q-group-header-card">
            ${currentGroupTitle ? `<div class="q-group-title">📌 ${escapeHtml(currentGroupTitle)}</div>` : ''}
            ${currentGroupInstructions ? `<div class="q-group-instructions">${escapeHtml(currentGroupInstructions)}</div>` : ''}
            ${wordBankChipsHtml}
          </div>
        `;
      } else if (!hasGroup) {
        prevGroupKey = null;
      }

      return groupHeaderHtml + renderQuestion(sec, q, qIdx + 1);
    }).join('');

    const sectionEl = document.createElement('section');
    sectionEl.className = 'section-card';
    sectionEl.id = `section-card-${sec.id}`;

    sectionEl.innerHTML = `
      <div class="section-head">
        <div style="display:flex; align-items:center; gap:10px;">
          <span style="font-family:'IBM Plex Mono',monospace; font-size:12px; font-weight:700; background:var(--pen); color:#fff; padding:3px 8px; border-radius:4px;">
            Part ${sec.part_number || (sIdx + 1)}
          </span>
          <h2 class="section-title">${escapeHtml(sec.section_title)}</h2>
        </div>
        ${secTypeBadge}
      </div>

      ${sec.instructions_text ? formatSectionInstructions(sec.instructions_text) : ''}

      ${sec.passage_text ? `
        <div class="passage-box">
          <div class="passage-header">
            <span class="passage-title">📖 Reading / Stimulus Text:</span>
          </div>
          <div class="passage-content">${escapeHtml(sec.passage_text)}</div>
        </div>
      ` : ''}

      <div class="questions-list questions-wrap ot-vertical-questions-list">
        ${questionsHtml}
      </div>
    `;

    // Audio Relocation to Specific Listening Section
    const isExplicitNonListening = ['reading', 'writing', 'grammar'].includes(sec.section_type);
    const isListening = (sec.section_type === 'listening') ||
      Boolean(sec.audio_url) ||
      (!hasListeningTypeSection && !isExplicitNonListening && Boolean((testData && testData.audio_url) || (examData && (examData.audio_url || examData.test?.audio_url))));

    // Only inject the audio player if this section is the designated listening section
    if (isListening && !document.getElementById('exam-audio-box') && !container.querySelector('#exam-audio-box')) {
      const audioBar = document.createElement('div');
      audioBar.className = 'section-audio-banner';
      audioBar.id = 'exam-audio-box';
      audioBar.innerHTML = `
        <div class="audio-head">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 18px;">🎧</span>
            <span style="font-size: 14px; font-weight: 700; color: var(--pen, #1D3A66);">Listening Examination Track</span>
          </div>
          <span class="audio-badge" id="audio-plays-badge">Single Play Enforced</span>
        </div>
        <audio id="exam-audio-element" controlsList="nodownload noplaybackrate nofullscreen" preload="auto" style="display: none;"></audio>
        <div class="audio-controls-row" style="margin-top: 10px; display: flex; align-items: center; gap: 12px;">
          <button type="button" class="btn-primary audio-btn-start" id="btn-start-audio" style="display: flex; align-items: center; gap: 6px;">
            <span>▶ Play Audio Track</span>
          </button>
          <div class="audio-progress-wrap" id="audio-progress-wrap" style="flex: 1; height: 8px; background: #e2e8f0; border-radius: 4px; overflow: hidden; display: none;">
            <div id="audio-progress-fill" class="audio-progress-bar" style="width: 0%; height: 100%; background: var(--primary, #2563eb); transition: width 0.2s linear;"></div>
          </div>
          <span id="audio-timer-display" class="audio-time-label" style="font-size: 12px; font-weight: 600; color: var(--ink-soft, #4A5670); display: none;">00:00 / 00:00</span>
        </div>
        <div id="audio-locked-notice" style="display: none; margin-top: 10px; font-size: 13px; color: var(--danger, #dc2626); font-weight: 600; background: var(--danger-bg, #fef2f2); border: 1px solid #fca5a5; padding: 10px 14px; border-radius: 6px;">
          🔒 <b>Single-Play Audio Locked:</b> Audio track has already been played. Under examination regulations, it cannot be re-played or restarted.
        </div>
      `;
      // Insert immediately below section instructions and above questions list
      const questionsList = sectionEl.querySelector('.questions-wrap') || sectionEl.querySelector('.ot-vertical-questions-list') || sectionEl.querySelector('.questions-list');
      if (questionsList) {
        sectionEl.insertBefore(audioBar, questionsList);
      } else {
        sectionEl.appendChild(audioBar);
      }
    }

    container.appendChild(sectionEl);
  });

  const listeningAudioUrl = (testData && testData.audio_url) || (examData && (examData.audio_url || examData.test?.audio_url));
  if (document.getElementById('exam-audio-box') && listeningAudioUrl) {
    setupAudioTrack(listeningAudioUrl);
  }
}

function getSectionTypeBadge(type) {
  const t = (type || 'general').toLowerCase();
  switch (t) {
    case 'listening': return '<span class="type-badge type-listening">🎧 Listening</span>';
    case 'reading': return '<span class="type-badge type-reading">📖 Reading</span>';
    case 'writing': return '<span class="type-badge type-writing">✍️ Writing</span>';
    case 'grammar': return '<span class="type-badge type-grammar">🔤 Grammar</span>';
    default: return '<span class="type-badge type-general">📝 General</span>';
  }
}

function insertWordIntoInput(qId, word) {
  const input = document.getElementById(`input-q-${qId}`);
  if (!input) return;
  input.value = word;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  handleAnswerInput(qId, word);
  input.focus();
}

function insertWordIntoActiveInput(word) {
  let targetInput = window.lastFocusedInput;
  if (!targetInput || !document.contains(targetInput)) {
    targetInput = document.querySelector('.ot-text-input:focus, .ot-writing-textarea:focus');
  }
  if (!targetInput) {
    const allInputs = Array.from(document.querySelectorAll('.ot-text-input, .ot-writing-textarea'));
    targetInput = allInputs.find(inp => !inp.value.trim()) || allInputs[0];
  }
  if (!targetInput) return;

  targetInput.value = word;
  targetInput.dispatchEvent(new Event('input', { bubbles: true }));
  const match = targetInput.id && targetInput.id.match(/^input-q-(\d+)$/);
  if (match) {
    handleAnswerInput(parseInt(match[1], 10), word);
  }
  targetInput.focus();
}

// Track focused text inputs for effortless word-chip insertion
if (typeof document !== 'undefined') {
  document.addEventListener('focusin', (e) => {
    if (e.target && (e.target.matches('.ot-text-input') || e.target.matches('.ot-writing-textarea'))) {
      window.lastFocusedInput = e.target;
    }
  });
}

function renderQuestion(sec, q, displayNum) {
  const qType = q.question_type || 'mcq';
  const pts = q.points || 1;
  const rawQText = q.question_text || '';

  // Extract word banks from question text or structured options if present
  let processedQText = rawQText;
  let wordBankHtml = '';

  // Parse question's word_bank or shared_word_bank if present
  let qSharedBank = null;
  const rawBank = q.word_bank || q.shared_word_bank;
  if (Array.isArray(rawBank) && rawBank.length > 0) {
    qSharedBank = rawBank;
  } else if (typeof rawBank === 'string' && rawBank.trim()) {
    try {
      let p = JSON.parse(rawBank);
      if (typeof p === 'string') { try { p = JSON.parse(p); } catch (_) {} }
      if (Array.isArray(p) && p.length > 0) qSharedBank = p;
    } catch (_) {
      const parts = rawBank.split(/[|,]/).map(s => s.trim()).filter(Boolean);
      if (parts.length > 0) qSharedBank = parts;
    }
  }

  // 1. Check if q.word_bank or q.shared_word_bank is provided for non-MCQ types (word bank from ingestion)
  if (['fill_blank', 'rewrite', 'short_answer'].includes(qType)) {
    const bankTerms = (Array.isArray(q.word_bank) && q.word_bank.length > 0) ? q.word_bank : (qSharedBank || []);
    if (bankTerms.length > 0) {
      wordBankHtml = `
        <div class="word-bank-box" style="border:1.5px dashed #3b82f6; background:#eff6ff; border-radius:8px; padding:10px 14px; margin-bottom:12px;">
          <div class="word-bank-header" style="font-weight:700; font-size:12px; color:#1e40af; margin-bottom:6px; display:flex; align-items:center; gap:6px;">
            <span>🔤 Word Bank (Click a word or choose from dropdown):</span>
          </div>
          <div class="word-bank-chips" style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px;">
            ${bankTerms.map(opt => `
              <span class="word-chip q-group-chip page-chip" style="cursor:pointer; background:#fff; border:1px solid #93c5fd; color:#1e3a8a; padding:3px 10px; border-radius:6px; font-weight:600; font-size:12px; box-shadow:0 1px 2px rgba(0,0,0,0.05);" onclick="insertWordIntoInput(${q.id}, '${escapeHtml(opt).replace(/'/g, "\\'")}')">
                ${escapeHtml(opt)}
              </span>
            `).join('')}
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-size:12px; font-weight:600; color:#1e40af;">Select:</span>
            <select class="ot-select ot-bank-dropdown" onchange="if (this.value) { insertWordIntoInput(${q.id}, this.value); this.value=''; }" style="max-width:300px; padding:4px 8px; font-size:12px; border:1px solid #93c5fd; border-radius:6px; background:#fff;">
              <option value="">-- Choose from Word Bank --</option>
              ${bankTerms.map(opt => `<option value="${escapeHtml(opt)}">${escapeHtml(opt)}</option>`).join('')}
            </select>
          </div>
        </div>
      `;
    }
  }

  // 2. Also check if raw question text contains pipe-separated word bank (e.g. "Although | Whereas | While" or "[Although | Whereas | While]")
  const pipeBankMatch = rawQText.match(/(?:\[\s*)?([A-Za-z0-9_\-']+(?:\s+[A-Za-z0-9_\-']+)?(?:\s*\|\s*[A-Za-z0-9_\-']+(?:\s+[A-Za-z0-9_\-']+)?)+)(?:\s*\])?/);
  if (pipeBankMatch && !wordBankHtml) {
    const rawBank = pipeBankMatch[1];
    const words = rawBank.split('|').map(w => w.trim()).filter(Boolean);
    if (words.length >= 2) {
      wordBankHtml = `
        <div class="word-bank-box" style="border:1.5px dashed #3b82f6; background:#eff6ff; border-radius:8px; padding:10px 14px; margin-bottom:12px;">
          <div class="word-bank-header" style="font-weight:700; font-size:12px; color:#1e40af; margin-bottom:6px; display:flex; align-items:center; gap:6px;">
            <span>🔤 Word Bank (Click a word or choose from dropdown):</span>
          </div>
          <div class="word-bank-chips" style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px;">
            ${words.map(w => `
              <span class="word-chip q-group-chip page-chip" style="cursor:pointer; background:#fff; border:1px solid #93c5fd; color:#1e3a8a; padding:3px 10px; border-radius:6px; font-weight:600; font-size:12px; box-shadow:0 1px 2px rgba(0,0,0,0.05);" onclick="insertWordIntoInput(${q.id}, '${escapeHtml(w).replace(/'/g, "\\'")}')">
                ${escapeHtml(w)}
              </span>
            `).join('')}
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-size:12px; font-weight:600; color:#1e40af;">Select:</span>
            <select class="ot-select ot-bank-dropdown" onchange="if (this.value) { insertWordIntoInput(${q.id}, this.value); this.value=''; }" style="max-width:300px; padding:4px 8px; font-size:12px; border:1px solid #93c5fd; border-radius:6px; background:#fff;">
              <option value="">-- Choose from Word Bank --</option>
              ${words.map(opt => `<option value="${escapeHtml(opt)}">${escapeHtml(opt)}</option>`).join('')}
            </select>
          </div>
        </div>
      `;
      processedQText = rawQText.replace(pipeBankMatch[0], '').trim();
    }
  }

  let stimulusHtml = '';
  if (q.stimulus_image_url) {
    stimulusHtml = `
      <div class="q-stimulus-wrap">
        <div class="q-stimulus-bar">
          <span class="q-stimulus-label">Stimulus Diagram / Figure</span>
          <button type="button" class="q-stimulus-expand-btn" onclick="openDiagramLightbox('${escapeHtml(q.stimulus_image_url)}')">🔍 Click to Enlarge</button>
        </div>
        <div class="q-stimulus-img-container">
          <img src="${escapeHtml(q.stimulus_image_url)}" alt="Stimulus Diagram for Question ${displayNum}" class="q-stimulus-img" onclick="openDiagramLightbox('${escapeHtml(q.stimulus_image_url)}')" />
        </div>
      </div>
    `;
  }

  let inputMarkup = '';

  if (qType === 'mcq') {
    let opts = Array.isArray(q.options) ? q.options : [];
    const hasAnyImageUrl = opts.some(opt => typeof opt === 'object' && opt !== null && Boolean(opt.image_url || opt.imageUrl));
    const isVisual = (Number(q.has_visual_options) === 1 || q.has_visual_options === true) && hasAnyImageUrl;

    if (isVisual) {
      inputMarkup = `
        <div class="mcq-visual-options-grid" id="mcq-group-${q.id}">
          ${opts.map((opt, oIdx) => {
            const rawL = (opt && opt.label) ? String(opt.label).trim().toUpperCase() : String.fromCharCode(65 + oIdx);
            const letter = rawL === 'S' ? 'C' : (['A', 'B', 'C', 'D'].includes(rawL) ? rawL : String.fromCharCode(65 + oIdx));
            const imgUrl = (opt && (opt.image_url || opt.imageUrl)) ? (opt.image_url || opt.imageUrl) : '';
            const caption = (opt && (opt.caption || opt.value || opt.text)) ? (opt.caption || opt.value || opt.text) : (typeof opt === 'string' ? opt : '');
            return `
              <div class="mcq-visual-card" id="mcq-opt-${q.id}-${oIdx}" onclick="handleSelectMcq(${q.id}, '${oIdx}')">
                ${imgUrl ? `
                  <div class="mcq-visual-img-wrap">
                    <img src="${escapeHtml(imgUrl)}" alt="Picture ${letter}" class="mcq-visual-img" loading="lazy" onclick="event.stopPropagation(); openDiagramLightbox('${escapeHtml(imgUrl)}')" />
                  </div>
                ` : ''}
                <div class="mcq-visual-footer">
                  <div class="mcq-visual-radio-indicator"></div>
                  <div class="mcq-visual-text-block">
                    <span class="mcq-visual-letter">${imgUrl ? `Picture ${letter}` : `${letter}.`}</span>
                    ${caption ? `<span class="mcq-visual-caption">${escapeHtml(caption)}</span>` : ''}
                  </div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `;
    } else {
      inputMarkup = `
        <div class="mcq-options-grid" id="mcq-group-${q.id}">
          ${opts.map((opt, oIdx) => {
            const rawL = (typeof opt === 'object' && opt && opt.label) ? String(opt.label).trim().toUpperCase() : String.fromCharCode(65 + oIdx);
            const letter = rawL === 'S' ? 'C' : (['A', 'B', 'C', 'D'].includes(rawL) ? rawL : String.fromCharCode(65 + oIdx));
            const rawVal = (typeof opt === 'object' && opt !== null) ? (opt.value !== undefined ? opt.value : (opt.text || opt.caption || opt.statement || '')) : String(opt || '');
            const textVal = String(rawVal || '').replace(/^[A-E][.:]\s*/i, '').trim();
            return `
              <div class="mcq-choice-row" id="mcq-opt-${q.id}-${oIdx}" onclick="handleSelectMcq(${q.id}, '${oIdx}')">
                <span class="mcq-letter">${letter}</span>
                <span class="mcq-text" style="word-break:break-word; overflow-wrap:break-word; overflow:visible;">${escapeHtml(textVal)}</span>
              </div>
            `;
          }).join('')}
        </div>
      `;
    }
  } else if (qType === 'matching') {
    const opts = Array.isArray(q.options) ? q.options : [];
    inputMarkup = `
      <select class="ot-select-input" id="input-q-${q.id}" onchange="handleAnswerInput(${q.id}, this.value)">
        <option value="">-- Select matching option --</option>
        ${opts.map((opt, oIdx) => {
          const letter = (typeof opt === 'object' && opt && opt.label) ? opt.label : String.fromCharCode(65 + oIdx);
          const textVal = (typeof opt === 'object' && opt !== null) ? (opt.text !== undefined ? opt.text : (opt.statement !== undefined ? opt.statement : (opt.value !== undefined ? opt.value : (opt.caption || '')))) : String(opt || '');
          return `
            <option value="${oIdx}">Option ${letter}: ${escapeHtml(textVal)}</option>
          `;
        }).join('')}
      </select>
    `;
  } else if (['fill_blank', 'rewrite', 'short_answer'].includes(qType)) {
    inputMarkup = `
      ${wordBankHtml}
      <input type="text" class="ot-text-input" id="input-q-${q.id}"
        autocomplete="off" spellcheck="false" placeholder="Type your answer here..."
        oninput="handleAnswerInput(${q.id}, this.value)" />
    `;
  } else if (qType === 'writing') {
    const minW = q.min_words;
    const maxW = q.max_words;
    const boundsLabel = minW && maxW
      ? `(Target: ${minW}–${maxW} words)`
      : (minW ? `(Minimum: ${minW} words)` : (maxW ? `(Maximum: ${maxW} words)` : ''));

    inputMarkup = `
      <div class="ot-writing-container" id="ot-writing-box-${q.id}" data-question-id="${q.id}">
        <div class="ot-writing-mode-tabs">
          <button type="button" class="ot-mode-tab active" id="tab-type-${q.id}" data-mode="type" onclick="switchWritingMode(${q.id}, 'type')">
            ⌨️ Type Response
          </button>
          <button type="button" class="ot-mode-tab" id="tab-photo-${q.id}" data-mode="photo" onclick="switchWritingMode(${q.id}, 'photo')">
            📸 Upload Handwritten Photos
          </button>
        </div>

        <!-- Mode A: Type Response -->
        <div class="ot-mode-panel ot-panel-type active" id="panel-type-${q.id}">
          <textarea class="ot-writing-textarea" id="input-q-${q.id}" rows="8"
            placeholder="Type your essay or response here..."
            oninput="handleWritingInput(${q.id}, this.value, ${minW || 0}, ${maxW || 0})"></textarea>
          <div class="word-counter-badge" id="wc-badge-${q.id}">
            <span>Words: <b id="wc-count-${q.id}">0</b></span>
            <span>${boundsLabel}</span>
          </div>
        </div>

        <!-- Mode B: Multi-Page Photo Upload -->
        <div class="ot-mode-panel ot-panel-photo" id="panel-photo-${q.id}" style="display:none;">
          <div class="ot-photo-dropzone" id="dropzone-${q.id}" onclick="markPhotoCaptureStart(${q.id}); document.getElementById('file-input-${q.id}').click()">
            <div class="ot-dropzone-icon">📷</div>
            <div class="ot-dropzone-text">Tap to take photo or choose pages</div>
            <div class="ot-dropzone-sub">Supports camera photos, JPG, PNG (multi-page enabled, auto-compressed)</div>
          </div>
          <input type="file" id="file-input-${q.id}" accept="image/*" capture="environment" multiple style="display:none;" onclick="markPhotoCaptureStart(${q.id})" onfocus="markPhotoCaptureStart(${q.id})" onchange="handleEssayPhotosSelected(${q.id}, this.files)">
          <div class="ot-photo-pages-list" id="photo-list-${q.id}"></div>
          <div class="ot-photo-summary" id="photo-summary-${q.id}" style="display:none;"></div>
        </div>
      </div>
    `;
  }

  return `
    <div class="q-card" id="q-card-${q.id}">
      <div class="q-head">
        <span class="q-num">Question ${displayNum}</span>
        <span class="q-points">${pts} Mark${pts === 1 ? '' : 's'}</span>
      </div>
      <div class="q-text">${escapeHtml(processedQText)}</div>
      ${stimulusHtml}
      ${inputMarkup}
    </div>
  `;
}

// ----------------- 8. ANSWER HANDLING & REACTIVE WORD COUNTER -----------------

function handleSelectMcq(questionId, optIndexStr) {
  const group = document.getElementById(`mcq-group-${questionId}`);
  if (group) {
    group.querySelectorAll('.mcq-choice-row, .mcq-visual-card').forEach(row => row.classList.remove('selected'));
  }
  const selectedRow = document.getElementById(`mcq-opt-${questionId}-${optIndexStr}`);
  if (selectedRow) selectedRow.classList.add('selected');

  clientAnswers.set(questionId, { answer: optIndexStr, word_count: null });
  updateCompletionCount();
}

function openDiagramLightbox(src) {
  if (!src) return;
  let modal = document.getElementById('diagram-lightbox-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'diagram-lightbox-modal';
    modal.className = 'diagram-lightbox-overlay';
    modal.onclick = closeDiagramLightbox;
    modal.innerHTML = `
      <div class="diagram-lightbox-content" onclick="event.stopPropagation()">
        <button type="button" class="diagram-lightbox-close" onclick="closeDiagramLightbox()">✕</button>
        <img id="diagram-lightbox-img" src="" alt="Enlarged Diagram" />
      </div>
    `;
    document.body.appendChild(modal);
  }
  const img = document.getElementById('diagram-lightbox-img');
  if (img) img.src = src;
  modal.style.display = 'flex';
}

function closeDiagramLightbox() {
  const modal = document.getElementById('diagram-lightbox-modal');
  if (modal) modal.style.display = 'none';
}

function handleAnswerInput(questionId, val) {
  const cleanVal = (val || '').trim();
  if (cleanVal) {
    clientAnswers.set(questionId, { answer: cleanVal, word_count: null });
  } else {
    clientAnswers.delete(questionId);
  }
  updateCompletionCount();
  refreshMatchingOptionDisables();
}

function refreshMatchingOptionDisables() {
  if (!currentOnlineTestData || !Array.isArray(currentOnlineTestData.sections)) return;
  for (const sec of currentOnlineTestData.sections) {
    const matchingQs = (sec.questions || []).filter(q => q.question_type === 'matching');
    if (matchingQs.length <= 1) continue;
    const selectedMap = new Map();
    for (const mq of matchingQs) {
      const ans = clientAnswers.get(mq.id);
      if (ans && ans.answer !== undefined && ans.answer !== '') {
        selectedMap.set(ans.answer.toString(), mq.id);
      }
    }

    for (const mq of matchingQs) {
      const selectEl = document.getElementById(`input-q-${mq.id}`);
      if (!selectEl) continue;
      for (const optEl of selectEl.options) {
        if (!optEl.value) continue;
        const whoSelected = selectedMap.get(optEl.value);
        if (whoSelected && whoSelected !== mq.id) {
          optEl.disabled = true;
          if (!optEl.text.includes('(already selected)')) {
            optEl.text = optEl.text + ' (already selected)';
          }
        } else {
          optEl.disabled = false;
          optEl.text = optEl.text.replace(' (already selected)', '');
        }
      }
    }
  }
}

window.writingPages = window.writingPages || {};
window.writingModes = window.writingModes || {};

function switchWritingMode(questionId, mode) {
  window.writingModes[questionId] = mode;
  const tabType = document.getElementById(`tab-type-${questionId}`);
  const tabPhoto = document.getElementById(`tab-photo-${questionId}`);
  const panelType = document.getElementById(`panel-type-${questionId}`);
  const panelPhoto = document.getElementById(`panel-photo-${questionId}`);

  if (mode === 'photo') {
    if (tabType) tabType.classList.remove('active');
    if (tabPhoto) tabPhoto.classList.add('active');
    if (panelType) panelType.style.display = 'none';
    if (panelPhoto) panelPhoto.style.display = 'block';

    const pages = window.writingPages[questionId] || [];
    if (pages.length > 0) {
      clientAnswers.set(questionId, {
        mode: 'photo',
        answer: '',
        word_count: null,
        essay_images: pages.map(p => p.dataUrl)
      });
    } else {
      clientAnswers.delete(questionId);
    }
  } else {
    if (tabPhoto) tabPhoto.classList.remove('active');
    if (tabType) tabType.classList.add('active');
    if (panelPhoto) panelPhoto.style.display = 'none';
    if (panelType) panelType.style.display = 'block';

    const textarea = document.getElementById(`input-q-${questionId}`);
    const text = (textarea ? textarea.value : '').trim();
    if (text) {
      const words = text.match(/\S+/g);
      clientAnswers.set(questionId, {
        mode: 'type',
        answer: text,
        word_count: words ? words.length : 0
      });
    } else {
      clientAnswers.delete(questionId);
    }
  }
  updateCompletionCount();
}

async function compressImageFile(file, maxDimension = 2048, quality = 0.82) {
  if (!file || !file.type || !file.type.startsWith('image/')) {
    return file;
  }
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(file);
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => resolve(file);
      img.onload = () => {
        try {
          let width = img.naturalWidth || img.width;
          let height = img.naturalHeight || img.height;
          if (!width || !height) return resolve(file);

          const MAX_PIXELS = 16000000;
          const currentPixels = width * height;
          let safeMaxDim = maxDimension;
          if (currentPixels > MAX_PIXELS) {
            const downscaleRatio = Math.sqrt(MAX_PIXELS / currentPixels);
            safeMaxDim = Math.min(safeMaxDim, Math.floor(Math.max(width, height) * downscaleRatio));
          }

          const scale = Math.min(1, safeMaxDim / Math.max(width, height));
          let targetWidth = Math.round(width * scale);
          let targetHeight = Math.round(height * scale);

          const canvas = document.createElement('canvas');
          canvas.width = targetWidth;
          canvas.height = targetHeight;
          const ctx = canvas.getContext('2d');
          if (!ctx) return resolve(file);

          ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

          canvas.toBlob(
            (blob) => {
              if (!blob) return resolve(file);
              if (blob.size >= file.size) return resolve(file);

              const extMatch = file.name.match(/\.[^.]+$/);
              const baseName = extMatch ? file.name.slice(0, extMatch.index) : file.name;
              const compressedFile = new File([blob], `${baseName}.jpg`, {
                type: 'image/jpeg',
                lastModified: Date.now()
              });
              resolve(compressedFile);
            },
            'image/jpeg',
            quality
          );
        } catch (err) {
          console.warn('[Compression Exception]:', err);
          resolve(file);
        }
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function handleEssayPhotosSelected(questionId, files) {
  if (window.isCapturingPhoto) {
    handleWindowFocus();
  }
  if (!files || files.length === 0) return;
  window.writingPages = window.writingPages || {};
  if (!window.writingPages[questionId]) {
    window.writingPages[questionId] = [];
  }

  showToast(`⏳ Optimizing ${files.length} photo${files.length === 1 ? '' : 's'}...`);

  for (let i = 0; i < files.length; i++) {
    const origFile = files[i];
    if (!origFile.type || !origFile.type.startsWith('image/')) continue;
    try {
      const compressed = await compressImageFile(origFile, 2048, 0.82);
      const dataUrl = await fileToDataUrl(compressed);
      window.writingPages[questionId].push({
        id: 'p_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
        name: compressed.name || origFile.name,
        size: compressed.size,
        dataUrl: dataUrl
      });
    } catch (err) {
      console.warn('[Photo Processing Error]:', err);
    }
  }

  renderPhotoPagesList(questionId);

  const pages = window.writingPages[questionId];
  if (pages.length > 0) {
    clientAnswers.set(questionId, {
      mode: 'photo',
      answer: '',
      word_count: null,
      essay_images: pages.map(p => p.dataUrl)
    });
  } else {
    clientAnswers.delete(questionId);
  }
  updateCompletionCount();

  // Fullscreen compliance check:
  // Reset mobile fallback flag so candidate must re-engage fullscreen or fallback
  window.isMobileFallbackFullscreenActive = false;
  const isFs = isExamInFullscreen();
  if (!isFs && isExamActive && !isSubmitted) {
    startOrResetFullscreenRecoveryTimer(pages.length, questionId);
  } else if (isFs) {
    dismissFullscreenRecoveryTimer();
  }
}

function renderPhotoPagesList(questionId) {
  const listEl = document.getElementById(`photo-list-${questionId}`);
  const summaryEl = document.getElementById(`photo-summary-${questionId}`);
  if (!listEl) return;

  const pages = window.writingPages ? (window.writingPages[questionId] || []) : [];

  if (pages.length === 0) {
    listEl.innerHTML = '';
    if (summaryEl) summaryEl.style.display = 'none';
    return;
  }

  listEl.innerHTML = pages.map((page, idx) => {
    const sizeKb = (page.size / 1024).toFixed(1);
    const isFirst = idx === 0;
    const isLast = idx === pages.length - 1;
    return `
      <div class="ot-photo-page-card" id="page-card-${questionId}-${idx}">
        <div class="ot-photo-page-left">
          <img src="${escapeHtml(page.dataUrl)}" alt="Page ${idx + 1}" class="ot-photo-page-thumb" onclick="openDiagramLightbox('${escapeHtml(page.dataUrl)}')" title="Click to enlarge" />
          <div class="ot-photo-page-info">
            <span class="ot-photo-page-title">📄 Page ${idx + 1}</span>
            <span class="ot-photo-page-size">${sizeKb} KB (Compressed)</span>
          </div>
        </div>
        <div class="ot-photo-page-actions">
          <button type="button" class="ot-page-btn" onclick="moveEssayPhotoPage(${questionId}, ${idx}, -1)" ${isFirst ? 'disabled' : ''} title="Move Up">⬆</button>
          <button type="button" class="ot-page-btn" onclick="moveEssayPhotoPage(${questionId}, ${idx}, 1)" ${isLast ? 'disabled' : ''} title="Move Down">⬇</button>
          <button type="button" class="ot-page-btn ot-page-btn-delete" onclick="deleteEssayPhotoPage(${questionId}, ${idx})" title="Delete Page">🗑️</button>
        </div>
      </div>
    `;
  }).join('');

  if (summaryEl) {
    summaryEl.style.display = 'flex';
    summaryEl.innerHTML = `<span>✓</span> <b>${pages.length} handwritten page${pages.length === 1 ? '' : 's'} attached</b> (will be transcribed via OCR during grading).`;
  }
}

function moveEssayPhotoPage(questionId, index, direction) {
  if (!window.writingPages || !window.writingPages[questionId]) return;
  const pages = window.writingPages[questionId];
  const newIndex = index + direction;
  if (newIndex < 0 || newIndex >= pages.length) return;
  const temp = pages[index];
  pages[index] = pages[newIndex];
  pages[newIndex] = temp;
  renderPhotoPagesList(questionId);
  clientAnswers.set(questionId, {
    mode: 'photo',
    answer: '',
    word_count: null,
    essay_images: pages.map(p => p.dataUrl)
  });
}

function deleteEssayPhotoPage(questionId, index) {
  if (!window.writingPages || !window.writingPages[questionId]) return;
  const pages = window.writingPages[questionId];
  pages.splice(index, 1);
  renderPhotoPagesList(questionId);
  if (pages.length > 0) {
    clientAnswers.set(questionId, {
      mode: 'photo',
      answer: '',
      word_count: null,
      essay_images: pages.map(p => p.dataUrl)
    });
  } else {
    clientAnswers.delete(questionId);
  }
  updateCompletionCount();
}

function handleWritingInput(questionId, text, minW, maxW) {
  const words = (text || '').trim().match(/\S+/g);
  const count = words ? words.length : 0;

  const countEl = document.getElementById(`wc-count-${questionId}`);
  const badgeEl = document.getElementById(`wc-badge-${questionId}`);
  if (countEl) countEl.innerText = count.toString();

  if (badgeEl) {
    if (count === 0) {
      badgeEl.className = 'word-counter-badge';
    } else if ((minW && count < minW) || (maxW && count > maxW)) {
      badgeEl.className = 'word-counter-badge word-counter-warning';
    } else {
      badgeEl.className = 'word-counter-badge word-counter-in-range';
    }
  }

  if (text.trim()) {
    clientAnswers.set(questionId, { mode: 'type', answer: text, word_count: count });
  } else {
    clientAnswers.delete(questionId);
  }
  updateCompletionCount();
}

function updateCompletionCount() {
  const total = allQuestionIds.length;
  const answered = clientAnswers.size;
  const badge = document.getElementById('completion-badge');
  if (badge) {
    badge.innerText = `Answered ${answered}/${total}`;
  }
}

// ----------------- 9. SUBMISSION & VALIDATION -----------------

function handleClickSubmit() {
  const nameInput = document.getElementById('student-name-input');
  const studentName = (nameInput.value || '').trim();

  if (!studentName) {
    alert('Please enter your full name in the bottom bar before submitting.');
    nameInput.focus();
    return;
  }

  const unansweredList = [];
  let globalQNum = 0;

  testData.sections.forEach((sec, sIdx) => {
    (sec.questions || []).forEach((q, qIdx) => {
      globalQNum++;
      let isAnswered = false;

      if (q.question_type === 'writing') {
        const entry = clientAnswers.get(q.id);
        const mode = entry ? (entry.mode || 'type') : 'type';
        const hasText = Boolean(entry && typeof entry.answer === 'string' && entry.answer.trim().length > 0);
        const pages = (window.writingPages && window.writingPages[q.id]) ? window.writingPages[q.id] : [];
        const hasPhotos = pages.length > 0 || Boolean(entry && entry.essay_images && entry.essay_images.length > 0);
        if (hasText || hasPhotos) {
          isAnswered = true;
        }
      } else {
        const entry = clientAnswers.get(q.id);
        if (entry !== undefined && entry !== null) {
          const ans = typeof entry === 'object' ? entry.answer : entry;
          if (ans !== undefined && ans !== null && String(ans).trim() !== '' && ans !== -1) {
            isAnswered = true;
          }
        }
      }

      if (!isAnswered) {
        const qLabel = (testData.sections.length > 1)
          ? `Part ${sec.part_number || (sIdx + 1)} Q${qIdx + 1}`
          : `Question ${qIdx + 1}`;
        unansweredList.push(qLabel);
      }
    });
  });

  const wordWarnings = [];
  testData.sections.forEach((sec, sIdx) => {
    (sec.questions || []).forEach((q, idx) => {
      if (q.question_type === 'writing') {
        const entry = clientAnswers.get(q.id);
        const mode = entry ? (entry.mode || 'type') : 'type';
        if (mode === 'photo') {
          // Photo mode: validated by attached page count, word count evaluated via OCR on backend
        } else {
          const count = entry ? (entry.word_count || 0) : 0;
          if (q.min_words && count < q.min_words) {
            wordWarnings.push(`<b>Part ${sec.part_number || (sIdx + 1)} Q${idx + 1}</b> response has ${count} words (Minimum requested: ${q.min_words}).`);
          } else if (q.max_words && count > q.max_words) {
            wordWarnings.push(`<b>Part ${sec.part_number || (sIdx + 1)} Q${idx + 1}</b> response has ${count} words (Maximum requested: ${q.max_words}).`);
          }
        }
      }
    });
  });

  if (unansweredList.length > 0 || wordWarnings.length > 0) {
    let warningHtml = '';
    if (unansweredList.length > 0) {
      warningHtml += `<p>⚠️ You have <b>${unansweredList.length} unanswered question${unansweredList.length === 1 ? '' : 's'}</b>:<br><span style="font-weight:600; color:var(--pen);">${unansweredList.join(', ')}</span></p>`;
    }
    if (wordWarnings.length > 0) {
      warningHtml += `<p>⚠️ <b>Word-Count Boundaries:</b><br>${wordWarnings.join('<br>')}</p>`;
    }
    warningHtml += `<p style="margin-top:12px; font-weight:600; color:var(--ink);">Submit anyway?</p>`;

    document.getElementById('submit-warning-body').innerHTML = warningHtml;
    const confirmBtn = document.getElementById('submit-warning-confirm-btn');
    if (confirmBtn) confirmBtn.textContent = 'Submit anyway';
    document.getElementById('submit-warning-modal').style.display = 'flex';
  } else {
    executeSubmission('normal');
  }
}

function closeSubmitWarningModal() {
  document.getElementById('submit-warning-modal').style.display = 'none';
}

async function executeSubmission(terminationReason = 'normal') {
  closeSubmitWarningModal();

  if (isSubmitted) return;
  isSubmitted = true;

  dismissFullscreenRecoveryTimer();

  try {
    localStorage.setItem('online_test_locked_' + testCode, 'true');
  } catch (_) {}

  if (countdownTimerId) {
    clearInterval(countdownTimerId);
  }

  const studentName = (
    document.getElementById('student-name-input')?.value ||
    document.getElementById('splash-student-name')?.value ||
    'Candidate'
  ).trim();

  const btnSubmit = document.getElementById('btn-submit-exam');
  if (btnSubmit) {
    btnSubmit.disabled = true;
    btnSubmit.innerText = 'Submitting Exam...';
  }

  const formattedAnswers = [];
  allQuestionIds.forEach(qId => {
    const entry = clientAnswers.get(qId);
    formattedAnswers.push({
      question_id: qId,
      mode: entry ? (entry.mode || 'type') : 'type',
      answer: entry ? (entry.answer || '') : '',
      word_count: entry ? entry.word_count : null,
      essay_images: entry && Array.isArray(entry.essay_images) ? entry.essay_images : []
    });
  });

  try {
    const res = await fetch(`/api/public/online-tests/${encodeURIComponent(testCode)}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        student_name: studentName,
        device_id: clientDeviceId,
        answers: formattedAnswers,
        termination_reason: terminationReason,
        security_violations: securityViolations
      })
    });

    const data = await res.json();

    if (!res.ok || !data.success) {
      throw new Error(data.message || data.error || 'Failed to submit exam.');
    }

    // Exit fullscreen if active
    try {
      if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
      document.documentElement.classList.remove('ot-mobile-pseudo-fullscreen');
      document.body.classList.remove('ot-mobile-pseudo-fullscreen');
      window.isMobileFallbackFullscreenActive = false;
    } catch (_) {}

    // Show appropriate confirmation overlay
    if (terminationReason === 'tab_switch_limit') {
      const termModal = document.getElementById('lockdown-terminated-modal');
      if (termModal) termModal.style.display = 'flex';
    } else {
      document.getElementById('success-student-name').innerText = studentName;
      document.getElementById('success-time').innerText = formatCairoDateTime(new Date());
      document.getElementById('success-attempt-id').innerText = data.attempt_id || 'OK';
      document.getElementById('submit-success-modal').style.display = 'flex';
    }

    // Disable all inputs
    document.querySelectorAll('input, select, textarea, button').forEach(el => {
      if (el.id !== 'close-modal-btn') el.disabled = true;
    });
  } catch (err) {
    if (terminationReason !== 'tab_switch_limit') {
      if (btnSubmit) {
        btnSubmit.disabled = false;
        btnSubmit.innerText = '🚀 Submit Exam';
      }
      alert(`Submission Error: ${err.message}`);
    }
  }
}

// Window bindings for hybrid essay submissions & proctoring
window.switchWritingMode = switchWritingMode;
window.handleEssayPhotosSelected = handleEssayPhotosSelected;
window.moveEssayPhotoPage = moveEssayPhotoPage;
window.deleteEssayPhotoPage = deleteEssayPhotoPage;
window.compressImageFile = compressImageFile;
window.markPhotoCaptureStart = markPhotoCaptureStart;
window.handleWindowBlur = handleWindowBlur;
window.handleWindowFocus = handleWindowFocus;
window.registerStrike = registerStrike;
window.startOrResetFullscreenRecoveryTimer = startOrResetFullscreenRecoveryTimer;
window.dismissFullscreenRecoveryTimer = dismissFullscreenRecoveryTimer;
window.triggerReenterFullscreen = triggerReenterFullscreen;
window.isNativeFullscreenSupported = isNativeFullscreenSupported;
window.requestNativeFullscreen = requestNativeFullscreen;
window.isExamInFullscreen = isExamInFullscreen;
window.activateMobileFallbackFullscreen = activateMobileFallbackFullscreen;
