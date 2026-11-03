import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, fieldSize: 50 * 1024 * 1024 }
});

const mcqUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB per file to safely accommodate .wav / high-bitrate audio
    fieldSize: 10 * 1024 * 1024
  }
});

// ----------------- ONLINE TESTS: GEMINI INGESTION ENGINE -----------------

const onlineTestDiskStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, os.tmpdir());
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '') || '';
    const safeField = (file.fieldname || 'file').replace(/[^a-zA-Z0-9_-]/g, '_');
    cb(null, `online_test_${safeField}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`);
  }
});

const onlineTestUpload = multer({
  storage: onlineTestDiskStorage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB per file to safely handle large listening audio files
    fieldSize: 10 * 1024 * 1024
  }
});

// Dedicated Manual Option Image Upload Routes (reusable by Online Tests and MCQ builder)
const optionImgUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(process.cwd(), 'public', 'uploads', 'option-images');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `opt_${Date.now()}_${Math.random().toString(36).substring(2, 8)}${ext}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 }
});

export { upload, mcqUpload, onlineTestDiskStorage, onlineTestUpload, optionImgUpload };
