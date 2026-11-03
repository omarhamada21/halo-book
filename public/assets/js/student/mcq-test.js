  const urlParams = new URLSearchParams(window.location.search);
  const testCode = urlParams.get('code') || '';

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

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatCairoDateTime(dateObj) {
    return dateObj.toLocaleString('en-US', {
      timeZone: 'Africa/Cairo',
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true
    });
  }

  let mcqQuestions = [];
  let testData = null;
  let playCount = 0;
  let maxPlaysLimit = 0;

  function showMcqClosedScreen(type, options = {}) {
    const formCard = document.getElementById('mcq-form-card');
    const audioBox = document.getElementById('mcq-audio-box');
    const lockedCard = document.getElementById('mcq-locked-screen');
    const successCard = document.getElementById('mcq-success-screen');
    const dlBox = document.getElementById('deadline-box');

    if (formCard) formCard.style.display = 'none';
    if (audioBox) audioBox.style.display = 'none';
    if (lockedCard) lockedCard.style.display = 'none';
    if (successCard) successCard.style.display = 'none';

    if (dlBox) {
      dlBox.style.display = 'block';
      dlBox.className = 'deadline-box deadline-expired';
      if (type === 'deadline') {
        const formattedDate = options.deadline ? formatCairoDateTime(new Date(options.deadline)) : 'the scheduled cutoff';
        document.getElementById('test-title').textContent = 'Submissions Closed';
        document.getElementById('test-teacher').textContent = '';
        dlBox.innerHTML = `⛔ <b>Submissions Closed:</b> This test's submission window has closed. The deadline was ${formattedDate} (Cairo Time). Contact your teacher if you believe this is a mistake.`;
      } else {
        document.getElementById('test-title').textContent = 'Invalid Assessment Link';
        document.getElementById('test-teacher').textContent = '';
        dlBox.innerHTML = `This test link appears to be invalid or has been removed. Please check the link with your teacher.`;
      }
    }
  }

  if (!testCode) {
    showMcqClosedScreen('invalid');
  } else {
    initMcqPage();
  }

  async function initMcqPage() {
    try {
      // 1. Fetch test details
      const res = await fetch(`/api/public/mcq/${encodeURIComponent(testCode)}`);
      const d = await res.json().catch(() => ({}));

      if (!res.ok || !d.success || !d.test) {
        if (res.status === 403 || d.error === 'deadline_passed') {
          showMcqClosedScreen('deadline', { deadline: d.deadline });
          return;
        }
        showMcqClosedScreen('invalid');
        return;
      }

      testData = d.test;
      mcqQuestions = d.questions || [];
      maxPlaysLimit = testData.max_plays || 0;

      document.getElementById('test-title').textContent = testData.title;
      document.getElementById('test-teacher').textContent = `Teacher: ${testData.teacher_name || 'Teacher'}`;

      // Deadline Display
      if (testData.deadline) {
        const dl = new Date(testData.deadline);
        const dlBox = document.getElementById('deadline-box');

        if (testData.isPastDeadline || Date.now() > dl.getTime()) {
          showMcqClosedScreen('deadline', { deadline: testData.deadline });
          return;
        } else {
          dlBox.style.display = 'block';
          dlBox.className = 'deadline-box';
          dlBox.textContent = `⏳ Submission Deadline: ${formatCairoDateTime(dl)} (Cairo Time)`;
        }
      }

      // Check device submission status
      const statusRes = await fetch(`/api/public/mcq/${encodeURIComponent(testCode)}/status?deviceId=${encodeURIComponent(clientDeviceId)}`);
      const statusData = await statusRes.json();
      if (statusData && statusData.hasSubmitted) {
        document.getElementById('mcq-locked-screen').style.display = 'block';
        return;
      }

      // Audio setup
      if (d.audioUrl) {
        setupAudioPlayer(d.audioUrl);
      }

      // Render questions
      renderStudentQuestions();
      document.getElementById('mcq-form-card').style.display = 'block';
    } catch (err) {
      console.error('Failed to load assessment:', err);
      document.getElementById('test-title').textContent = 'Error connecting to server';
    }
  }

  let audioToastTimeout = null;
  function showAudioToast(msg) {
    let toast = document.getElementById('audio-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'audio-toast';
      toast.className = 'audio-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.display = 'block';
    if (audioToastTimeout) clearTimeout(audioToastTimeout);
    audioToastTimeout = setTimeout(() => {
      toast.style.display = 'none';
    }, 2500);
  }

  function setupAudioPlayer(audioUrl) {
    const audioBox = document.getElementById('mcq-audio-box');
    const audioPlayer = document.getElementById('mcq-audio-player');
    const btnStart = document.getElementById('btn-start-audio');
    const noticeEl = document.getElementById('audio-plays-notice');
    const lockedMsg = document.getElementById('audio-locked-msg');
    const progressWrap = document.getElementById('audio-progress-bar-wrap');
    const progressBar = document.getElementById('audio-progress-bar');
    const timeDisplay = document.getElementById('audio-time-display');

    audioPlayer.src = audioUrl;
    audioBox.style.display = 'block';

    // Security: Prevent context menu on audio container
    audioBox.addEventListener('contextmenu', (e) => e.preventDefault());

    // 1. Check persistent Audio Play State in localStorage (Anti-Cheat)
    const storageKey = 'mcq_audio_state_' + testCode;
    let audioState = { playCount: 0, hasStarted: false, isLocked: false };
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) audioState = JSON.parse(raw);
    } catch (_) {}

    if (maxPlaysLimit > 0) {
      // If student refreshed/reloaded page mid-playback, penalize attempt immediately
      if (audioState.hasStarted) {
        audioState.playCount = (audioState.playCount || 0) + 1;
        audioState.hasStarted = false;
        if (audioState.playCount >= maxPlaysLimit) {
          audioState.isLocked = true;
        }
        try {
          localStorage.setItem(storageKey, JSON.stringify(audioState));
        } catch (_) {}
      }

      playCount = audioState.playCount || 0;

      if (playCount >= maxPlaysLimit || audioState.isLocked) {
        btnStart.disabled = true;
        btnStart.textContent = '🔒 Audio limit reached (' + maxPlaysLimit + '/' + maxPlaysLimit + ' plays used)';
        if (noticeEl) {
          noticeEl.style.display = 'inline-block';
          noticeEl.className = 'plays-badge plays-locked';
          noticeEl.textContent = `Plays: ${maxPlaysLimit} of ${maxPlaysLimit} (Locked)`;
        }
        if (lockedMsg) {
          lockedMsg.style.display = 'block';
          lockedMsg.textContent = 'Maximum plays reached. Playback is locked.';
        }
        return;
      }

      noticeEl.style.display = 'inline-block';
      noticeEl.textContent = `Plays: ${playCount} of ${maxPlaysLimit}`;

      if (btnStart) {
        btnStart.disabled = false;
        if (playCount > 0) {
          btnStart.innerHTML = `▶ Play Audio Exam Track (Play ${playCount + 1} of ${maxPlaysLimit})`;
        } else {
          btnStart.innerHTML = '▶ Play Audio Exam Track';
        }
      }
    } else {
      if (btnStart) {
        btnStart.disabled = false;
        btnStart.innerHTML = '▶ Play Audio Exam Track';
      }
    }

    // Enforce Continuous Playback (Disable Pausing)
    audioPlayer.addEventListener('pause', () => {
      if (!audioPlayer.ended && audioPlayer.currentTime > 0) {
        audioPlayer.play().catch(() => {});
        showAudioToast('⚠️ Exam audio cannot be paused once started.');
      }
    });

    audioPlayer.addEventListener('timeupdate', () => {
      if (audioPlayer.duration && progressWrap && progressBar && timeDisplay) {
        progressWrap.style.display = 'block';
        timeDisplay.style.display = 'block';
        const pct = (audioPlayer.currentTime / audioPlayer.duration) * 100;
        progressBar.style.width = `${pct}%`;
        const curMin = Math.floor(audioPlayer.currentTime / 60);
        const curSec = Math.floor(audioPlayer.currentTime % 60);
        const durMin = Math.floor(audioPlayer.duration / 60);
        const durSec = Math.floor(audioPlayer.duration % 60);
        timeDisplay.textContent = `${curMin}:${curSec < 10 ? '0' : ''}${curSec} / ${durMin}:${durSec < 10 ? '0' : ''}${durSec}`;
      }
    });

    audioPlayer.addEventListener('ended', () => {
      playCount += 1;
      if (progressWrap) progressWrap.style.display = 'none';
      if (timeDisplay) timeDisplay.style.display = 'none';

      if (maxPlaysLimit > 0) {
        const isLocked = playCount >= maxPlaysLimit;
        const s = {
          playCount: playCount,
          hasStarted: false,
          isLocked: isLocked
        };
        try {
          localStorage.setItem(storageKey, JSON.stringify(s));
        } catch (_) {}

        if (isLocked) {
          if (btnStart) {
            btnStart.disabled = true;
            btnStart.textContent = '🔒 Audio limit reached (' + maxPlaysLimit + '/' + maxPlaysLimit + ' plays used)';
          }
          noticeEl.className = 'plays-badge plays-locked';
          noticeEl.textContent = `Plays: ${maxPlaysLimit} of ${maxPlaysLimit} (Locked)`;
          lockedMsg.style.display = 'block';
          lockedMsg.textContent = 'Maximum plays reached. Playback is locked.';
          return;
        } else {
          if (btnStart) {
            btnStart.disabled = false;
            btnStart.innerHTML = `▶ Play Audio Exam Track (Play ${playCount + 1} of ${maxPlaysLimit})`;
          }
          noticeEl.textContent = `Plays: ${playCount} of ${maxPlaysLimit}`;
        }
      } else {
        if (btnStart) {
          btnStart.disabled = false;
          btnStart.innerHTML = '▶ Play Audio Exam Track Again';
        }
      }
    });

    // Auto-refresh signed URL if error/expired occurs during listening
    audioPlayer.addEventListener('error', async () => {
      if (maxPlaysLimit > 0 && playCount >= maxPlaysLimit) return;
      try {
        const refRes = await fetch(`/api/public/mcq/${encodeURIComponent(testCode)}/audio-refresh`);
        const refData = await refRes.json();
        if (refData.success && refData.audioUrl) {
          const curTime = audioPlayer.currentTime || 0;
          audioPlayer.src = refData.audioUrl;
          audioPlayer.currentTime = curTime;
          audioPlayer.play().catch(() => {});
        }
      } catch (e) {
        console.warn('Audio refresh failed:', e);
      }
    });
  }

  function startAudioTrack() {
    const audioPlayer = document.getElementById('mcq-audio-player');
    const btnStart = document.getElementById('btn-start-audio');
    if (!audioPlayer) return;

    if (maxPlaysLimit > 0 && playCount >= maxPlaysLimit) {
      alert('Maximum audio plays reached.');
      return;
    }

    const storageKey = 'mcq_audio_state_' + testCode;
    if (maxPlaysLimit > 0) {
      try {
        let s = { playCount: playCount, hasStarted: true, isLocked: false };
        const raw = localStorage.getItem(storageKey);
        if (raw) s = { ...s, ...JSON.parse(raw) };
        s.hasStarted = true;
        s.playCount = playCount;
        localStorage.setItem(storageKey, JSON.stringify(s));
      } catch (_) {}
    }

    audioPlayer.play().then(() => {
      if (btnStart) {
        btnStart.disabled = true;
        btnStart.innerHTML = '🎧 Audio Playing... (Do not close or reload)';
      }
    }).catch((err) => {
      console.error('Audio play error:', err);
      if (maxPlaysLimit > 0) {
        try {
          let s = JSON.parse(localStorage.getItem(storageKey) || '{}');
          s.hasStarted = false;
          localStorage.setItem(storageKey, JSON.stringify(s));
        } catch (_) {}
      }
      alert('Could not start audio playback. Please check your browser audio permissions.');
    });
  }

  const optionLetters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];

  function renderStudentQuestions() {
    const container = document.getElementById('mcq-questions-container');
    if (!container) return;

    if (mcqQuestions.length === 0) {
      container.innerHTML = '<p style="color: var(--ink-soft); text-align: center; padding: 20px;">No questions in this test.</p>';
      return;
    }

    container.innerHTML = mcqQuestions.map((q, idx) => {
      const qType = q.question_type || 'mcq';
      const opts = Array.isArray(q.options) ? q.options : [];

      let badgeHtml = '';
      if (qType === 'fill_blank') {
        badgeHtml = '<span class="tag" style="margin: 0; font-size: 10px; color: var(--pen); background: var(--pen-soft); padding: 2px 7px; border-radius: 4px;">✏️ Fill in the Blank</span>';
      } else if (qType === 'matching') {
        badgeHtml = '<span class="tag" style="margin: 0; font-size: 10px; color: #5B21B6; background: #EDE9FE; padding: 2px 7px; border-radius: 4px;">🔀 Matching</span>';
      }

      let contentHtml = '';
      if (qType === 'fill_blank') {
        contentHtml = `
          <div style="margin-top: 10px;">
            <input type="text" class="fill-blank-input" id="q-input-${q.id}" name="question_${q.id}"
              placeholder="Type answer here..." autocomplete="off"
              style="width: 100%; padding: 12px 14px; font-size: 14px; border: 1px solid var(--border); border-radius: 8px; outline: none; font-family: 'Inter', sans-serif;" />
          </div>
        `;
      } else if (qType === 'matching') {
        contentHtml = `
          <div style="margin-top: 10px;">
            <select name="question_${q.id}" id="q-select-${q.id}" class="matching-select"
              style="width: 100%; padding: 12px 14px; font-size: 14px; border: 1px solid var(--border); border-radius: 8px; outline: none; background: #fff; font-family: 'Inter', sans-serif; cursor: pointer;">
              <option value="">-- Choose matching statement --</option>
              ${opts.map((opt, i) => {
                const letter = optionLetters[i] || String(i + 1);
                const textVal = typeof opt === 'string' ? opt : (opt?.text || opt?.statement || opt?.value || opt?.caption || '');
                return `<option value="${i}">${letter}. ${escapeHtml(textVal)}</option>`;
              }).join('')}
            </select>
          </div>
        `;
      } else {
        // 'mcq'
        let displayOpts = Array.isArray(opts) ? opts : [];
        const hasAnyImageUrl = displayOpts.some(o => typeof o === 'object' && o !== null && Boolean(o.image_url || o.imageUrl));
        const isVisual = hasAnyImageUrl;
        if (isVisual) {
          contentHtml = `
            <div class="mcq-visual-options-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin-top: 12px;">
              ${displayOpts.map((opt, optIdx) => {
                const rawL = (opt && opt.label) ? String(opt.label).trim().toUpperCase() : (optionLetters[optIdx] || String(optIdx + 1));
                const letter = rawL === 'S' ? 'C' : rawL;
                const imgUrl = (opt && (opt.image_url || opt.imageUrl)) ? (opt.image_url || opt.imageUrl) : '';
                const caption = (opt && (opt.caption || opt.value || opt.text)) ? (opt.caption || opt.value || opt.text) : (typeof opt === 'string' ? opt : '');
                return `
                  <div class="opt-choice mcq-visual-choice-card" id="opt-choice-${q.id}-${optIdx}" onclick="selectStudentOption(${q.id}, ${optIdx})"
                    style="border: 2px solid var(--border); border-radius: 10px; padding: 12px; background: #fff; cursor: pointer; transition: all 0.2s ease; display: flex; flex-direction: column;">
                    ${imgUrl ? `
                      <div style="min-height: 110px; display: flex; align-items: center; justify-content: center; background: #fafafa; border-radius: 6px; margin-bottom: 8px; border: 1px solid var(--border);">
                        <img src="${escapeHtml(imgUrl)}" alt="Picture ${letter}" style="max-height: 120px; max-width: 100%; object-fit: contain;" />
                      </div>
                    ` : ''}
                    <div style="display: flex; align-items: center; gap: 8px; margin-top: 4px;">
                      <input type="radio" name="question_${q.id}" id="opt-radio-${q.id}-${optIdx}" value="${optIdx}" class="opt-radio"
                        onclick="event.stopPropagation(); selectStudentOption(${q.id}, ${optIdx});" />
                      <span style="font-weight: 700; font-size: 13px; color: var(--pen);">${imgUrl ? `Picture ${letter}` : `${letter}.`}</span>
                    </div>
                    ${caption ? `<div style="font-size: 12px; color: var(--ink-soft); margin-top: 4px;">${escapeHtml(caption)}</div>` : ''}
                  </div>
                `;
              }).join('')}
            </div>
          `;
        } else {
          contentHtml = `
            <div class="options-list">
              ${displayOpts.map((optText, optIdx) => {
                const letter = optionLetters[optIdx] || String(optIdx + 1);
                const rawVal = typeof optText === 'object' && optText !== null ? (optText.value || optText.caption || optText.text || optText.statement || '') : String(optText || '');
                const cleanVal = String(rawVal || '').replace(/^[A-E][.:]\s*/i, '').trim();
                return `
                  <div class="opt-choice" id="opt-choice-${q.id}-${optIdx}" onclick="selectStudentOption(${q.id}, ${optIdx})">
                    <input type="radio" name="question_${q.id}" id="opt-radio-${q.id}-${optIdx}" value="${optIdx}" class="opt-radio"
                      onclick="event.stopPropagation(); selectStudentOption(${q.id}, ${optIdx});" />
                    <span class="opt-letter">${letter}.</span>
                    <span class="opt-text">${escapeHtml(cleanVal)}</span>
                  </div>
                `;
              }).join('')}
            </div>
          `;
        }
      }

      return `
        <div class="q-card" id="q-card-${q.id}">
          <div class="q-header">
            <span class="q-number">Question ${idx + 1} of ${mcqQuestions.length}</span>
            ${badgeHtml}
          </div>
          <div class="q-prompt">${escapeHtml(q.question_text || '')}</div>
          ${contentHtml}
        </div>
      `;
    }).join('');
  }

  function selectStudentOption(questionId, optIdx) {
    const radio = document.getElementById(`opt-radio-${questionId}-${optIdx}`);
    if (radio) radio.checked = true;

    // Highlight selected row
    const q = mcqQuestions.find(item => item.id === questionId);
    const count = q && Array.isArray(q.options) ? q.options.length : 4;

    for (let i = 0; i < count; i++) {
      const row = document.getElementById(`opt-choice-${questionId}-${i}`);
      if (row) {
        if (i === optIdx) row.classList.add('selected');
        else row.classList.remove('selected');
      }
    }
  }

  async function handleAssessmentSubmit(e) {
    e.preventDefault();

    const nameInput = document.getElementById('student-name');
    const studentName = (nameInput?.value || '').trim();
    if (!studentName) {
      alert('Please enter your full name before submitting.');
      nameInput?.focus();
      return;
    }

    // Collect answers across mcq, matching, and fill_blank
    const answers = {};
    const unansweredNumbers = [];

    for (let idx = 0; idx < mcqQuestions.length; idx++) {
      const q = mcqQuestions[idx];
      const qType = q.question_type || 'mcq';
      let isAnswered = false;

      if (qType === 'fill_blank') {
        const inp = document.getElementById(`q-input-${q.id}`) || document.querySelector(`input[name="question_${q.id}"]`);
        const val = (inp?.value || '').trim();
        if (val) {
          answers[q.id] = val;
          isAnswered = true;
        }
      } else if (qType === 'matching') {
        const sel = document.getElementById(`q-select-${q.id}`) || document.querySelector(`select[name="question_${q.id}"]`);
        const val = sel?.value;
        if (val !== '' && val !== undefined && val !== null) {
          answers[q.id] = parseInt(val, 10);
          isAnswered = true;
        }
      } else {
        // 'mcq'
        const radios = document.getElementsByName(`question_${q.id}`);
        let chosen = -1;
        for (let r = 0; r < radios.length; r++) {
          if (radios[r].checked) {
            chosen = parseInt(radios[r].value, 10);
            break;
          }
        }
        if (chosen !== -1) {
          answers[q.id] = chosen;
          isAnswered = true;
        }
      }

      if (!isAnswered) {
        unansweredNumbers.push(`Question ${idx + 1}`);
      }
    }

    if (unansweredNumbers.length > 0) {
      const confirmed = confirm(`You have left the following question(s) unanswered:\n- ${unansweredNumbers.join('\n- ')}\n\nSubmit anyway?`);
      if (!confirmed) return;
    }

    const submitBtn = document.getElementById('mcq-submit-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = '⏳ Grading and submitting...';

    try {
      const res = await fetch(`/api/public/mcq/${encodeURIComponent(testCode)}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentName,
          deviceId: clientDeviceId,
          answers
        })
      });

      const data = await res.json();

      if (res.status === 409) {
        document.getElementById('mcq-form-card').style.display = 'none';
        document.getElementById('mcq-locked-screen').style.display = 'block';
        return;
      }

      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Submission failed.');
      }

      // Success screen
      document.getElementById('mcq-form-card').style.display = 'none';
      const audioBox = document.getElementById('mcq-audio-box');
      if (audioBox) audioBox.style.display = 'none';

      document.getElementById('submitted-student-name').textContent = studentName;
      document.getElementById('awarded-score-display').textContent = data.score || 'Recorded';
      document.getElementById('mcq-success-screen').style.display = 'block';
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      alert('Submission Error: ' + err.message);
      submitBtn.disabled = false;
      submitBtn.textContent = '🚀 Submit Assessment & View Score';
    }
  }
