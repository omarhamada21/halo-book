import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import { db } from '../../db/client.js';
import { ai } from '../../integrations/gemini.js';

// ----------------- UNIVERSAL AUDIO TRANSCRIBER -----------------
// Writes buffer to temp file, streams to Google Gen AI Files API, transcribes with gemini-2.5-flash / fallback models,
// and ensures both local and remote files are cleaned up in a finally block.
async function transcribeListeningAudio(audioBuffer, originalName, mimeType) {
  if (!audioBuffer || audioBuffer.length === 0) return null;
  const safeName = originalName ? path.basename(originalName) : 'audio.mp3';
  const tempPath = path.join(os.tmpdir(), `mimir_audio_${Date.now()}_${safeName}`);
  let uploadRes = null;

  try {
    fs.writeFileSync(tempPath, audioBuffer);
    const resolvedMime = mimeType || 'audio/mp3';

    uploadRes = await ai.files.upload({
      file: tempPath,
      mimeType: resolvedMime
    });

    const models = ['gemini-2.5-flash', 'gemini-3.6-flash', 'gemini-3.5-flash'];
    let transcript = null;

    for (const model of models) {
      try {
        const response = await ai.models.generateContent({
          model: model,
          contents: [
            {
              fileData: {
                fileUri: uploadRes.uri,
                mimeType: uploadRes.mimeType || resolvedMime
              }
            },
            'You are an expert exam transcriber. Transcribe this listening exam track verbatim from beginning to end with exact dialogue, speaker labels (e.g. Speaker 1, Lara, Interviewer), and audio markers. Output pure verbatim transcript text.'
          ]
        });
        transcript = response.text ? response.text.trim() : null;
        if (transcript) break;
      } catch (err) {
        console.warn(`[Transcription Model ${model} Notice]:`, err.message);
      }
    }

    return transcript;
  } catch (err) {
    console.warn('Audio transcription warning:', err.message);
    return null;
  } finally {
    if (uploadRes && uploadRes.name) {
      try { await ai.files.delete({ name: uploadRes.name }); } catch (_) { }
    }
    try { fs.unlinkSync(tempPath); } catch (_) { }
  }
}

async function generateUniqueMcqCode() {
  for (let i = 0; i < 10; i++) {
    const code = crypto.randomBytes(4).toString('hex');
    const existing = await db.execute({
      sql: 'SELECT id FROM mcq_tests WHERE code = ? LIMIT 1',
      args: [code]
    });
    if (existing.rows.length === 0) return code;
  }
  return crypto.randomBytes(6).toString('hex');
}

export { transcribeListeningAudio, generateUniqueMcqCode };
