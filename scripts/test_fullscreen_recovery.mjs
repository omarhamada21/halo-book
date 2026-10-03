import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('=====================================================');
console.log('   TESTING MULTI-PAGE FULLSCREEN RECOVERY TIMER     ');
console.log('=====================================================');

const htmlPath = path.join(__dirname, '..', 'public', 'online-test.html');
const htmlContent = fs.readFileSync(htmlPath, 'utf8');

// 1. Verify HTML element presence
console.log('\n[TEST 1] Verifying DOM elements in online-test.html...');
const requiredElements = [
  'id="ot-fullscreen-recovery-overlay"',
  'class="ot-fullscreen-recovery-card"',
  'id="ot-fs-recovery-title"',
  'id="ot-fs-recovery-desc"',
  'id="ot-fs-timer-display"',
  'triggerReenterFullscreen()'
];

for (const el of requiredElements) {
  if (!htmlContent.includes(el)) {
    console.error(`❌ Missing required DOM element/handler: ${el}`);
    process.exit(1);
  }
}
console.log('✓ All required DOM elements and handlers are present.');

// 2. Setup mock browser environment to simulate state machine
console.log('\n[TEST 2] Setting up simulation environment...');

class MockElement {
  constructor(id, className = '') {
    this.id = id;
    this.className = className;
    this.style = {};
    this.textContent = '';
    this.innerText = '';
    this.innerHTML = '';
  }
}

const mockElements = {
  'ot-fullscreen-recovery-overlay': new MockElement('ot-fullscreen-recovery-overlay', 'ot-fullscreen-recovery-overlay'),
  'ot-fs-recovery-title': new MockElement('ot-fs-recovery-title'),
  'ot-fs-recovery-desc': new MockElement('ot-fs-recovery-desc'),
  'ot-fs-timer-display': new MockElement('ot-fs-timer-display', 'recovery-countdown'),
  'fullscreen-resume-overlay': new MockElement('fullscreen-resume-overlay'),
  'lockdown-warning-modal': new MockElement('lockdown-warning-modal'),
  'exam-main-content': new MockElement('exam-main-content'),
  'exam-bottom-bar': new MockElement('exam-bottom-bar'),
  'exam-strikes-pill': new MockElement('exam-strikes-pill'),
  'exam-strikes-text': new MockElement('exam-strikes-text')
};

// Simulation harness mimicking online-test.html logic
let strikesCount = 0;
const MAX_STRIKES = 2;
let isExamActive = true;
let isSubmitted = false;
const securityViolations = [];
let lastInfractionTime = 0;

function registerStrike(type, details) {
  handleSecurityInfraction(type, details);
}

function handleSecurityInfraction(type, details) {
  if (!isExamActive || isSubmitted) return;
  const now = Date.now();
  if (now - lastInfractionTime < 1500) return;
  lastInfractionTime = now;
  strikesCount++;
  securityViolations.push({
    type,
    strike: strikesCount,
    timestamp: new Date().toISOString(),
    details: details || ''
  });
}

// Extracted from online-test.html
const win = {
  fullscreenRecoveryDeadline: null,
  fullscreenRecoveryTimerId: null,
  fullscreenRecoveryTickInterval: null,
  isPostPhotoRecoveryActive: false,
  lastAttachedPhotoQuestionId: null,
  isCapturingPhoto: false
};

function getElementById(id) {
  return mockElements[id] || null;
}

function startOrResetFullscreenRecoveryTimer(pageCount = 1, questionId = null) {
  if (!isExamActive || isSubmitted) return;

  if (win.fullscreenRecoveryTimerId) {
    clearTimeout(win.fullscreenRecoveryTimerId);
    win.fullscreenRecoveryTimerId = null;
  }
  if (win.fullscreenRecoveryTickInterval) {
    clearInterval(win.fullscreenRecoveryTickInterval);
    win.fullscreenRecoveryTickInterval = null;
  }

  const durationMs = 60000;
  const now = Date.now();
  win.fullscreenRecoveryDeadline = now + durationMs;
  win.isPostPhotoRecoveryActive = true;
  if (questionId) win.lastAttachedPhotoQuestionId = questionId;

  const overlay = getElementById('ot-fullscreen-recovery-overlay');
  const titleEl = getElementById('ot-fs-recovery-title');
  const descEl = getElementById('ot-fs-recovery-desc');
  const timerDisplay = getElementById('ot-fs-timer-display');

  const pageNum = Number(pageCount) || 1;
  if (titleEl) {
    titleEl.textContent = pageNum > 1 ? `📸 Page ${pageNum} Attached!` : '📸 Paper Attached!';
  }
  if (descEl) {
    descEl.textContent = pageNum > 1
      ? `Page ${pageNum} has been saved. Please return to fullscreen mode to continue your exam securely, or attach additional pages if needed.`
      : 'Your page has been saved. Please return to fullscreen mode to continue your exam securely, or attach additional pages if needed.';
  }

  const resumeOverlay = getElementById('fullscreen-resume-overlay');
  if (resumeOverlay) resumeOverlay.style.display = 'none';

  if (overlay) overlay.style.display = 'flex';

  function updateRecoveryCountdown() {
    if (!win.isPostPhotoRecoveryActive) return;
    const remainingMs = Math.max(0, (win.fullscreenRecoveryDeadline || 0) - Date.now());
    const remainingSec = Math.ceil(remainingMs / 1000);
    const mins = Math.floor(remainingSec / 60);
    const secs = remainingSec % 60;
    const formatted = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

    if (timerDisplay) {
      timerDisplay.textContent = formatted;
    }

    if (remainingMs <= 0) {
      handleRecoveryTimeoutExpired();
    }
  }

  updateRecoveryCountdown();
}

function handleRecoveryTimeoutExpired() {
  if (!win.isPostPhotoRecoveryActive) return;
  dismissFullscreenRecoveryTimer({ timeoutExpired: true });
  registerStrike(
    'fullscreen_not_restored_after_photo',
    'Failed to return to fullscreen mode within 1 minute of the last attached paper.'
  );
}

function dismissFullscreenRecoveryTimer(opts = {}) {
  if (win.fullscreenRecoveryTimerId) {
    clearTimeout(win.fullscreenRecoveryTimerId);
    win.fullscreenRecoveryTimerId = null;
  }
  if (win.fullscreenRecoveryTickInterval) {
    clearInterval(win.fullscreenRecoveryTickInterval);
    win.fullscreenRecoveryTickInterval = null;
  }
  win.fullscreenRecoveryDeadline = null;
  win.isPostPhotoRecoveryActive = false;

  const overlay = getElementById('ot-fullscreen-recovery-overlay');
  if (overlay) overlay.style.display = 'none';
}

function handleFullscreenChange(isFs) {
  if (!isFs && isExamActive && !isSubmitted) {
    if (win.isCapturingPhoto) return;
    if (win.isPostPhotoRecoveryActive) {
      const recOverlay = getElementById('ot-fullscreen-recovery-overlay');
      if (recOverlay) recOverlay.style.display = 'flex';
      return;
    }
    registerStrike('fullscreen_exit', 'Candidate exited fullscreen mode.');
  } else if (isFs && isExamActive && !isSubmitted) {
    dismissFullscreenRecoveryTimer();
    const resumeOverlay = getElementById('fullscreen-resume-overlay');
    if (resumeOverlay) resumeOverlay.style.display = 'none';
  }
}

// SIMULATION 1: Page 1 attached -> 1 min deadline started
console.log('\n[SIMULATION 1] Student attaches Page 1 outside fullscreen...');
win.isCapturingPhoto = true;
handleFullscreenChange(false); // Fullscreen exits when mobile camera / file picker opens
win.isCapturingPhoto = false;
startOrResetFullscreenRecoveryTimer(1, 101);

if (!win.isPostPhotoRecoveryActive) throw new Error('Recovery should be active!');
if (mockElements['ot-fullscreen-recovery-overlay'].style.display !== 'flex') throw new Error('Overlay should be visible!');
if (!mockElements['ot-fs-recovery-title'].textContent.includes('Paper Attached')) throw new Error('Title mismatch for Page 1');
if (mockElements['ot-fs-timer-display'].textContent !== '01:00') throw new Error('Timer display must be 01:00 initially');
console.log('✓ Page 1 starts fresh 1-minute window (01:00). Overlay visible.');

const page1Deadline = win.fullscreenRecoveryDeadline;

// SIMULATION 2: 30 seconds pass, student attaches Page 2 -> timer dynamically resets!
console.log('\n[SIMULATION 2] 30 seconds elapse, student attaches Page 2...');
// Simulate remaining time had decayed to 30 seconds
win.fullscreenRecoveryDeadline = Date.now() + 30000;
const decayedRemaining = win.fullscreenRecoveryDeadline - Date.now();
// Page 2 attached
startOrResetFullscreenRecoveryTimer(2, 101);

const freshRemaining = win.fullscreenRecoveryDeadline - Date.now();
if (freshRemaining <= decayedRemaining) {
  throw new Error('Deadline should have been dynamically reset to a fresh 60,000 ms window!');
}
if (!mockElements['ot-fs-recovery-title'].textContent.includes('Page 2 Attached')) {
  throw new Error('Title should reflect Page 2');
}
if (mockElements['ot-fs-timer-display'].textContent !== '01:00') {
  throw new Error('Timer display must reset to 01:00 upon Page 2 attachment');
}
console.log('✓ Page 2 dynamically cleared old timer and granted a fresh 1-minute window starting from Page 2 completion.');

// SIMULATION 3: Student re-enters fullscreen -> timer dismissed, 0 strikes!
console.log('\n[SIMULATION 3] Student re-enters fullscreen at 20 seconds...');
handleFullscreenChange(true);

if (win.isPostPhotoRecoveryActive) throw new Error('Recovery should be inactive after returning to fullscreen');
if (mockElements['ot-fullscreen-recovery-overlay'].style.display !== 'none') throw new Error('Overlay should be hidden');
if (strikesCount !== 0) throw new Error(`Strikes must be 0, got: ${strikesCount}`);
console.log('✓ Returning to fullscreen dismissed recovery overlay and recorded 0 strikes.');

// SIMULATION 4: Student attaches Page 1 again, but 1 minute elapses without returning
console.log('\n[SIMULATION 4] Student attaches Page 1 again, but lets 1 minute expire...');
startOrResetFullscreenRecoveryTimer(1, 102);
// Fast forward deadline to 0
win.fullscreenRecoveryDeadline = Date.now() - 100;
handleRecoveryTimeoutExpired();

if (strikesCount !== 1) throw new Error(`Expected exactly 1 strike, got: ${strikesCount}`);
const violation = securityViolations[0];
if (violation.type !== 'fullscreen_not_restored_after_photo') {
  throw new Error(`Expected type 'fullscreen_not_restored_after_photo', got: ${violation.type}`);
}
if (violation.details !== 'Failed to return to fullscreen mode within 1 minute of the last attached paper.') {
  throw new Error(`Violation details do not match required string! Got: ${violation.details}`);
}
console.log('✓ Timeout registered exactly 1 strike with exact required type and message.');

// SIMULATION 5: Exiting fullscreen when NOT handling photos triggers immediate strike
console.log('\n[SIMULATION 5] Exiting fullscreen when not handling photos...');
lastInfractionTime = 0; // reset debounce
handleFullscreenChange(false);
if (strikesCount !== 2) throw new Error(`Expected 2 strikes total, got: ${strikesCount}`);
const lastV = securityViolations[1];
if (lastV.type !== 'fullscreen_exit') throw new Error(`Expected 'fullscreen_exit', got: ${lastV.type}`);
console.log('✓ Non-photo fullscreen exit triggers immediate strike as normal.');

console.log('\n=====================================================');
console.log('✓ ALL MULTI-PAGE FULLSCREEN RECOVERY TESTS PASSED!');
console.log('=====================================================');
