  const urlParams = new URLSearchParams(window.location.search);
  const bundleCode = urlParams.get('bundle') || urlParams.get('code');
  
  function getOrCreateDeviceId() {
    let stored = localStorage.getItem('mimir_device_token');
    // Guard against legacy truncated collision tokens (e.g. dev_NDE0eDg5...) that lacked true UUID randomness
    const isLegacyTruncated = stored && (
      stored.startsWith('dev_NDE0eDg5') ||
      stored.startsWith('dev_NDQweDk1') ||
      stored.startsWith('dev_NDI4eDky') ||
      stored.startsWith('dev_MzYweDgw') ||
      stored.length < 35 ||
      (stored.length <= 36 && !stored.includes('-'))
    );
    if (stored && !isLegacyTruncated) return stored;

    let uuid = '';
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      try { uuid = crypto.randomUUID(); } catch (_) {}
    }
    if (!uuid) {
      uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    }
    stored = 'dev_' + uuid;
    try { localStorage.setItem('mimir_device_token', stored); } catch (_) {}
    return stored;
  }
  const clientDeviceId = getOrCreateDeviceId();

  let bundleTasks = [];
  let taskFilesMap = {};
  let taskLockMap = {};
  let activeCompressions = 0;
  window.getActiveCompressions = () => activeCompressions;
  window.setActiveCompressions = (n) => { activeCompressions = n; updateSubmitButtonState(); };

  function formatCairoDateTime(dateObj) {
    return dateObj.toLocaleString('en-US', {
      timeZone: 'Africa/Cairo',
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true
    });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function showAssignmentClosedState(type, deadlineDate) {
    const form = document.getElementById('student-form');
    if (form) form.style.display = 'none';
    const dlBox = document.getElementById('assign-deadline');
    dlBox.style.display = 'block';
    dlBox.className = 'deadline-box deadline-expired';

    if (type === 'deadline') {
      const formattedCairo = formatCairoDateTime(deadlineDate);
      document.getElementById('assign-title').textContent = 'Submissions Closed';
      dlBox.innerHTML = `⛔ <b>Submissions Closed:</b> This assignment's submission window has closed. The deadline was ${formattedCairo} (Cairo Time). Contact your teacher if you believe this is a mistake.`;
    } else {
      document.getElementById('assign-title').textContent = 'Invalid Assignment Link';
      dlBox.innerHTML = `This assignment link appears to be invalid or has been removed. Please check the link with your teacher.`;
    }
  }

  if (!bundleCode) {
    showAssignmentClosedState('invalid');
  } else {
    loadAssignmentBundle();
  }

  async function loadAssignmentBundle() {
    try {
      const res = await fetch(`/api/public/bundle/${encodeURIComponent(bundleCode)}`);
      const d = await res.json().catch(() => ({}));

      if (!res.ok || !d.success) {
        showAssignmentClosedState('invalid');
        return;
      }

      bundleTasks = d.tasks || [];
      document.getElementById('assign-title').textContent = bundleTasks.length > 1 
        ? `Multi-Task Homework Assignment (${bundleTasks.length} Tasks)` 
        : bundleTasks[0].title;
      document.getElementById('assign-teacher').textContent = `Teacher: ${d.teacherName || 'Teacher'}`;

      if (d.deadline) {
        const dl = new Date(d.deadline);
        const dlBox = document.getElementById('assign-deadline');
        dlBox.style.display = 'block';
        const formattedCairo = formatCairoDateTime(dl);

        if (d.isPastDeadline || Date.now() > dl.getTime()) {
          showAssignmentClosedState('deadline', dl);
          return;
        } else {
          dlBox.textContent = `⏳ Submission Deadline: ${formattedCairo} (Cairo Time)`;
        }
      }

      await checkLocks();
      renderTasksUI();
    } catch (err) {
      document.getElementById('assign-title').textContent = 'Error connecting to server';
    }
  }

  async function checkLocks() {
    for (const t of bundleTasks) {
      if (!taskFilesMap[t.code]) taskFilesMap[t.code] = [];
      try {
        const r = await fetch(`/api/public/assignment/${encodeURIComponent(t.code)}/status?deviceId=${encodeURIComponent(clientDeviceId)}`);
        const st = await r.json();
        taskLockMap[t.code] = !!(st && st.hasSubmitted);
      } catch (e) {
        taskLockMap[t.code] = false;
      }
    }
  }

  async function recheckLocks() {
    const btn = document.getElementById('btn-recheck-status');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span>🔄</span> Checking server status...';
    }
    await checkLocks();
    const allDone = bundleTasks.every(t => taskLockMap[t.code]);
    if (!allDone) {
      document.getElementById('locked-screen').style.display = 'none';
      document.getElementById('submission-form-card').style.display = 'block';
      renderTasksUI();
    } else {
      alert("The server still confirms an existing submission for this assignment on this device. If you haven't submitted yet or need a re-submission, please ask your teacher to reset your attempt.");
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<span>🔄</span> This isn\'t right / I haven\'t submitted yet';
      }
    }
  }

  function renderTasksUI() {
    const container = document.getElementById('tasks-container');
    const allDone = bundleTasks.every(t => taskLockMap[t.code]);

    if (allDone && bundleTasks.length > 0) {
      document.getElementById('submission-form-card').style.display = 'none';
      document.getElementById('locked-screen').style.display = 'block';
      return;
    }

    container.innerHTML = bundleTasks.map((t, idx) => {
      const isDone = taskLockMap[t.code];
      const taskTitle = t.title || `Task ${idx + 1}`;
      return `
        <div class="task-card" id="task-card-${t.code}">
          <div class="task-title">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span>${idx + 1}. ${escapeHtml(taskTitle)}</span>
              ${!isDone ? `<span class="required-badge" id="badge-required-${t.code}">Required</span>` : ''}
            </div>
            <div id="status-wrap-${t.code}">
              ${isDone ? '<span class="task-status-pill status-done">✓ Completed</span>' : `<span class="task-status-pill status-waiting" id="status-pill-${t.code}" style="display:none;">Waiting</span>`}
            </div>
          </div>

          ${isDone ? `
            <div style="padding: 10px; background: #ECFDF5; border: 1px solid #A7F3D0; border-radius: 6px; font-size: 13px; color: #065F46;">
              Your work for this task has already been recorded.
            </div>
          ` : `
            <div class="dropzone" id="dz-${t.code}" tabindex="0" onclick="document.getElementById('file-input-${t.code}').click()" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();document.getElementById('file-input-${t.code}').click();}">
              <div style="font-size: 24px; margin-bottom: 4px;">📷</div>
              <b>Tap to take photo or select pages for this task</b>
              <div style="font-size: 11.5px; color: var(--ink-soft); margin-top: 2px;">Supports camera photos, PNG, JPG, or PDF (up to 20 pages)</div>
            </div>
            <input type="file" id="file-input-${t.code}" accept="image/*,.pdf" multiple style="display: none;" onchange="handleTaskFiles('${t.code}', event)" />
            <div id="preview-${t.code}" class="page-preview"></div>
          `}
        </div>
      `;
    }).join('');

    // Re-render previews for any pending tasks that have attached files
    bundleTasks.forEach(t => {
      if (!taskLockMap[t.code]) {
        renderPreviews(t.code);
      }
    });
  }

  async function compressImageFile(file, maxDimension = 2048, quality = 0.82) {
    if (!file || !file.type || !file.type.startsWith('image/')) {
      return file;
    }

    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onerror = () => resolve(file);
      reader.onload = (e) => {
        const img = new Image();
        img.onerror = () => resolve(file);
        img.onload = () => {
          try {
            let width = img.naturalWidth || img.width;
            let height = img.naturalHeight || img.height;

            if (!width || !height) {
              return resolve(file);
            }

            // Guard against iOS Safari canvas memory limit (~16 million pixels)
            const MAX_PIXELS = 16000000;
            const currentPixels = width * height;
            let safeMaxDim = maxDimension;
            if (currentPixels > MAX_PIXELS) {
              const downscaleRatio = Math.sqrt(MAX_PIXELS / currentPixels);
              safeMaxDim = Math.min(safeMaxDim, Math.floor(Math.max(width, height) * downscaleRatio));
            }

            // Scale to fit safeMaxDim
            const scale = Math.min(1, safeMaxDim / Math.max(width, height));
            let targetWidth = Math.round(width * scale);
            let targetHeight = Math.round(height * scale);

            // Re-verify pixel area
            if (targetWidth * targetHeight > MAX_PIXELS) {
              const finalRatio = Math.sqrt(MAX_PIXELS / (targetWidth * targetHeight));
              targetWidth = Math.floor(targetWidth * finalRatio);
              targetHeight = Math.floor(targetHeight * finalRatio);
            }

            const canvas = document.createElement('canvas');
            canvas.width = targetWidth;
            canvas.height = targetHeight;
            const ctx = canvas.getContext('2d');
            if (!ctx) return resolve(file);

            ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

            canvas.toBlob(
              (blob) => {
                if (!blob) {
                  console.warn('Canvas toBlob returned null. Using original file.');
                  return resolve(file);
                }

                // Output validation: check if suspiciously small (< 5KB while original > 20KB)
                if (blob.size < 5120 && file.size > 20480) {
                  console.warn(`Compressed blob is suspiciously small (${blob.size} bytes vs ${file.size} bytes). Likely canvas corruption. Falling back to original file.`);
                  return resolve(file);
                }

                // If compression did not reduce size, keep original
                if (blob.size >= file.size) {
                  return resolve(file);
                }

                const extMatch = file.name.match(/\.[^.]+$/);
                const baseName = extMatch ? file.name.slice(0, extMatch.index) : file.name;
                const compressedFile = new File([blob], `${baseName}.jpg`, {
                  type: 'image/jpeg',
                  lastModified: Date.now()
                });
                resolve(compressedFile);
              },
              'image/jpeg',
              quality
            );
          } catch (err) {
            console.warn('Error during image compression, using original:', err);
            resolve(file);
          }
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function setTaskStatus(taskCode, status, label) {
    const wrap = document.getElementById(`status-wrap-${taskCode}`);
    if (!wrap) return;
    wrap.innerHTML = `<span class="task-status-pill status-${status}">${escapeHtml(label)}</span>`;
  }

  function validateTasksAndSummary(shouldScrollAndFocus = true) {
    const nameInput = document.getElementById('student-name');
    const name = (nameInput?.value || '').trim();
    const errors = [];

    if (!name) {
      errors.push({
        type: 'name',
        message: 'Your Full Name — please enter your full name',
        el: nameInput
      });
      if (shouldScrollAndFocus && nameInput) nameInput.classList.add('input-error');
    } else {
      nameInput?.classList.remove('input-error');
    }

    const pending = bundleTasks.filter(t => !taskLockMap[t.code]);
    for (let i = 0; i < pending.length; i++) {
      const t = pending[i];
      const items = taskFilesMap[t.code] || [];
      const taskCard = document.getElementById(`task-card-${t.code}`);
      const taskTitle = t.title || `Task ${i + 1}`;

      if (!items.length) {
        errors.push({
          type: 'empty',
          code: t.code,
          message: `${taskTitle} — attach at least one page or photo`,
          el: taskCard
        });
        if (shouldScrollAndFocus && taskCard) taskCard.classList.add('task-card-error');
      } else if (items.some(it => it.isCompressing)) {
        errors.push({
          type: 'compressing',
          code: t.code,
          message: `${taskTitle} — photos are still compressing, please wait`,
          el: taskCard
        });
        if (shouldScrollAndFocus && taskCard) taskCard.classList.add('task-card-error');
      } else if (items.some(it => it.hasError)) {
        errors.push({
          type: 'error',
          code: t.code,
          message: `${taskTitle} — an image failed to process, please remove and re-attach`,
          el: taskCard
        });
        if (shouldScrollAndFocus && taskCard) taskCard.classList.add('task-card-error');
      } else {
        if (taskCard) taskCard.classList.remove('task-card-error');
      }
    }

    const summaryBox = document.getElementById('submission-error-summary');
    const summaryList = document.getElementById('submission-error-list');

    if (errors.length > 0) {
      if (summaryList) {
        summaryList.innerHTML = errors.map(err => `<li>${escapeHtml(err.message)}</li>`).join('');
      }
      if (summaryBox && (shouldScrollAndFocus || summaryBox.style.display === 'block')) {
        summaryBox.style.display = 'block';
      }
      if (shouldScrollAndFocus) {
        const first = errors[0];
        if (first && first.el) {
          first.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          if (first.type === 'name') {
            first.el.focus();
          } else {
            const dz = first.el.querySelector('.dropzone');
            if (dz) dz.focus();
          }
        }
      }
      return false;
    } else {
      if (summaryBox) summaryBox.style.display = 'none';
      return true;
    }
  }

  function clearTaskError(taskCode) {
    const card = document.getElementById(`task-card-${taskCode}`);
    if (card) card.classList.remove('task-card-error');
    // If the error summary box is currently open, dynamically refresh it
    const summaryBox = document.getElementById('submission-error-summary');
    if (summaryBox && summaryBox.style.display === 'block') {
      validateTasksAndSummary(false);
    }
  }

  function updateSubmitButtonState() {
    const btn = document.getElementById('submit-btn');
    if (!btn) return;
    if (activeCompressions > 0) {
      btn.disabled = true;
      btn.textContent = `⏳ Optimizing photos (${activeCompressions} compressing)...`;
    } else {
      btn.disabled = false;
      const pending = bundleTasks.filter(t => !taskLockMap[t.code]);
      const anyDone = bundleTasks.some(t => taskLockMap[t.code]);
      if (anyDone && pending.length > 0) {
        btn.textContent = '🔄 Retry Uploading Remaining Tasks';
      } else {
        btn.textContent = '🚀 Submit All Tasks to Teacher';
      }
    }
  }

  async function handleTaskFiles(taskCode, e) {
    if (!taskFilesMap[taskCode]) taskFilesMap[taskCode] = [];
    const files = Array.from(e.target.files || []);
    e.target.value = '';

    const newEntries = [];
    for (const f of files) {
      if (taskFilesMap[taskCode].length + newEntries.length >= 20) break;
      newEntries.push({
        file: f,
        name: f.name,
        size: f.size,
        isCompressing: f.type && f.type.startsWith('image/'),
        hasError: false
      });
    }

    for (const entry of newEntries) {
      taskFilesMap[taskCode].push(entry);
    }
    clearTaskError(taskCode);
    renderPreviews(taskCode);
    updateSubmitButtonState();

    // Compress each newly added image file
    for (const item of newEntries) {
      if (item.isCompressing) {
        activeCompressions++;
        updateSubmitButtonState();
        try {
          const compressed = await compressImageFile(item.file);
          item.file = compressed;
          item.name = compressed.name;
          item.size = compressed.size;
        } catch (err) {
          console.warn('Image compression fallback:', err);
        } finally {
          item.isCompressing = false;
          activeCompressions--;
          renderPreviews(taskCode);
          updateSubmitButtonState();
          validateTasksAndSummary(false);
        }
      }
    }
  }

  function renderPreviews(taskCode) {
    const el = document.getElementById(`preview-${taskCode}`);
    if (!el) return;
    const items = taskFilesMap[taskCode] || [];
    el.innerHTML = items.map((item, i) => {
      let sizeStr = '';
      if (item.isCompressing) {
        sizeStr = '<span style="color:#D97706; font-weight:600;">(Compressing...) ⏳</span>';
      } else if (item.hasError) {
        sizeStr = '<span style="color:#DC2626; font-weight:600;">(Error processing image) ⚠️</span>';
      } else {
        sizeStr = `(${item.size < 1048576 ? (item.size / 1024).toFixed(1) + ' KB' : (item.size / 1048576).toFixed(2) + ' MB'})`;
      }
      return `
        <div class="page-chip ${item.hasError ? 'page-chip-error' : ''}">
          <span>📄 Page ${i + 1}: ${escapeHtml(item.name)} ${sizeStr}</span>
          <button type="button" class="page-remove" onclick="removeTaskFile('${taskCode}', ${i})">&times;</button>
        </div>
      `;
    }).join('');
  }

  function removeTaskFile(taskCode, i) {
    taskFilesMap[taskCode].splice(i, 1);
    renderPreviews(taskCode);
    updateSubmitButtonState();
    validateTasksAndSummary(false);
  }

  // Live clear error on student name typing
  document.addEventListener('DOMContentLoaded', () => {
    const nameInp = document.getElementById('student-name');
    if (nameInp) {
      nameInp.addEventListener('input', () => {
        if (nameInp.value.trim()) {
          nameInp.classList.remove('input-error');
          const summaryBox = document.getElementById('submission-error-summary');
          if (summaryBox && summaryBox.style.display === 'block') {
            validateTasksAndSummary(false);
          }
        }
      });
    }
  });

  async function handleStudentSubmit(e) {
    e.preventDefault();

    // Hide any previous partial failure banner
    const partialBox = document.getElementById('partial-failure-box');
    if (partialBox) partialBox.style.display = 'none';

    // Validate ALL pending tasks at once
    const isValid = validateTasksAndSummary(true);
    if (!isValid) {
      return; // Blocked: summary box populated, first field focused
    }

    if (activeCompressions > 0) {
      const summaryBox = document.getElementById('submission-error-summary');
      const summaryList = document.getElementById('submission-error-list');
      if (summaryList && summaryBox) {
        summaryList.innerHTML = '<li>Please wait until all photos finish compressing before submitting.</li>';
        summaryBox.style.display = 'block';
        summaryBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }

    const nameInput = document.getElementById('student-name');
    const name = nameInput.value.trim();
    const btn = document.getElementById('submit-btn');

    const pending = bundleTasks.filter(t => !taskLockMap[t.code]);
    if (!pending.length) {
      renderTasksUI();
      return;
    }

    btn.disabled = true;
    document.querySelectorAll('.dropzone').forEach(d => d.classList.add('disabled'));

    // Initialize waiting status for all pending tasks
    for (const t of pending) {
      setTaskStatus(t.code, 'waiting', 'Waiting in queue...');
    }

    const succeededTasks = [];
    let failedTaskInfo = null;

    for (let i = 0; i < pending.length; i++) {
      const t = pending[i];
      setTaskStatus(t.code, 'uploading', 'Uploading & grading work... ⏳');
      btn.textContent = `Uploading task ${i + 1} of ${pending.length} (${t.title || 'Task'})...`;

      try {
        const formData = new FormData();
        formData.append('studentName', name);
        formData.append('deviceId', clientDeviceId);
        for (const item of (taskFilesMap[t.code] || [])) {
          formData.append('pages', item.file);
        }

        const res = await fetch(`/api/public/submit/${encodeURIComponent(t.code)}`, {
          method: 'POST',
          body: formData
        });

        if (res.status === 413) {
          throw new Error('The uploaded files exceed the server size limit. Please upload fewer or smaller pages.');
        }

        const d = await res.json().catch(() => ({}));
        if (!res.ok || !d.success) {
          throw new Error(d.error || `Server responded with error status ${res.status}`);
        }

        taskLockMap[t.code] = true;
        succeededTasks.push(t);
        setTaskStatus(t.code, 'done', '✓ Received & Saved');
      } catch (err) {
        setTaskStatus(t.code, 'failed', '❌ Upload failed');
        let friendlyMsg = 'Submission error. Please check your connection and retry.';
        if (err.name === 'AbortError' || (err.message && err.message.toLowerCase().includes('timeout'))) {
          friendlyMsg = 'Request timed out while uploading your submission.';
        } else if (err.message === 'Failed to fetch' || (err.message && err.message.includes('NetworkError'))) {
          friendlyMsg = 'Unable to reach the examination server.';
        } else if (err.message) {
          friendlyMsg = err.message;
        }
        failedTaskInfo = { task: t, error: friendlyMsg };
        break; // stop upload loop on first failure
      }
    }

    if (failedTaskInfo) {
      // Re-enable remaining dropzones
      document.querySelectorAll('.dropzone').forEach(d => d.classList.remove('disabled'));
      btn.disabled = false;
      btn.textContent = '🔄 Retry Uploading Remaining Tasks';

      // Re-render completed tasks as done
      renderTasksUI();

      // Ensure previews are still visible for the failed and remaining tasks
      bundleTasks.forEach(t => {
        if (!taskLockMap[t.code]) {
          renderPreviews(t.code);
        }
      });

      // Construct partial failure message:
      // "Tasks 1 and 2 were received. Task 3 failed. Tap Retry. Do not close this page."
      let failureMsg = '';
      if (succeededTasks.length > 0) {
        const sTitles = succeededTasks.map(t => t.title).join(' and ');
        const sVerb = succeededTasks.length === 1 ? 'was' : 'were';
        failureMsg = `${sTitles} ${sVerb} received. ${failedTaskInfo.task.title} failed. Tap Retry. Do not close this page.`;
      } else {
        failureMsg = `${failedTaskInfo.task.title} failed. Tap Retry. Do not close this page.`;
      }

      const partialBox = document.getElementById('partial-failure-box');
      const partialMsgEl = document.getElementById('partial-failure-msg');
      if (partialBox && partialMsgEl) {
        partialMsgEl.textContent = failureMsg;
        partialBox.style.display = 'block';
        partialBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }

      // CRITICAL: make sure a failed or timed-out task NEVER leaves the page looking like a full success
      return;
    }

    // Full success: All tasks completed successfully!
    document.getElementById('submission-form-card').style.display = 'none';
    document.getElementById('submitted-name').textContent = name;
    document.getElementById('success-screen').style.display = 'block';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
