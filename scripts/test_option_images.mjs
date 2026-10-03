import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import jwt from 'jsonwebtoken';

async function run() {
  console.log('--- STARTING INTEGRATION VERIFICATION ON PORT 3008 ---');

  const secret = process.env.JWT_SECRET || 'halo-book-secret-key-change-in-production';
  // Generate test JWT for approved user
  const token = jwt.sign(
    { id: 1, email: 'ohamada2117@gmail.com', role: 'root', status: 'approved' },
    secret,
    { expiresIn: '1h' }
  );

  console.log('1. Launching server on PORT 3008...');
  const env = { ...process.env, PORT: '3008', JWT_SECRET: secret };
  const serverProcess = spawn('node', ['server.js'], { env, cwd: process.cwd() });

  let serverStarted = false;
  serverProcess.stdout.on('data', (d) => {
    const s = d.toString();
    if (s.includes('3008') || s.includes('Server running') || s.includes('listening')) {
      serverStarted = true;
    }
  });

  serverProcess.stderr.on('data', (d) => {
    // console.log('[Server stderr]:', d.toString());
  });

  // Wait for server to respond
  for (let i = 0; i < 25; i++) {
    try {
      const res = await fetch('http://127.0.0.1:3008/api/auth/me', {
        headers: { 'Cookie': `halo_token=${token}`, 'Authorization': `Bearer ${token}` }
      });
      if (res.status === 200 || res.status === 401 || res.status === 403) {
        serverStarted = true;
        break;
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 400));
  }

  if (!serverStarted) {
    console.error('Server failed to start on port 3008 within timeout');
    serverProcess.kill();
    process.exit(1);
  }
  console.log('✓ Server is active and listening on port 3008.');

  // 2. Test unauthenticated request rejection
  console.log('2. Testing unauthenticated upload rejection...');
  const samplePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const dummyForm = new FormData();
  dummyForm.append('image', new Blob([samplePng], { type: 'image/png' }), 'test.png');

  const unauthRes = await fetch('http://127.0.0.1:3008/api/online-tests/upload-option-image', {
    method: 'POST',
    body: dummyForm
  });
  console.log(`Unauthenticated response status: ${unauthRes.status}`);
  if (unauthRes.status !== 401 && unauthRes.status !== 403) {
    serverProcess.kill();
    throw new Error('Unauthenticated request was not rejected!');
  }
  console.log('✓ Unauthenticated upload properly blocked (401/403).');

  // 3. Test POST /api/online-tests/upload-option-image with auth
  console.log('3. Testing POST /api/online-tests/upload-option-image with auth...');
  const form1 = new FormData();
  form1.append('image', new Blob([samplePng], { type: 'image/png' }), 'opt_a.png');

  const uploadRes1 = await fetch('http://127.0.0.1:3008/api/online-tests/upload-option-image', {
    method: 'POST',
    headers: { 'Cookie': `halo_token=${token}`, 'Authorization': `Bearer ${token}` },
    body: form1
  });

  const data1 = await uploadRes1.json();
  console.log('Upload result 1:', data1);
  if (!data1.success || !data1.url || !data1.url.startsWith('/uploads/option-images/')) {
    serverProcess.kill();
    throw new Error('Upload to /api/online-tests/upload-option-image failed!');
  }
  console.log('✓ /api/online-tests/upload-option-image returned valid url:', data1.url);

  // Verify file written to disk
  const localDiskPath1 = path.join(process.cwd(), 'public', data1.url.replace(/^\/+/, ''));
  if (!fs.existsSync(localDiskPath1)) {
    serverProcess.kill();
    throw new Error(`File was not created on disk: ${localDiskPath1}`);
  }
  console.log('✓ Verified file exists on disk:', localDiskPath1);

  // 4. Test POST /api/mcq/upload-option-image with auth
  console.log('4. Testing POST /api/mcq/upload-option-image with auth...');
  const form2 = new FormData();
  form2.append('image', new Blob([samplePng], { type: 'image/png' }), 'opt_b.png');

  const uploadRes2 = await fetch('http://127.0.0.1:3008/api/mcq/upload-option-image', {
    method: 'POST',
    headers: { 'Cookie': `halo_token=${token}`, 'Authorization': `Bearer ${token}` },
    body: form2
  });

  const data2 = await uploadRes2.json();
  console.log('Upload result 2:', data2);
  if (!data2.success || !data2.url || !data2.url.startsWith('/uploads/option-images/')) {
    serverProcess.kill();
    throw new Error('Upload to /api/mcq/upload-option-image failed!');
  }
  console.log('✓ /api/mcq/upload-option-image returned valid url:', data2.url);

  // 5. Test static file serving of the uploaded image
  console.log('5. Testing static file serving from public/uploads/option-images...');
  const staticRes = await fetch(`http://127.0.0.1:3008${data1.url}`);
  console.log(`Static file HTTP status: ${staticRes.status}`);
  if (staticRes.status !== 200) {
    serverProcess.kill();
    throw new Error(`Static file serving failed with status ${staticRes.status}`);
  }
  console.log('✓ Uploaded image is statically served at HTTP 200.');

  // 6. Test storage deletion cleanup
  console.log('6. Cleaning up test images from disk...');
  if (fs.existsSync(localDiskPath1)) {
    fs.unlinkSync(localDiskPath1);
  }
  const localDiskPath2 = path.join(process.cwd(), 'public', data2.url.replace(/^\/+/, ''));
  if (fs.existsSync(localDiskPath2)) {
    fs.unlinkSync(localDiskPath2);
  }
  console.log('✓ Cleaned up test images from disk.');

  // Terminate test server
  serverProcess.kill();
  console.log('\n========================================');
  console.log('✓ ALL 6 INTEGRATION TESTS PASSED CLEANLY');
  console.log('========================================');
  process.exit(0);
}

run().catch((err) => {
  console.error('Integration test failure:', err);
  process.exit(1);
});
