import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';

async function capture() {
  console.log('Capturing screenshots with local Puppeteer...');
  const outDir = path.join(process.cwd(), 'verification_screenshots');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  console.log('Navigating to student test...');
  await page.goto('http://127.0.0.1:3008/online-test.html?code=d8f021', { waitUntil: 'networkidle0' });

  // 1. Start exam
  await page.type('#splash-student-name', 'Verification Student');
  await page.evaluate(() => {
    if (typeof revealExamContent === 'function') {
      revealExamContent();
    }
  });

  await new Promise(r => setTimeout(r, 600));

  // 2. Scroll directly to Section 2 (Part 2)
  await page.evaluate(() => {
    const secCards = document.querySelectorAll('[id^="section-card-"], .section-card, .test-section-card');
    console.log('Found section cards:', secCards.length);
    if (secCards.length > 1) {
      secCards[1].scrollIntoView({ behavior: 'instant', block: 'start' });
    }
  });

  await new Promise(r => setTimeout(r, 500));
  await page.screenshot({ path: path.join(outDir, '12_student_part2_text_options.png') });
  console.log('Captured 12_student_part2_text_options.png');

  await browser.close();
  console.log('Done!');
}

capture().catch(err => {
  console.error('Puppeteer capture error:', err);
  process.exit(1);
});
