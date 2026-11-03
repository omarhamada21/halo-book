import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import sharp from 'sharp';
import zlib from 'zlib';

function unfilterPngPredictor(decompressed, width, height, bytesPerPixel) {
  const rowBytes = width * bytesPerPixel;
  const filteredRowLength = rowBytes + 1;
  const output = Buffer.alloc(width * height * bytesPerPixel);

  for (let y = 0; y < height; y++) {
    const filterType = decompressed[y * filteredRowLength];
    const srcRow = decompressed.subarray(y * filteredRowLength + 1, (y + 1) * filteredRowLength);
    const dstOffset = y * rowBytes;
    const prevDstOffset = (y - 1) * rowBytes;

    for (let x = 0; x < rowBytes; x++) {
      const byteVal = srcRow[x];
      const left = x >= bytesPerPixel ? output[dstOffset + x - bytesPerPixel] : 0;
      const above = y > 0 ? output[prevDstOffset + x] : 0;
      const upperLeft = y > 0 && x >= bytesPerPixel ? output[prevDstOffset + x - bytesPerPixel] : 0;

      let rawVal = byteVal;
      if (filterType === 1) rawVal = (byteVal + left) & 0xff;
      else if (filterType === 2) rawVal = (byteVal + above) & 0xff;
      else if (filterType === 3) rawVal = (byteVal + Math.floor((left + above) / 2)) & 0xff;
      else if (filterType === 4) {
        const p = left + above - upperLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - above);
        const pc = Math.abs(p - upperLeft);
        let pr = upperLeft;
        if (pa <= pb && pa <= pc) pr = left;
        else if (pb <= pc) pr = above;
        rawVal = (byteVal + pr) & 0xff;
      }
      output[dstOffset + x] = rawVal;
    }
  }
  return output;
}

async function extractImagesFromPdf(pdfBuffer) {
  const extracted = [];
  let imgIndex = 0;

  // STAGE 1: Direct stream deconstruction via pdf-lib & sharp
  try {
    const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    const indirectObjects = pdfDoc.context.enumerateIndirectObjects();

    for (const [ref, obj] of indirectObjects) {
      if (!(obj instanceof PDFRawStream)) continue;
      const dict = obj.dict;
      if (!dict) continue;

      const subtype = dict.get(PDFName.of('Subtype'));
      if (subtype !== PDFName.of('Image')) continue;

      try {
        const widthObj = dict.get(PDFName.of('Width'));
        const heightObj = dict.get(PDFName.of('Height'));
        const width = typeof widthObj?.asNumber === 'function' ? widthObj.asNumber() : Number(widthObj);
        const height = typeof heightObj?.asNumber === 'function' ? heightObj.asNumber() : Number(heightObj);

        // Ignore tiny artifacts, icons, hair-lines, or 1x1 masks
        if (!width || !height || width < 25 || height < 25) continue;

        const filter = dict.get(PDFName.of('Filter'));
        const bpcObj = dict.get(PDFName.of('BitsPerComponent'));
        const bpc = typeof bpcObj?.asNumber === 'function' ? bpcObj.asNumber() : Number(bpcObj) || 8;
        const isMask = dict.get(PDFName.of('ImageMask')) === true || dict.get(PDFName.of('ImageMask'))?.value === true;
        let imgBuffer = null;

        if (filter === PDFName.of('DCTDecode')) {
          imgBuffer = await sharp(Buffer.from(obj.contents)).png().toBuffer();
        } else if (filter === PDFName.of('FlateDecode')) {
          const decompressed = zlib.inflateSync(Buffer.from(obj.contents));

          if (bpc === 1 || isMask) {
            // 1-bit monochrome line drawing / illustration (e.g. Cambridge listening options)
            const rowBytes = Math.ceil(width / 8);
            const grayBuffer = Buffer.alloc(width * height);
            const decodeArr = dict.get(PDFName.of('Decode'));
            const invert = Array.isArray(decodeArr) && decodeArr.length >= 2 && Number(decodeArr[0]) === 1;

            for (let y = 0; y < height; y++) {
              for (let x = 0; x < width; x++) {
                const srcIdx = y * rowBytes + (x >> 3);
                if (srcIdx < decompressed.length) {
                  const bit = (decompressed[srcIdx] >> (7 - (x & 7))) & 1;
                  const val = bit ? 0 : 255;
                  grayBuffer[y * width + x] = invert ? (255 - val) : val;
                } else {
                  grayBuffer[y * width + x] = 255;
                }
              }
            }
            imgBuffer = await sharp(grayBuffer, { raw: { width, height, channels: 1 } }).png().toBuffer();
          } else {
            const decodeParms = dict.get(PDFName.of('DecodeParms'));
            let predictor = 1;
            if (decodeParms && typeof decodeParms.get === 'function') {
              const pObj = decodeParms.get(PDFName.of('Predictor'));
              if (pObj) {
                predictor = typeof pObj.asNumber === 'function' ? pObj.asNumber() : Number(pObj) || 1;
              }
            }

            const cs = dict.get(PDFName.of('ColorSpace'));
            let channels = 3;
            if (cs === PDFName.of('DeviceGray')) channels = 1;
            else if (cs === PDFName.of('DeviceCMYK')) channels = 4;

            let pixelData = decompressed;
            if (predictor >= 10) {
              pixelData = unfilterPngPredictor(decompressed, width, height, channels);
            }

            if (pixelData && pixelData.length >= width * height * channels) {
              imgBuffer = await sharp(pixelData.subarray(0, width * height * channels), {
                raw: { width, height, channels }
              }).png().toBuffer();
            } else {
              try {
                imgBuffer = await sharp(Buffer.from(obj.contents)).png().toBuffer();
              } catch (_) { }
            }
          }
        } else {
          try {
            imgBuffer = await sharp(Buffer.from(obj.contents)).png().toBuffer();
          } catch (_) { }
        }

        if (imgBuffer && imgBuffer.length > 0) {
          extracted.push({
            index: imgIndex++,
            buffer: imgBuffer,
            width,
            height
          });
        }
      } catch (itemErr) {
        console.warn('[PDF Image Extract Item Notice]:', itemErr.message);
      }
    }
  } catch (err) {
    console.warn('[PDF Image Extract Stage 1 Notice]:', err.message);
  }

  // STAGE 2: PDF.js Operator List extraction for exotic encodings (CCITTFax, JBIG2, JPX, Form XObjects)
  if (extracted.length === 0) {
    try {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBuffer) }).promise;

      for (let pNum = 1; pNum <= doc.numPages; pNum++) {
        const page = await doc.getPage(pNum);
        const opList = await page.getOperatorList();

        for (let i = 0; i < opList.fnArray.length; i++) {
          const fn = opList.fnArray[i];
          if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject) {
            const imgName = opList.argsArray[i][0];
            await new Promise((resolve) => {
              page.objs.get(imgName, async (img) => {
                try {
                  if (img && img.data && img.width >= 25 && img.height >= 25) {
                    let channels = 3;
                    let rawBuf = Buffer.from(img.data);

                    if (img.data.length === img.width * img.height * 4) {
                      channels = 4;
                    } else if (img.data.length === img.width * img.height * 3) {
                      channels = 3;
                    } else if (img.data.length === img.width * img.height) {
                      channels = 1;
                    } else if (img.data.length < img.width * img.height) {
                      // 1bpp expansion
                      const rowBytes = Math.ceil(img.width / 8);
                      const expanded = Buffer.alloc(img.width * img.height);
                      for (let y = 0; y < img.height; y++) {
                        for (let x = 0; x < img.width; x++) {
                          const byte = img.data[y * rowBytes + (x >> 3)];
                          const bit = (byte >> (7 - (x & 7))) & 1;
                          expanded[y * img.width + x] = bit ? 0 : 255;
                        }
                      }
                      rawBuf = expanded;
                      channels = 1;
                    }

                    const imgBuffer = await sharp(rawBuf, {
                      raw: { width: img.width, height: img.height, channels }
                    }).png().toBuffer();

                    if (imgBuffer && imgBuffer.length > 0) {
                      extracted.push({
                        index: imgIndex++,
                        buffer: imgBuffer,
                        width: img.width,
                        height: img.height
                      });
                    }
                  }
                } catch (convErr) {
                  console.warn('[pdfjs-dist image conversion notice]:', convErr.message);
                }
                resolve();
              });
            });
          }
        }
      }
    } catch (pdfjsErr) {
      console.warn('[PDF Image Extract Stage 2 Notice]:', pdfjsErr.message);
    }
  }

  return extracted;
}

/**
 * Visual Option Extraction Engine:
 * 
 * IMPORTANT LIMITATION NOTICE:
 * This automated extraction heuristic (vector render-and-crop based on option label geometry)
 * has ONLY been validated against Cambridge English exam papers (specifically 0876/02 listening
 * papers with 3-picture horizontal A/B/C option layout).
 * 
 * Extraction success is NOT guaranteed to be predictable across arbitrary exam formats, 
 * different publishers, non-standard DPI, varied font metrics, or custom teacher layouts.
 * 
 * The automated pipeline is a best-effort convenience feature. Teachers MUST be prepared 
 * to routinely utilize the mandatory manual fallback ("Upload Image" in the Review UI) whenever 
 * automated extraction fails, crops inaccurately, or encounters an unsupported layout. 
 * The system enforces this contract by strictly blocking test publication (HTTP 422) if any 
 * picture-choice option is missing a valid image.
 */
async function extractVisualOptionCropsFromPdf(pdfBuffer) {
  const crops = [];
  try {
    const { createCanvas } = await import('@napi-rs/canvas');
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBuffer) }).promise;
    const scale = 2.0;
    let currentQNum = 1;

    for (let pNum = 1; pNum <= doc.numPages; pNum++) {
      const page = await doc.getPage(pNum);
      const viewport = page.getViewport({ scale: 1.0 });
      const textContent = await page.getTextContent();

      const pageStrings = textContent.items.map(it => it.str).filter(s => s && s.trim());
      const pageFullText = pageStrings.join(' ');

      // Hard stop as soon as Part 2 or beyond is reached
      if (/part\s*[2-5]/i.test(pageFullText) || /questions?\s*(?:6|1[16]|21)\b/i.test(pageFullText)) {
        console.log(`[Visual Crop Engine] Reached Part 2/after on page ${pNum}. Stopping extraction.`);
        break;
      }

      const isPart1Page = /part\s*1/i.test(pageFullText) || /questions?\s*1\s*[-–]\s*5/i.test(pageFullText) || pNum === 2 || pNum === 3;
      if (!isPart1Page) continue;

      const items = [];
      for (const item of textContent.items) {
        const str = (item.str || '').trim();
        if (!str) continue;
        const tx = pdfjs.Util.transform(viewport.transform, item.transform);
        items.push({ str, x: tx[4], y: tx[5], w: item.width, h: item.height });
      }

      // Filter letters A, B, C, D (normalizing S -> C)
      const letterItems = [];
      for (const it of items) {
        let clean = it.str.replace(/[()[\]:.]/g, '').trim().toUpperCase();
        if (clean === 'S') clean = 'C';
        if (['A', 'B', 'C', 'D'].includes(clean)) {
          letterItems.push({ ...it, letter: clean });
        }
      }

      // Group into horizontal rows (Y +- 15px)
      const rowGroups = [];
      for (const lit of letterItems) {
        let grp = rowGroups.find(g => Math.abs(g.y - lit.y) <= 15);
        if (!grp) {
          grp = { y: lit.y, letters: [] };
          rowGroups.push(grp);
        }
        grp.letters.push(lit);
      }

      // Filter to genuine picture rows (span > 120) and sort top-to-bottom
      const pictureRows = [];
      for (const grp of rowGroups) {
        grp.letters.sort((a, b) => a.x - b.x);
        const deduped = [];
        for (const l of grp.letters) {
          if (!deduped.some(d => Math.abs(d.x - l.x) < 25)) deduped.push(l);
        }
        grp.letters = deduped;

        if (grp.letters.length >= 2) {
          const span = grp.letters[grp.letters.length - 1].x - grp.letters[0].x;
          if (span > 120) {
            pictureRows.push(grp);
          }
        }
      }

      pictureRows.sort((a, b) => a.y - b.y);

      let pageBuf = null;
      let renderViewport = null;

      for (const grp of pictureRows) {
        const precedingItems = items.filter(it => it.y < grp.y && it.y > grp.y - 180);
        const precedingText = precedingItems.map(it => it.str).join(' ');

        // Check if this is the Example row
        if (/example/i.test(precedingText) || (pNum === 2 && grp === pictureRows[0] && /lunch/i.test(precedingText))) {
          continue;
        }

        // Determine Question Number (strictly 1 to 5)
        const cleanPrec = precedingText.replace(/\[\d+\]/g, '').trim();
        const qNumMatch = cleanPrec.match(/(?:^|\s|\b)([1-5])\b/);
        let qNum = qNumMatch ? parseInt(qNumMatch[1], 10) : currentQNum;
        if (qNum > 5) continue; // Never exceed Question 5

        currentQNum = Math.max(currentQNum, qNum + 1);

        // Cambridge Part 1 uses 3 pictures: A, B, C horizontally
        let finalLetters = [];
        if (grp.letters.length >= 3) {
          finalLetters = [
            { ...grp.letters[0], letter: 'A' },
            { ...grp.letters[1], letter: 'B' },
            { ...grp.letters[2], letter: 'C' }
          ];
        } else if (grp.letters.length === 2) {
          const dx = grp.letters[1].x - grp.letters[0].x;
          if (grp.letters[0].x < 190) {
            finalLetters = [
              { ...grp.letters[0], letter: 'A' },
              { ...grp.letters[1], letter: 'B' },
              { x: grp.letters[1].x + dx, y: grp.y, w: 10, h: 10, letter: 'C' }
            ];
          } else {
            finalLetters = [
              { x: Math.max(30, grp.letters[0].x - dx), y: grp.y, w: 10, h: 10, letter: 'A' },
              { ...grp.letters[0], letter: 'B' },
              { ...grp.letters[1], letter: 'C' }
            ];
          }
        }

        if (finalLetters.length > 0) {
          if (!pageBuf) {
            renderViewport = page.getViewport({ scale });
            const canvas = createCanvas(renderViewport.width, renderViewport.height);
            const ctx = canvas.getContext('2d');
            await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;
            pageBuf = canvas.toBuffer('image/png');
          }

          for (const l of finalLetters) {
            const centerX = l.x + (l.w ? l.w / 2 : 5);
            const labelY = l.y;
            const left = Math.max(0, Math.round((centerX - 75) * scale));
            const top = Math.max(0, Math.round((labelY - 130) * scale));
            const width = Math.min(renderViewport.width - left, Math.round(150 * scale));
            const height = Math.min(renderViewport.height - top, Math.round(120 * scale));

            if (width >= 40 && height >= 40) {
              const cropped = await sharp(pageBuf)
                .extract({ left, top, width, height })
                .png()
                .toBuffer();

              crops.push({
                page: pNum,
                questionNumber: qNum,
                letter: l.letter,
                buffer: cropped,
                width,
                height
              });
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn('[PDF Visual Option Crop Engine Notice]:', err.message);
  }
  return crops;
}

export { unfilterPngPredictor, extractImagesFromPdf, extractVisualOptionCropsFromPdf };
