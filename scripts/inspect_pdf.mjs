import fs from 'fs';
import path from 'path';

async function inspectPdf(pdfPath) {
  console.log(`\n=== Inspecting ${path.basename(pdfPath)} ===`);
  const pdfBuffer = fs.readFileSync(pdfPath);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBuffer) }).promise;
  console.log(`Total Pages: ${doc.numPages}`);

  for (let pNum = 1; pNum <= Math.min(doc.numPages, 10); pNum++) {
    const page = await doc.getPage(pNum);
    const textContent = await page.getTextContent();
    const strings = textContent.items.map(it => it.str).filter(s => s.trim().length > 0);
    const fullText = strings.join(' ');
    
    // Check for Part indicators
    const isPart1 = /part\s*1/i.test(fullText);
    const isPart2 = /part\s*2/i.test(fullText);
    const isPart3 = /part\s*3/i.test(fullText);
    const isPart4 = /part\s*4/i.test(fullText);
    const isPart5 = /part\s*5/i.test(fullText);
    const isQuestions1to5 = /questions?\s*1\s*[-–]\s*5/i.test(fullText);
    const hasExample = /example/i.test(fullText);
    console.log(`--- Page ${pNum} (${strings.length} items) ---`);
    console.log(`Snippet: ${fullText.slice(0, 180)}...`);
    console.log(`Flags: isPart1=${isPart1}, isQuestions1to5=${isQuestions1to5}, isPart2=${isPart2}, isPart3=${isPart3}, isPart4=${isPart4}, isPart5=${isPart5}, hasExample=${hasExample}`);
  }
}

const p1 = 'C:\\Users\\ohama\\Desktop\\testt\\Progression Test Stage 7 English 2023 2nd P2 .pdf';
if (fs.existsSync(p1)) {
  await inspectPdf(p1);
} else {
  console.log('File not found:', p1);
}

const p2 = 'C:\\Users\\ohama\\Desktop\\New folder (4)\\listen questions.pdf';
if (fs.existsSync(p2)) {
  await inspectPdf(p2);
}
