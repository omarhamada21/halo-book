import fs from 'fs';
import path from 'path';

console.log('=====================================================');
console.log('       HALO-BOOK ARCHITECTURAL AUDIT & CHECK         ');
console.log('=====================================================');

let errors = 0;

// 1. Check for PRAGMA foreign_keys = ON anywhere in the project
console.log('\n[CHECK 1] Scanning for PRAGMA foreign_keys = ON...');
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
if (errors === 0) {
  console.log('✓ ZERO instances of PRAGMA foreign_keys = ON across codebase.');
}

// 2. Check for duplicate Express routes in server.js
console.log('\n[CHECK 2] Scanning for duplicate Express routes in server.js...');
const serverJs = fs.readFileSync('server.js', 'utf8');
const routeRegex = /app\.(get|post|put|delete|patch)\s*\(\s*(['"][^'"]+['"])/g;
const seenRoutes = new Map();
let routeMatch;
while ((routeMatch = routeRegex.exec(serverJs)) !== null) {
  const method = routeMatch[1].toUpperCase();
  const routePath = routeMatch[2];
  const key = `${method} ${routePath}`;
  if (seenRoutes.has(key)) {
    console.error(`❌ DUPLICATE ROUTE: ${key}`);
    errors++;
  } else {
    seenRoutes.set(key, true);
  }
}
console.log(`✓ Scanned ${seenRoutes.size} unique Express endpoints in server.js without duplicates.`);

// 3. Check for duplicate function declarations in server.js and public/*.js
console.log('\n[CHECK 3] Scanning for duplicate function declarations...');
const targetFiles = [
  'server.js',
  'public/online-tests.js',
  'public/assignments.js',
  'public/shared.js',
  'public/submissions.js'
];

for (const relPath of targetFiles) {
  if (!fs.existsSync(relPath)) continue;
  const content = fs.readFileSync(relPath, 'utf8');
  // Match `function foo(` or `async function foo(`
  const fnRegex = /(?:async\s+)?function\s+([a-zA-Z0-9_$]+)\s*\(/g;
  const declaredFns = new Map();
  let fnMatch;
  let fileDuplicates = 0;
  while ((fnMatch = fnRegex.exec(content)) !== null) {
    const fnName = fnMatch[1];
    if (declaredFns.has(fnName)) {
      console.error(`❌ DUPLICATE FUNCTION in ${relPath}: ${fnName}`);
      fileDuplicates++;
      errors++;
    } else {
      declaredFns.set(fnName, true);
    }
  }
  if (fileDuplicates === 0) {
    console.log(`✓ ${relPath}: ${declaredFns.size} functions declared, 0 duplicates.`);
  }
}

// 4. Check for decommissioning of extractVisualOptionCropsFromPdf in pipelines
console.log('\n[CHECK 4] Verifying extractVisualOptionCropsFromPdf is NOT called in pipelines...');
const onlineGenSection = serverJs.substring(serverJs.indexOf('/api/online-tests/generate'), serverJs.indexOf('/api/online-tests/generate') + 4000);
const mcqGenSection = serverJs.substring(serverJs.indexOf('/api/mcq/generate'), serverJs.indexOf('/api/mcq/generate') + 4000);

if (onlineGenSection.includes('extractVisualOptionCropsFromPdf(')) {
  console.error('❌ VIOLATION: extractVisualOptionCropsFromPdf called in POST /api/online-tests/generate');
  errors++;
} else {
  console.log('✓ POST /api/online-tests/generate does not call extractVisualOptionCropsFromPdf');
}

if (mcqGenSection.includes('extractVisualOptionCropsFromPdf(')) {
  console.error('❌ VIOLATION: extractVisualOptionCropsFromPdf called in POST /api/mcq/generate');
  errors++;
} else {
  console.log('✓ POST /api/mcq/generate does not call extractVisualOptionCropsFromPdf');
}

// 5. Check mcqConfig maxOutputTokens
console.log('\n[CHECK 5] Checking maxOutputTokens: 8192 in POST /api/mcq/generate...');
if (serverJs.includes('maxOutputTokens: 8192')) {
  console.log('✓ maxOutputTokens: 8192 configured for Gemini MCQ generation');
} else {
  console.error('❌ VIOLATION: maxOutputTokens: 8192 missing in server.js');
  errors++;
}

// 6. Check option image upload routes in server.js
console.log('\n[CHECK 6] Checking option image upload endpoints...');
if (serverJs.includes("'/api/online-tests/upload-option-image'") && serverJs.includes("'/api/mcq/upload-option-image'")) {
  console.log('✓ Both POST /api/online-tests/upload-option-image and POST /api/mcq/upload-option-image are defined');
} else {
  console.error('❌ VIOLATION: Option upload endpoints missing');
  errors++;
}

console.log('\n=====================================================');
if (errors === 0) {
  console.log('✓ ALL AUDIT CHECKS PASSED WITH ZERO VIOLATIONS');
  console.log('=====================================================');
  process.exit(0);
} else {
  console.error(`❌ AUDIT FAILED WITH ${errors} VIOLATION(S)`);
  console.log('=====================================================');
  process.exit(1);
}
