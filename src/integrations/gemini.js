import { GoogleGenAI } from '@google/genai';
import '../config/env.js';
import { delay } from '../lib/delay.js';

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

// ----------------- GEMINI AI EVALUATION ENGINE -----------------
// Falls back from gemini-3.6-flash (primary, high speed & quality) to gemini-3.5-flash to prevent outages if the primary model degrades.
// Retries only on transient capacity/rate errors (500, 503, high demand, quota) where backoff helps, skipping non-recoverable 4xx errors.
async function callGemini(inputPayload, configOverride = null) {
  const models = ['gemini-3.6-flash', 'gemini-3.5-flash'];
  let lastErr;

  const defaultConfig = {
    responseMimeType: 'application/json',
    responseSchema: {
      type: 'OBJECT',
      properties: {
        student_name: { type: 'STRING' },
        extracted_essay: { type: 'STRING' },
        total_score: { type: 'STRING' },
        category_breakdown: { type: 'STRING' },
        mistakes: { type: 'STRING' },
        weaknesses: { type: 'STRING' },
        ai_probability_score: { type: 'INTEGER' },
        ai_detection_notes: { type: 'STRING' },
        web_similarity_score: { type: 'INTEGER' }
      },
      required: [
        'student_name',
        'extracted_essay',
        'total_score',
        'category_breakdown',
        'mistakes',
        'weaknesses',
        'ai_probability_score',
        'ai_detection_notes',
        'web_similarity_score'
      ]
    }
  };

  const activeConfig = configOverride || defaultConfig;

  for (const modelName of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: inputPayload,
          config: activeConfig
        });
        return response.text;
      } catch (err) {
        const errMsg = err.message || '';
        console.warn(`[${modelName} attempt ${attempt + 1}] Notice: ${errMsg}`);
        lastErr = err;

        if (errMsg.includes('500') || errMsg.includes('503') || errMsg.includes('high demand') || errMsg.includes('quota')) {
          await delay(800 * (attempt + 1));
          continue;
        }
        break;
      }
    }
  }
  throw lastErr;
}

export { ai, callGemini };
