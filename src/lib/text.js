import mammoth from 'mammoth';
import { createRequire } from 'module';
import { isPdf } from './fileTypes.js';

const require = createRequire(import.meta.url);

let pdfParse;
try {
  const pdfModule = require('pdf-parse');
  pdfParse = typeof pdfModule === 'function' ? pdfModule : pdfModule.default;
} catch (e) {
  console.warn('pdf-parse module load warning:', e.message);
}

async function extractText(file) {
  if (!file) return '';
  const mime = file.mimetype || '';
  const name = file.originalname ? file.originalname.toLowerCase() : '';

  if (isPdf(file)) {
    if (typeof pdfParse === 'function') {
      try {
        const data = await pdfParse(file.buffer);
        if (data && data.text && data.text.trim()) return data.text;
      } catch (err) {
        console.warn('PDF extraction notice:', err.message);
      }
    }
    return '';
  }

  if (
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    name.endsWith('.docx')
  ) {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return result.value;
  }

  return file.buffer.toString('utf-8');
}

function calculateTextSimilarity(text1, text2) {
  if (!text1 || !text2) return { score: 0, sharedPhrases: [] };

  const clean1 = text1.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 2);
  const clean2 = text2.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 2);

  if (clean1.length < 5 || clean2.length < 5) return { score: 0, sharedPhrases: [] };

  const getTrigrams = (words) => {
    const set = new Set();
    for (let i = 0; i < words.length - 2; i++) {
      set.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
    }
    return set;
  };

  const set1 = getTrigrams(clean1);
  const set2 = getTrigrams(clean2);

  let matches = 0;
  const shared = [];
  for (const tri of set1) {
    if (set2.has(tri)) {
      matches++;
      if (shared.length < 3) shared.push(tri);
    }
  }

  const denominator = Math.min(set1.size, set2.size);
  const score = denominator > 0 ? Math.min(100, Math.round((matches / denominator) * 100)) : 0;

  return { score, sharedPhrases: shared };
}

export { pdfParse, extractText, calculateTextSimilarity };
