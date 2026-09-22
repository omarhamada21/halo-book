// ==========================================
// DASHBOARD.JS - Navigation & Manual Marking
// ==========================================

var schemeFilesList = [];
var studentSubmissions = [];
var targetStudentForAddPage = null;

function switchMode(mode) {
  const btnPortal = document.getElementById('btn-mode-portal');
  const btnManual = document.getElementById('btn-mode-manual');
  const btnMcq = document.getElementById('btn-mode-mcq');
  const secPortal = document.getElementById('portal-section');
  const secManual = document.getElementById('manual-section');
  const secMcq = document.getElementById('mcq-section');

  if (mode === 'portal') {
    if (btnPortal) btnPortal.classList.add('active');
    if (btnManual) btnManual.classList.remove('active');
    if (btnMcq) btnMcq.classList.remove('active');
    if (secPortal) secPortal.style.display = 'block';
    if (secManual) secManual.style.display = 'none';
    if (secMcq) secMcq.style.display = 'none';
  } else if (mode === 'manual') {
    if (btnManual) btnManual.classList.add('active');
    if (btnPortal) btnPortal.classList.remove('active');
    if (btnMcq) btnMcq.classList.remove('active');
    if (secManual) secManual.style.display = 'block';
    if (secPortal) secPortal.style.display = 'none';
    if (secMcq) secMcq.style.display = 'none';
  } else if (mode === 'mcq') {
    if (btnMcq) btnMcq.classList.add('active');
    if (btnPortal) btnPortal.classList.remove('active');
    if (btnManual) btnManual.classList.remove('active');
    if (secMcq) secMcq.style.display = 'block';
    if (secPortal) secPortal.style.display = 'none';
    if (secManual) secManual.style.display = 'none';
  }
}

// ==================== MANUAL BATCH LOGIC ====================
const schemeDz = document.getElementById('scheme-dz');
const schemeFileInput = document.getElementById('scheme-file');
const schemeBadgeGrid = document.getElementById('scheme-badge-grid');
const schemeText = document.getElementById('scheme-text');

const essayDz = document.getElementById('essay-dz');
const essayFileInput = document.getElementById('essay-file');
const pageFileInput = document.getElementById('page-file-input');
const studentList = document.getElementById('student-list');
const studentCount = document.getElementById('student-count');

const markBtn = document.getElementById('mark-btn');
const progressWrap = document.getElementById('progress-wrap');
const progressFill = document.getElementById('progress-fill');
const progressLabel = document.getElementById('progress-label');
const emptyMsg = document.getElementById('empty-msg');
const toolbar = document.getElementById('toolbar');
const printBtn = document.getElementById('print-btn');
const printFeedbackBtn = document.getElementById('print-feedback-btn');

['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
  window.addEventListener(eventName, e => { e.preventDefault(); e.stopPropagation(); }, false);
});
['dragenter', 'dragover'].forEach(eventName => {
  schemeDz.addEventListener(eventName, () => schemeDz.classList.add('drag'), false);
  essayDz.addEventListener(eventName, () => essayDz.classList.add('drag'), false);
});
['dragleave', 'drop'].forEach(eventName => {
  schemeDz.addEventListener(eventName, () => schemeDz.classList.remove('drag'), false);
  essayDz.addEventListener(eventName, () => essayDz.classList.remove('drag'), false);
});

schemeDz.addEventListener('click', () => schemeFileInput.click());
schemeDz.addEventListener('drop', e => {
  const files = e.dataTransfer.files;
  if (files && files.length) addSchemeFiles(files);
});
schemeFileInput.addEventListener('change', e => {
  if (e.target.files && e.target.files.length) addSchemeFiles(e.target.files);
  schemeFileInput.value = '';
});

function addSchemeFiles(fileList) {
  for (const file of fileList) schemeFilesList.push(file);
  renderSchemeBadges();
}

function renderSchemeBadges() {
  schemeBadgeGrid.innerHTML = '';
  schemeFilesList.forEach((f, idx) => {
    const chip = document.createElement('div');
    chip.className = 'file-chip';
    chip.innerHTML = `
      <span>📋 Rubric Page ${idx + 1}: ${f.name}</span>
      <button class="file-chip-remove" onclick="removeSchemeFile(${idx})" title="Remove file">&times;</button>
    `;
    schemeBadgeGrid.appendChild(chip);
  });
}

window.removeSchemeFile = function(idx) {
  schemeFilesList.splice(idx, 1);
  renderSchemeBadges();
};

essayDz.addEventListener('click', () => essayFileInput.click());
essayDz.addEventListener('drop', e => {
  const files = e.dataTransfer.files;
  if (files && files.length) addSubmissions(files);
});
essayFileInput.addEventListener('change', e => {
  if (e.target.files && e.target.files.length) addSubmissions(e.target.files);
  essayFileInput.value = '';
});

pageFileInput.addEventListener('change', e => {
  if (targetStudentForAddPage && e.target.files && e.target.files.length) {
    const student = studentSubmissions.find(s => s.id === targetStudentForAddPage);
    if (student) {
      for (const file of e.target.files) student.pages.push(file);
      renderStudentSubmissions();
    }
  }
  pageFileInput.value = '';
});

window.addEventListener('paste', e => {
  const activeEl = document.activeElement;
  if (activeEl && (activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'INPUT')) return;
  const files = e.clipboardData ? e.clipboardData.files : [];
  if (files && files.length > 0) {
    e.preventDefault();
    addSubmissions(files);
  }
});

function addSubmissions(fileList){
  for (const file of fileList) {
    if (studentSubmissions.length >= 30) break;
    let defaultName = file.name ? file.name.replace(/\.[^/.]+$/, '').replace(/[_-]+/g,' ').replace(/\b\w/g, c=>c.toUpperCase()) : '';
    if (!defaultName || defaultName.toLowerCase() === 'image' || defaultName.toLowerCase() === 'blob') {
      defaultName = `Student ${studentSubmissions.length + 1}`;
    }
    const fileObj = file.name ? file : new File([file], `${defaultName}.png`, { type: file.type || 'image/png' });
    studentSubmissions.push({ 
      id: crypto.randomUUID(), 
      name: defaultName, 
      pages: [fileObj] 
    });
  }
  renderStudentSubmissions();
}

function renderStudentSubmissions(){
  studentList.innerHTML = '';
  studentSubmissions.forEach((sub) => {
    const card = document.createElement('div');
    card.className = 'student-card';

    const badgesHtml = sub.pages.map((p, pIdx) => `
      <div class="page-badge">
        <span>📄 Page ${pIdx + 1}: ${p.name || 'Photo'}</span>
        <button class="page-remove" onclick="removeStudentPage('${sub.id}', ${pIdx})" title="Remove page">&times;</button>
      </div>
    `).join('');

    card.innerHTML = `
      <div class="student-card-head">
        <input class="student-name-input" value="${sub.name}" data-id="${sub.id}" placeholder="Student Name">
        <button class="add-page-btn" onclick="triggerAddPage('${sub.id}')">+ Add Page / Photo</button>
        <button class="student-remove" onclick="removeStudent('${sub.id}')" title="Delete Student">&times;</button>
      </div>
      <div class="page-badges">
        ${badgesHtml}
      </div>
    `;
    studentList.appendChild(card);
  });

  studentList.querySelectorAll('.student-name-input').forEach(inp => {
    inp.addEventListener('input', e => {
      const target = studentSubmissions.find(x => x.id === e.target.dataset.id);
      if (target) target.name = e.target.value;
    });
  });

  const totalPages = studentSubmissions.reduce((acc, curr) => acc + curr.pages.length, 0);
  studentCount.textContent = studentSubmissions.length 
    ? `${studentSubmissions.length} Student Submission(s) loaded (${totalPages} total pages/photos)` 
    : '';
}

window.triggerAddPage = function(studentId) {
  targetStudentForAddPage = studentId;
  pageFileInput.click();
};

window.removeStudentPage = function(studentId, pageIdx) {
  const student = studentSubmissions.find(s => s.id === studentId);
  if (student) {
    student.pages.splice(pageIdx, 1);
    if (student.pages.length === 0) {
      studentSubmissions = studentSubmissions.filter(s => s.id !== studentId);
    }
    renderStudentSubmissions();
  }
};

window.removeStudent = function(studentId) {
  studentSubmissions = studentSubmissions.filter(s => s.id !== studentId);
  renderStudentSubmissions();
};

markBtn.addEventListener('click', async () => {
  const schemeTextVal = schemeText.value.trim();

  if (schemeFilesList.length === 0 && !schemeTextVal) { 
    alert('Please add at least one marking scheme file/photo or enter extra criteria notes.'); 
    return; 
  }
  if (studentSubmissions.length === 0) { 
    alert('Add at least one student submission.'); 
    return; 
  }

  const formData = new FormData();
  schemeFilesList.forEach(file => formData.append('scheme', file));
  if (schemeTextVal) formData.append('schemeText', schemeTextVal);

  const meta = [];
  studentSubmissions.forEach(sub => {
    meta.push({ name: sub.name, fileCount: sub.pages.length });
    sub.pages.forEach(p => formData.append('essays', p));
  });

  formData.append('submissionsMetadata', JSON.stringify(meta));

  markBtn.disabled = true;
  progressWrap.style.display = 'block';
  progressFill.style.width = '30%';
  progressLabel.textContent = 'Uploading rubric and student submissions...';
  document.getElementById('results').innerHTML = '';
  emptyMsg.style.display = 'none';
  toolbar.style.display = 'none';

  try {
    progressFill.style.width = '60%';
    progressLabel.textContent = 'Gemini is evaluating multi-page submissions against rubric...';

    const response = await fetch('/api/mark-batch', { method: 'POST', body: formData });
    const data = await response.json();

    if (data.success) {
      progressFill.style.width = '100%';
      progressLabel.textContent = `Done! ${data.count} student essays marked.`;
      manualResults = data.data;
      renderCardsAndSummaryTable(manualResults, 'manual');
      toolbar.style.display = 'flex';
      showToast('Evaluation complete!');
    } else {
      alert(`Notice: ${data.error}`);
    }
  } catch (err) {
    alert('Server connection error.');
  } finally {
    markBtn.disabled = false;
  }
});

printBtn.addEventListener('click', () => {
  if (!manualResults || manualResults.length === 0) {
    alert('No manual batch results to print.');
    return;
  }
  document.querySelectorAll('#results .result-body').forEach(b => b.classList.add('open'));
  document.body.classList.remove('print-feedback-only');
  document.body.classList.add('printing-manual');
  document.body.classList.remove('printing-portal');
  document.getElementById('print-report-title').textContent = 'Class Evaluation Summary';
  
  const teacherDisplay = (currentUser && currentUser.name) ? currentUser.name : 'Teacher';
  document.getElementById('manual-print-report-sub').textContent = `Teacher: ${teacherDisplay} | Total Assessed: ${manualResults.length} Student${manualResults.length === 1 ? '' : 's'}`;

  setTimeout(() => {
    window.print();
    setTimeout(() => {
      document.body.classList.remove('printing-manual');
    }, 500);
  }, 200);
});

printFeedbackBtn.addEventListener('click', () => {
  if (!manualResults || manualResults.length === 0) {
    alert('No manual batch results to print.');
    return;
  }
  document.querySelectorAll('#results .result-body').forEach(b => b.classList.add('open'));
  document.body.classList.add('print-feedback-only');
  document.body.classList.add('printing-manual');
  document.body.classList.remove('printing-portal');
  document.getElementById('print-report-title').textContent = 'Student Feedback & Correction Report';

  const teacherDisplay = (currentUser && currentUser.name) ? currentUser.name : 'Teacher';
  document.getElementById('manual-print-report-sub').textContent = `Teacher: ${teacherDisplay} | Total Assessed: ${manualResults.length} Student${manualResults.length === 1 ? '' : 's'}`;

  setTimeout(() => {
    window.print();
    setTimeout(() => {
      document.body.classList.remove('print-feedback-only');
      document.body.classList.remove('printing-manual');
    }, 500);
  }, 200);
});
