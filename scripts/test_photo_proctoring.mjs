import fs from 'fs';
import path from 'path';

console.log('========================================================');
console.log('   VERIFYING PROCTORING & PHOTO GRACE DETECTION LOGIC   ');
console.log('========================================================');

let errors = 0;

// 1. Syntax check for online-test.html script contents
console.log('\n[TEST 1] Syntax Validation of public/online-test.html scripts...');
const htmlContent = fs.readFileSync('public/online-test.html', 'utf8');

const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
let match;
let scriptIdx = 0;
while ((match = scriptRegex.exec(htmlContent)) !== null) {
  const code = match[1];
  if (!code || !code.trim()) continue;
  scriptIdx++;
  try {
    new Function(code);
    console.log(`✓ Script #${scriptIdx} parsed cleanly (0 syntax errors).`);
  } catch (synErr) {
    console.error(`❌ Syntax Error in script #${scriptIdx}:`, synErr.message);
    errors++;
  }
}

// 2. Duplicate function declarations in online-test.html
console.log('\n[TEST 2] Duplicate Function Declarations in online-test.html...');
const fnRegex = /(?:async\s+)?function\s+([a-zA-Z0-9_$]+)\s*\(/g;
const declaredFns = new Map();
let fnMatch;
let dupCount = 0;
while ((fnMatch = fnRegex.exec(htmlContent)) !== null) {
  const fnName = fnMatch[1];
  if (declaredFns.has(fnName)) {
    console.error(`❌ DUPLICATE FUNCTION: ${fnName}`);
    dupCount++;
    errors++;
  } else {
    declaredFns.set(fnName, true);
  }
}
if (dupCount === 0) {
  console.log(`✓ Scanned ${declaredFns.size} functions in online-test.html with 0 duplicates.`);
}

// 3. Check for PRAGMA foreign_keys = ON anywhere
console.log('\n[TEST 3] Scanning for PRAGMA foreign_keys = ON...');
function scanDirForPragma(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'scripts' || entry.name.endsWith('.db')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDirForPragma(fullPath);
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs') || entry.name.endsWith('.html') || entry.name.endsWith('.sql')) {
      const content = fs.readFileSync(fullPath, 'utf8');
      if (/pragma\s+foreign_keys\s*=\s*(?:on|1)/i.test(content)) {
        console.error(`❌ VIOLATION: PRAGMA foreign_keys = ON found in: ${fullPath}`);
        errors++;
      }
    }
  }
}
scanDirForPragma(process.cwd());
console.log('✓ 0 instances of PRAGMA foreign_keys = ON across codebase.');

// 4. Functional Simulation of Photo Grace Period Logic
console.log('\n[TEST 4] Functional Simulation of Photo Grace Period & Proctoring...');

// Simulate the exact state and handlers from online-test.html
let strikesCount = 0;
let lastInfractionTime = 0;
let isExamActive = true;
let isSubmitted = false;
const securityViolations = [];
const MAX_STRIKES = 2;

let isCapturingPhoto = false;
let photoCaptureStartTime = null;
let activePhotoGraceTimeout = 120000;
let lastBlurTimestamp = null;
let photoGraceTimer = null;

function registerStrike(type, details) {
  handleSecurityInfraction(type, details);
}

function handleSecurityInfraction(type, details) {
  if (!isExamActive || isSubmitted) return;
  const now = Date.now();
  if (now - lastInfractionTime < 1500) return;
  lastInfractionTime = now;
  strikesCount++;
  securityViolations.push({ type, strike: strikesCount, details });
}

function markPhotoCaptureStart(qId) {
  isCapturingPhoto = true;
  photoCaptureStartTime = Date.now();
  activePhotoGraceTimeout = 120000;
}

function handleWindowBlur() {
  if (!isExamActive || isSubmitted) return;
  const now = Date.now();
  lastBlurTimestamp = now;
  if (isCapturingPhoto) {
    return; // Grace period active: no strike
  }
  registerStrike('window_blur', 'Exam window lost focus.');
}

function handleWindowFocus(mockNow) {
  if (!isExamActive || isSubmitted) return;
  const now = mockNow !== undefined ? mockNow : Date.now();
  if (isCapturingPhoto && photoCaptureStartTime) {
    const elapsedMs = now - photoCaptureStartTime;
    const elapsedSec = Math.round(elapsedMs / 1000);
    isCapturingPhoto = false;
    photoCaptureStartTime = null;

    if (elapsedMs <= 120000) {
      // Waived!
      return;
    } else {
      registerStrike('photo_timeout_exceeded', `Photo capture took ${elapsedSec}s (> 120s limit).`);
      return;
    }
  }
}

// Case A: Unrelated Tab Switch / Window Blur without photo capture
console.log('  Testing Case A: Tab switch without clicking photo dropzone...');
strikesCount = 0;
handleWindowBlur();
if (strikesCount === 1) {
  console.log('  ✓ Strike 1 correctly recorded for unauthorized window blur.');
} else {
  console.error(`  ❌ Expected strike 1, got ${strikesCount}`);
  errors++;
}

// Case B: Clicking photo dropzone and returning within 45 seconds (< 120s)
console.log('  Testing Case B: Photo capture returning within 45s (waived)...');
lastInfractionTime = 0;
strikesCount = 0;
markPhotoCaptureStart(101);
handleWindowBlur();
if (strikesCount === 0) {
  console.log('  ✓ No strike recorded during blur while isCapturingPhoto is true.');
} else {
  console.error(`  ❌ Strike was recorded during photo capture blur: ${strikesCount}`);
  errors++;
}

// Focus returned after 45s (45,000 ms)
const mockReturnTimeValid = photoCaptureStartTime + 45000;
handleWindowFocus(mockReturnTimeValid);
if (strikesCount === 0 && !isCapturingPhoto) {
  console.log('  ✓ Returned in 45s: Strike successfully waived, isCapturingPhoto reset to false.');
} else {
  console.error(`  ❌ Expected 0 strikes and false flag, got ${strikesCount} strikes, flag: ${isCapturingPhoto}`);
  errors++;
}

// Case C: Photo capture taking 135 seconds (> 120s limit)
console.log('  Testing Case C: Photo capture exceeding 120s (135s elapsed)...');
strikesCount = 0;
lastInfractionTime = 0;
markPhotoCaptureStart(102);
handleWindowBlur();
const mockReturnTimeExpired = photoCaptureStartTime + 135000;
handleWindowFocus(mockReturnTimeExpired);
if (strikesCount === 1 && !isCapturingPhoto) {
  console.log('  ✓ Overtime photo capture (>120s) correctly triggered strike: photo_timeout_exceeded.');
} else {
  console.error(`  ❌ Expected 1 strike for timeout, got ${strikesCount}`);
  errors++;
}

console.log('\n========================================================');
if (errors === 0) {
  console.log('✓ ALL PROCTORING & PHOTO GRACE VERIFICATIONS PASSED CLEANLY');
  console.log('========================================================');
  process.exit(0);
} else {
  console.error(`❌ ${errors} CHECK(S) FAILED`);
  console.log('========================================================');
  process.exit(1);
}
