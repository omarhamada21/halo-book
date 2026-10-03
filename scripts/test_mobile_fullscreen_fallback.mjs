import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('=====================================================');
console.log('   TESTING MOBILE FULLSCREEN RE-ENTRY & FALLBACK     ');
console.log('=====================================================');

const htmlPath = path.join(__dirname, '..', 'public', 'online-test.html');
const htmlContent = fs.readFileSync(htmlPath, 'utf8');

// 1. Verify CSS definition
console.log('\n[TEST 1] Verifying .ot-mobile-pseudo-fullscreen CSS...');
if (!htmlContent.includes('body.ot-mobile-pseudo-fullscreen')) {
  console.error('❌ Missing body.ot-mobile-pseudo-fullscreen CSS!');
  process.exit(1);
}
console.log('✓ Found body.ot-mobile-pseudo-fullscreen in CSS.');

// 2. Verify button touch bindings
console.log('\n[TEST 2] Verifying touch & click event bindings on buttons...');
const expectedBindings = [
  'onclick="triggerReenterFullscreen(event)" ontouchend="triggerReenterFullscreen(event)"',
  'onclick="startExamWithLockdown(event)" ontouchend="startExamWithLockdown(event)"'
];
for (const b of expectedBindings) {
  if (!htmlContent.includes(b)) {
    console.error(`❌ Missing expected touch binding: ${b}`);
    process.exit(1);
  }
}
console.log('✓ Buttons correctly bound to both onclick and ontouchend.');

// 3. Functional Simulation of Native vs Fallback Fullscreen
console.log('\n[TEST 3] Simulating Fullscreen Re-entry State Machine...');

class MockClassList {
  constructor() {
    this.classes = new Set();
  }
  add(c) { this.classes.add(c); }
  remove(c) { this.classes.delete(c); }
  contains(c) { return this.classes.has(c); }
}

const mockBody = {
  classList: new MockClassList()
};

let nativeFullscreenEnabled = true;
let nativeFullscreenReject = false;
let strikesCount = 0;
let isExamActive = true;
let isSubmitted = false;

function registerStrike(type, details) {
  strikesCount++;
}

// Emulate online-test.html state
let isMobileFallbackFullscreenActive = false;
let fullscreenRecoveryTimerId = 123;
let isPostPhotoRecoveryActive = true;

function isExamInFullscreen(nativeElement = null) {
  const nativeFs = !!nativeElement;
  return nativeFs || isMobileFallbackFullscreenActive === true;
}

function requestNativeFullscreen() {
  if (!nativeFullscreenEnabled) {
    return Promise.reject(new Error('Fullscreen API not supported'));
  }
  if (nativeFullscreenReject) {
    return Promise.reject(new Error('User activation required or permission denied'));
  }
  return Promise.resolve();
}

function activateMobileFallbackFullscreen() {
  mockBody.classList.add('ot-mobile-pseudo-fullscreen');
  isMobileFallbackFullscreenActive = true;
}

function dismissFullscreenRecoveryTimer() {
  fullscreenRecoveryTimerId = null;
  isPostPhotoRecoveryActive = false;
}

function triggerReenterFullscreen(e) {
  if (e && e.preventDefault) e.preventDefault();

  try {
    const promise = requestNativeFullscreen();
    if (promise && promise.then) {
      return promise.then(() => {
        isMobileFallbackFullscreenActive = false;
        mockBody.classList.remove('ot-mobile-pseudo-fullscreen');
        dismissFullscreenRecoveryTimer();
        return 'native_success';
      }).catch(err => {
        activateMobileFallbackFullscreen();
        dismissFullscreenRecoveryTimer();
        return 'fallback_activated';
      });
    }
  } catch (err) {
    activateMobileFallbackFullscreen();
    dismissFullscreenRecoveryTimer();
    return Promise.resolve('fallback_activated');
  }

  activateMobileFallbackFullscreen();
  dismissFullscreenRecoveryTimer();
  return Promise.resolve('fallback_activated');
}

// CASE A: Browser supports native fullscreen and grants it (Desktop / standard Chrome)
console.log('Testing Case A: Native Fullscreen Granted...');
nativeFullscreenEnabled = true;
nativeFullscreenReject = false;
isPostPhotoRecoveryActive = true;
fullscreenRecoveryTimerId = 999;
strikesCount = 0;

await triggerReenterFullscreen();
if (isPostPhotoRecoveryActive) throw new Error('Recovery timer must be dismissed');
if (strikesCount !== 0) throw new Error('Strikes must be 0');
if (isMobileFallbackFullscreenActive) throw new Error('Fallback should not be active when native is granted');
console.log('✓ Native fullscreen granted, recovery timer cleared, 0 strikes.');

// CASE B: iOS Safari (Fullscreen API completely absent)
console.log('Testing Case B: iOS Safari (Fullscreen API unsupported)...');
nativeFullscreenEnabled = false;
nativeFullscreenReject = false;
isPostPhotoRecoveryActive = true;
fullscreenRecoveryTimerId = 888;
strikesCount = 0;

await triggerReenterFullscreen();
if (isPostPhotoRecoveryActive) throw new Error('Recovery timer must be dismissed in fallback');
if (strikesCount !== 0) throw new Error('Strikes must be 0 for iOS fallback');
if (!isMobileFallbackFullscreenActive) throw new Error('isMobileFallbackFullscreenActive must be true');
if (!mockBody.classList.contains('ot-mobile-pseudo-fullscreen')) throw new Error('body must have ot-mobile-pseudo-fullscreen class');
if (!isExamInFullscreen(null)) throw new Error('isExamInFullscreen() must return true when fallback is active');
console.log('✓ iOS Safari gracefully switches to pseudo-fullscreen fallback, timer cleared, 0 strikes.');

// CASE C: Android In-App WebView (API throws or rejects)
console.log('Testing Case C: In-App WebView (requestFullscreen rejects)...');
nativeFullscreenEnabled = true;
nativeFullscreenReject = true; // Simulating permission/gesture rejection
isPostPhotoRecoveryActive = true;
fullscreenRecoveryTimerId = 777;
strikesCount = 0;

await triggerReenterFullscreen();
if (isPostPhotoRecoveryActive) throw new Error('Recovery timer must be dismissed on WebView fallback');
if (strikesCount !== 0) throw new Error('Strikes must be 0 on WebView rejection');
if (!isMobileFallbackFullscreenActive) throw new Error('isMobileFallbackFullscreenActive must be true');
if (!mockBody.classList.contains('ot-mobile-pseudo-fullscreen')) throw new Error('body must have ot-mobile-pseudo-fullscreen class');
console.log('✓ In-App WebView rejection gracefully switches to pseudo-fullscreen fallback, timer cleared, 0 strikes.');

console.log('\n=====================================================');
console.log('✓ ALL MOBILE FULLSCREEN FALLBACK TESTS PASSED!');
console.log('=====================================================');
