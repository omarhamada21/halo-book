import path from 'path';
import crypto from 'crypto';
import { S3Client, PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import fs from 'fs';
import '../config/env.js';
import { __dirname } from '../paths.js';

// ----------------- MCQ TESTS (FILEBASE S3 & GEMINI GENERATION) -----------------

function getMissingFilebaseEnvVars() {
  const required = ['FILEBASE_ACCESS_KEY', 'FILEBASE_SECRET_KEY', 'FILEBASE_BUCKET_NAME', 'FILEBASE_ENDPOINT'];
  return required.filter((v) => !process.env[v] || !process.env[v].trim());
}

function getFilebaseEndpoint() {
  const rawEndpoint = (process.env.FILEBASE_ENDPOINT || 'https://s3.filebase.io').trim();
  const endpoint = rawEndpoint.startsWith('http://') || rawEndpoint.startsWith('https://')
    ? rawEndpoint
    : `https://${rawEndpoint}`;
  return endpoint.replace('s3.filebase.com', 's3.filebase.io').replace(/\/+$/, '');
}

async function uploadAudioToFilebase(audioFile) {
  const missing = getMissingFilebaseEnvVars();
  if (missing.length > 0) {
    throw new Error(`Filebase storage configuration error: Missing required environment variable(s): ${missing.join(', ')}`);
  }

  const endpoint = getFilebaseEndpoint();
  const s3Client = new S3Client({
    endpoint,
    region: 'us-east-1',
    credentials: {
      accessKeyId: process.env.FILEBASE_ACCESS_KEY.trim(),
      secretAccessKey: process.env.FILEBASE_SECRET_KEY.trim()
    },
    forcePathStyle: true
  });

  const fileExt = path.extname(audioFile.originalname || '') || '.mp3';
  const safeExt = fileExt.toLowerCase().startsWith('.') ? fileExt.toLowerCase() : `.${fileExt.toLowerCase()}`;
  const objectKey = `mcq-audio/${Date.now()}_${crypto.randomBytes(6).toString('hex')}${safeExt}`;
  const bucketName = process.env.FILEBASE_BUCKET_NAME.trim();

  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: objectKey,
      Body: audioFile.buffer,
      ContentType: audioFile.mimetype || 'audio/mpeg'
    })
  );

  // Return ONLY the object key (e.g. "mcq-audio/12345_abc.wav")
  return objectKey;
}

async function generateSignedAudioUrl(objectKey) {
  if (!objectKey) return null;
  const missing = getMissingFilebaseEnvVars();
  if (missing.length > 0) return null;

  try {
    const endpoint = getFilebaseEndpoint();
    const s3Client = new S3Client({
      endpoint,
      region: 'us-east-1',
      credentials: {
        accessKeyId: process.env.FILEBASE_ACCESS_KEY.trim(),
        secretAccessKey: process.env.FILEBASE_SECRET_KEY.trim()
      },
      forcePathStyle: true
    });

    const command = new GetObjectCommand({
      Bucket: process.env.FILEBASE_BUCKET_NAME.trim(),
      Key: objectKey
    });

    // Valid for 1 hour (3600 seconds)
    return await getSignedUrl(s3Client, command, { expiresIn: 3600 });
  } catch (err) {
    console.warn(`[Filebase Pre-sign Warning] Failed to generate signed URL for ${objectKey}:`, err.message);
    return null;
  }
}

async function generateSignedImageUrl(objectKey) {
  if (!objectKey) return null;
  const missing = getMissingFilebaseEnvVars();
  if (missing.length === 0) {
    try {
      const endpoint = getFilebaseEndpoint();
      const s3Client = new S3Client({
        endpoint,
        region: 'us-east-1',
        credentials: {
          accessKeyId: process.env.FILEBASE_ACCESS_KEY.trim(),
          secretAccessKey: process.env.FILEBASE_SECRET_KEY.trim()
        },
        forcePathStyle: true
      });

      const command = new GetObjectCommand({
        Bucket: process.env.FILEBASE_BUCKET_NAME.trim(),
        Key: objectKey
      });

      // Valid for 1 hour (3600 seconds), matching audio pre-sign
      return await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    } catch (err) {
      console.warn(`[Filebase Image Pre-sign Warning] Failed to generate signed URL for ${objectKey}:`, err.message);
    }
  }

  // Local fallback if local path or Filebase is unavailable
  if (typeof objectKey === 'string') {
    if (objectKey.startsWith('/uploads/') || objectKey.startsWith('uploads/')) {
      return objectKey.startsWith('/') ? objectKey : `/${objectKey}`;
    }
    const localRel = `/uploads/online-tests/images/${path.basename(objectKey)}`;
    const fullPath = path.join(__dirname, 'public', 'uploads', 'online-tests', 'images', path.basename(objectKey));
    if (fs.existsSync(fullPath)) {
      return localRel;
    }
  }
  return null;
}

async function deleteStorageFiles(fileUrls) {
  if (!Array.isArray(fileUrls) || fileUrls.length === 0) return;
  const s3Keys = [];

  for (const rawUrl of fileUrls) {
    if (!rawUrl || typeof rawUrl !== 'string') continue;

    // Handle S3 / Cloud URLs
    if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
      try {
        const parsed = new URL(rawUrl);
        let key = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
        const bucket = (process.env.FILEBASE_BUCKET_NAME || process.env.S3_BUCKET_NAME || '').trim();
        if (bucket && key.startsWith(bucket + '/')) {
          key = key.slice(bucket.length + 1);
        }
        if (key) s3Keys.push({ Key: key });
      } catch (e) {
        console.warn('[Storage Cleanup] Invalid URL:', rawUrl);
      }
    }
    // Handle local disk uploads (/uploads/...)
    else if (rawUrl.startsWith('/uploads/') || rawUrl.includes('uploads/')) {
      try {
        const idx = rawUrl.indexOf('uploads/');
        const rel = rawUrl.slice(idx);
        const localPath = path.join(__dirname, 'public', rel);
        if (fs.existsSync(localPath)) {
          fs.unlinkSync(localPath);
          console.log('[Storage Cleanup] Removed local file:', localPath);
        }
      } catch (e) {
        console.warn('[Storage Cleanup] Local delete error:', e.message);
      }
    }
    // Handle direct object keys (e.g. online-tests/..., audio/...)
    else if (!rawUrl.startsWith('.') && !rawUrl.startsWith('/')) {
      s3Keys.push({ Key: rawUrl });
    }
  }

  // Deduplicate S3 keys
  const uniqueKeys = [];
  const seenKeys = new Set();
  for (const item of s3Keys) {
    if (item.Key && !seenKeys.has(item.Key)) {
      seenKeys.add(item.Key);
      uniqueKeys.push(item);
    }
  }

  const missing = getMissingFilebaseEnvVars();
  const bucketName = (process.env.FILEBASE_BUCKET_NAME || process.env.S3_BUCKET_NAME || '').trim();
  if (uniqueKeys.length > 0 && missing.length === 0 && bucketName) {
    try {
      const endpoint = getFilebaseEndpoint();
      const s3Client = new S3Client({
        endpoint,
        region: 'us-east-1',
        credentials: {
          accessKeyId: process.env.FILEBASE_ACCESS_KEY.trim(),
          secretAccessKey: process.env.FILEBASE_SECRET_KEY.trim()
        },
        forcePathStyle: true
      });

      for (let i = 0; i < uniqueKeys.length; i += 1000) {
        const chunk = uniqueKeys.slice(i, i + 1000);
        const deleteCmd = new DeleteObjectsCommand({
          Bucket: bucketName,
          Delete: { Objects: chunk, Quiet: true }
        });
        await s3Client.send(deleteCmd);
      }
      console.log(`[Storage Cleanup] Successfully purged ${uniqueKeys.length} objects from S3/Filebase.`);
    } catch (err) {
      console.error('[Storage Cleanup] S3 deletion error:', err.message);
    }
  }
}

async function deleteAudioFromFilebase(objectKey) {
  if (!objectKey) return;
  await deleteStorageFiles([objectKey]);
}

async function uploadOnlineTestAudioToFilebase(audioFile) {
  const missing = getMissingFilebaseEnvVars();
  if (missing.length > 0) {
    throw new Error(`Filebase storage configuration error: Missing required environment variable(s): ${missing.join(', ')}`);
  }

  const endpoint = getFilebaseEndpoint();
  const s3Client = new S3Client({
    endpoint,
    region: 'us-east-1',
    credentials: {
      accessKeyId: process.env.FILEBASE_ACCESS_KEY.trim(),
      secretAccessKey: process.env.FILEBASE_SECRET_KEY.trim()
    },
    forcePathStyle: true
  });

  const fileExt = path.extname(audioFile.originalname || '') || '.mp3';
  const safeExt = fileExt.toLowerCase().startsWith('.') ? fileExt.toLowerCase() : `.${fileExt.toLowerCase()}`;
  const objectKey = `online-tests-audio/${Date.now()}_${crypto.randomBytes(6).toString('hex')}${safeExt}`;
  const bucketName = process.env.FILEBASE_BUCKET_NAME.trim();

  const fileStream = audioFile.path ? fs.createReadStream(audioFile.path) : audioFile.buffer;

  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: objectKey,
      Body: fileStream,
      ContentType: audioFile.mimetype || 'audio/mpeg'
    })
  );

  return objectKey;
}

async function uploadExamImageToFilebaseOrLocal(buffer, index, testId) {
  const missing = getMissingFilebaseEnvVars();
  const folder = testId ? `test_${testId}` : `batch_${Date.now()}`;
  const objectKey = `online-tests/${folder}/images/img_${index}.png`;

  // 1. Try Filebase S3 if credentials are configured
  if (missing.length === 0) {
    try {
      const endpoint = getFilebaseEndpoint();
      const s3Client = new S3Client({
        endpoint,
        region: 'us-east-1',
        credentials: {
          accessKeyId: process.env.FILEBASE_ACCESS_KEY.trim(),
          secretAccessKey: process.env.FILEBASE_SECRET_KEY.trim()
        },
        forcePathStyle: true
      });

      const bucketName = process.env.FILEBASE_BUCKET_NAME.trim();
      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: objectKey,
          Body: buffer,
          ContentType: 'image/png'
        })
      );

      // Generate signed URL (valid for 1 hour, matching audio)
      const command = new GetObjectCommand({
        Bucket: bucketName,
        Key: objectKey
      });
      const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
      if (signedUrl) return { objectKey, url: signedUrl };
    } catch (s3Err) {
      console.warn(`[Exam Image S3 Upload Warning for img_${index}]:`, s3Err.message);
    }
  }

  // 2. Fallback to local /public/uploads/online-tests/images/
  try {
    const localDir = path.join(__dirname, 'public', 'uploads', 'online-tests', 'images');
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }
    const filename = `img_${folder}_${index}_${crypto.randomBytes(4).toString('hex')}.png`;
    const fullPath = path.join(localDir, filename);
    fs.writeFileSync(fullPath, buffer);
    const localRel = `/uploads/online-tests/images/${filename}`;
    return { objectKey: localRel, url: localRel };
  } catch (fsErr) {
    console.error(`[Exam Image Local Fallback Error for img_${index}]:`, fsErr);
    throw fsErr;
  }
}

export { getMissingFilebaseEnvVars, getFilebaseEndpoint, uploadAudioToFilebase, generateSignedAudioUrl, generateSignedImageUrl, deleteStorageFiles, deleteAudioFromFilebase, uploadOnlineTestAudioToFilebase, uploadExamImageToFilebaseOrLocal };
