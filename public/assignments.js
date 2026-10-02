// ==========================================
// ASSIGNMENTS.JS - Creation, Bundles & Deadlines
// ==========================================

var taskDefinitions = [
  { title: '', schemeFiles: [], schemeText: '' }
];
var portalSchemeFiles = [];
var newSubtaskSchemeFiles = [];

function renderTaskDefinitions() {
  const container = document.getElementById('tasks-repeater-container');
  if (!container) return;

  container.innerHTML = taskDefinitions.map((t, idx) => `
    <div style="margin-bottom: 16px; border: 1px solid var(--border); background: #FAFBFD; padding: 16px; border-radius: 8px;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
        <span style="font-weight: 600; font-size: 13.5px; color: var(--pen); font-family: 'Source Serif 4', serif;">Task #${idx + 1}</span>
        ${taskDefinitions.length > 1 ? `
          <button type="button" onclick="removeTaskDefinition(${idx})" style="color: #DC2626; border: none; background: none; font-weight: 600; cursor: pointer; font-size: 12px;">&times; Remove Task</button>
        ` : ''}
      </div>
      
      <label style="display:block; font-size: 12.5px; font-weight: 600; margin-bottom: 4px;">Task Name</label>
      <input type="text" id="task-title-${idx}" value="${escapeHtml(t.title || '')}" oninput="syncTaskTitle(${idx}, this.value)" placeholder="e.g. Essay or Grammar Test" style="width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; font-size: 13.5px; margin-bottom: 10px; background: #fff;" />

      <label style="display:block; font-size: 12.5px; font-weight: 600; margin-bottom: 4px;">Marking Scheme / Rubric Files</label>
      <input type="file" id="task-scheme-file-${idx}" multiple style="display:none;" onchange="handleTaskSchemeFiles(${idx}, event)" accept="image/*,.pdf,.docx,.txt" />
      <div class="dropzone" onclick="document.getElementById('task-scheme-file-${idx}').click()" style="margin-left: 0; padding: 14px 12px; background: #fff;">
        <div style="font-size: 12.5px;"><b>Attach Rubric / Answer Key</b> (PDF, DOCX, Images)</div>
      </div>
      <div class="badge-grid" id="task-scheme-badges-${idx}" style="margin-left: 0; margin-bottom: 10px;">
        ${(t.schemeFiles || []).map((f, fIdx) => `
          <div class="file-chip">
            <span>📋 ${escapeHtml(f.name)}</span>
            <button class="file-chip-remove" onclick="removeTaskSchemeFile(${idx},${fIdx})">&times;</button>
          </div>
        `).join('')}
      </div>

      <label style="display:block; font-size: 12.5px; font-weight: 600; margin-bottom: 4px;">Rubric Notes & Criteria (Optional)</label>
      <textarea id="task-scheme-text-${idx}" oninput="syncTaskNotes(${idx}, this.value)" placeholder="Extra teacher instructions or criteria..." style="margin-left: 0; width: 100%; min-height: 60px; padding: 8px 10px; font-size: 13px; background: #fff;">${escapeHtml(t.schemeText || '')}</textarea>
    </div>
  `).join('');
}

function syncTaskTitle(idx, val) {
  if (taskDefinitions[idx]) {
    taskDefinitions[idx].title = val;
  }
}

function syncTaskNotes(idx, val) {
  if (taskDefinitions[idx]) {
    taskDefinitions[idx].schemeText = val;
  }
}

function handleTaskSchemeFiles(taskIdx, e) {
  if (!taskDefinitions[taskIdx].schemeFiles) taskDefinitions[taskIdx].schemeFiles = [];
  for (const f of e.target.files) taskDefinitions[taskIdx].schemeFiles.push(f);
  renderTaskDefinitions();
}

function removeTaskSchemeFile(taskIdx, fileIdx) {
  taskDefinitions[taskIdx].schemeFiles.splice(fileIdx, 1);
  renderTaskDefinitions();
}

function addNewTaskField() {
  taskDefinitions.push({
    title: '',
    schemeFiles: [],
    schemeText: ''
  });
  renderTaskDefinitions();
}

function removeTaskDefinition(idx) {
  if (taskDefinitions.length <= 1) return;
  taskDefinitions.splice(idx, 1);
  renderTaskDefinitions();
}

function handlePortalSchemeFiles(e) {
  for (const f of e.target.files) portalSchemeFiles.push(f);
  renderPortalBadges();
  e.target.value = '';
}

function renderPortalBadges() {
  const grid = document.getElementById('portal-scheme-badges');
  grid.innerHTML = portalSchemeFiles.map((f, i) => `
    <div class="file-chip">
      <span>📋 Page ${i + 1}: ${f.name}</span>
      <button class="file-chip-remove" onclick="portalSchemeFiles.splice(${i}, 1); renderPortalBadges();">&times;</button>
    </div>
  `).join('');
}

async function loadTeacherAssignments() {
  try {
    const res = await fetch('/api/assignments');
    const d = await res.json();
    if (d.success && d.assignments) {
      allAssignmentsMap = {};
      const select = document.getElementById('past-assignments-select');
      
      const bundlesMap = {};
      d.assignments.forEach(a => {
        const key = a.bundle_code || a.code;
        if (!bundlesMap[key]) {
          bundlesMap[key] = {
            groupTitle: a.group_title || a.title,
            deadline: a.deadline,
            tasks: []
          };
        }
        bundlesMap[key].tasks.push(a);
        allAssignmentsMap[a.code] = a;
      });

      select.innerHTML = '<option value="">-- Select an assignment package --</option>' +
        Object.entries(bundlesMap).map(([bKey, bundle]) => {
          const firstTaskCode = bundle.tasks[0].code;
          const totalSubs = bundle.tasks.reduce((acc, t) => acc + t.submission_count, 0);
          const deadlineText = formatDeadlineString(bundle.deadline);
          const displayLabel = bundle.tasks.length > 1 
            ? `📦 ${bundle.groupTitle} (${bundle.tasks.length} tasks, ${totalSubs} submissions) — ${deadlineText}`
            : `${bundle.groupTitle} (${totalSubs} submissions) — ${deadlineText}`;

          return `<option value="${firstTaskCode}">${escapeHtml(displayLabel)}</option>`;
        }).join('');

      if (activeCode && allAssignmentsMap[activeCode]) {
        select.value = activeCode;
      }
    }
  } catch (e) {
    console.error('Failed to load past assignments:', e);
  }
}

function getFullActiveTitle() {
  const assignmentObj = allAssignmentsMap[activeCode];
  const groupName = assignmentObj ? (assignmentObj.group_title || '').trim() : '';
  
  const activeTabBtn = document.querySelector('#bundle-task-tabs button.primary');
  let taskName = activeTabBtn ? activeTabBtn.textContent.trim() : (assignmentObj ? (assignmentObj.title || '').trim() : '');

  if (groupName && taskName && groupName.toLowerCase() !== taskName.toLowerCase()) {
    return `${groupName} — ${taskName}`;
  }
  return groupName || taskName || 'Assignment';
}

function switchActiveTaskTab(taskCode, taskTitle) {
  activeCode = taskCode;
  
  if (allAssignmentsMap[taskCode]) {
    allAssignmentsMap[taskCode].title = taskTitle;
  }

  document.querySelectorAll('#bundle-task-tabs button').forEach(btn => {
    btn.classList.toggle('primary', btn.textContent.trim() === taskTitle.trim());
  });

  const fullTitle = getFullActiveTitle();
  const liveTitle = document.getElementById('live-portal-title');
  if (liveTitle) liveTitle.textContent = `Live Submissions: ${fullTitle}`;

  const summaryTitle = document.getElementById('portal-print-report-title');
  if (summaryTitle) summaryTitle.textContent = `Class Evaluation Summary: ${fullTitle}`;

  fetchLiveSubmissions();
}

function loadSelectedAssignment(selectedCode) {
  if (!selectedCode) return;
  activeCode = selectedCode;

  if (typeof stopMcqLivePolling === 'function') stopMcqLivePolling();
  if (typeof activeMcqCode !== 'undefined') activeMcqCode = null;
  if (typeof activeViewMode !== 'undefined') activeViewMode = 'essay';

  const essayHeaders = document.getElementById('portal-table-headers-essay');
  const mcqHeaders = document.getElementById('portal-table-headers-mcq');
  if (essayHeaders) essayHeaders.style.display = 'table-row';
  if (mcqHeaders) mcqHeaders.style.display = 'none';

  const btnEditDdl = document.getElementById('portal-btn-edit-deadline');
  const btnManageBundle = document.getElementById('portal-btn-manage-bundle');
  const btnDelForm = document.getElementById('portal-btn-delete-form');
  const btnLogs = document.getElementById('portal-btn-logs') || document.getElementById('btn-view-logs');
  const btnDeleteMcq = document.getElementById('btn-delete-mcq-test');
  if (btnEditDdl) btnEditDdl.style.display = '';
  if (btnManageBundle) btnManageBundle.style.display = '';
  if (btnDelForm) btnDelForm.style.display = '';
  if (btnLogs) btnLogs.style.display = '';
  if (btnDeleteMcq) btnDeleteMcq.style.display = 'none';

  const fullDisplayTitle = getFullActiveTitle();
  const assignmentObj = allAssignmentsMap[selectedCode];
  const deadlineText = assignmentObj ? formatDeadlineString(assignmentObj.deadline) : 'No Deadline';
  const teacherDisplay = (currentUser && currentUser.name) ? currentUser.name : 'Teacher';
  const studentCount = portalSubmissions ? portalSubmissions.length : 0;
  const countText = `${studentCount} Student${studentCount === 1 ? '' : 's'}`;

  document.getElementById('live-portal-title').textContent = `Live Submissions: ${fullDisplayTitle}`;
  document.getElementById('live-portal-deadline-sub').textContent = deadlineText;
  document.getElementById('portal-print-report-title').textContent = `Class Evaluation Summary: ${fullDisplayTitle}`;
  document.getElementById('portal-print-report-sub').textContent = `Teacher: ${teacherDisplay} | Total Assessed: ${countText}`;
  document.getElementById('portal-results-card').style.display = 'block';

  if (assignmentObj && assignmentObj.bundle_code) {
    fetch(`/api/public/bundle/${assignmentObj.bundle_code}`)
      .then(res => res.json())
      .then(d => {
        if (d.success && d.tasks) {
          renderBundleTabs(d.tasks);
        }
      }).catch(() => {});
  } else {
    const tabsContainer = document.getElementById('bundle-task-tabs');
    if (tabsContainer) {
      tabsContainer.style.display = 'none';
      tabsContainer.innerHTML = '';
    }
  }

  const linkParam = assignmentObj && assignmentObj.bundle_code ? `bundle=${assignmentObj.bundle_code}` : `code=${selectedCode}`;
  const fullUrl = `${window.location.origin}/submit.html?${linkParam}`;
  document.getElementById('generated-link-url').textContent = fullUrl;
  document.getElementById('generated-link-box').style.display = 'flex';

  startLivePolling();
}

async function createAssignmentLink() {
  const groupTitleEl = document.getElementById('bundle-group-title-input');
  const groupTitle = groupTitleEl ? groupTitleEl.value.trim() : '';
  const deadlineIso = getIsoFrom12h('portal-date', 'portal-hour', 'portal-minute', 'portal-ampm');

  if (deadlineIso) {
    const ddlTime = new Date(deadlineIso).getTime();
    if (!isNaN(ddlTime) && ddlTime < Date.now()) {
      alert('The deadline cannot be set to a past date or time. Please select a future date/time.');
      return;
    }
  }

  const tasksPayload = [];
  const formData = new FormData();
  if (deadlineIso) formData.append('deadline', deadlineIso);
  if (groupTitle) formData.append('groupTitle', groupTitle);

  for (let i = 0; i < taskDefinitions.length; i++) {
    const titleInput = document.getElementById(`task-title-${i}`);
    const notesInput = document.getElementById(`task-scheme-text-${i}`);

    const titleVal = (titleInput ? titleInput.value.trim() : '') || (taskDefinitions[i].title || '').trim() || `Task ${i + 1}`;
    const notesVal = (notesInput ? notesInput.value.trim() : '') || (taskDefinitions[i].schemeText || '').trim();

    tasksPayload.push({
      title: titleVal,
      schemeText: notesVal
    });

    const files = taskDefinitions[i].schemeFiles || [];
    for (const f of files) {
      formData.append(`scheme_${i}`, f);
    }
  }

  formData.append('tasks', JSON.stringify(tasksPayload));

  try {
    const res = await fetch('/api/assignments/create-bundle', { method: 'POST', body: formData });
    const d = await res.json();

    if (d.success) {
      activeCode = d.tasks[0].code;
      const deadlineText = formatDeadlineString(deadlineIso);
      const displayTitle = d.groupTitle || d.tasks[0].title;

      document.getElementById('live-portal-title').textContent = `Live Submissions: ${displayTitle}`;
      document.getElementById('live-portal-deadline-sub').textContent = deadlineText;
      document.getElementById('portal-print-report-title').textContent = `Class Evaluation Summary: ${displayTitle}`;
      document.getElementById('portal-print-report-sub').textContent = `Teacher: ${currentUser?.name || 'Teacher'} | Total Assessed: 0 Students`;

      document.getElementById('generated-link-url').textContent = d.link;
      document.getElementById('generated-link-box').style.display = 'flex';
      document.getElementById('portal-results-card').style.display = 'block';

      renderBundleTabs(d.tasks);
      startLivePolling();
      loadTeacherAssignments();
      showToast('Student link generated successfully!');
    } else {
      alert(d.error || 'Failed to create assignment bundle.');
    }
  } catch (err) {
    alert('Connection error creating assignment.');
  }
}

function renderBundleTabs(tasks) {
  const tabsContainer = document.getElementById('bundle-task-tabs');
  if (!tabsContainer || !tasks || tasks.length <= 1) {
    if (tabsContainer) tabsContainer.style.display = 'none';
    return;
  }

  tabsContainer.style.display = 'flex';
  tabsContainer.innerHTML = tasks.map(t => `
    <button type="button" class="ghost ${t.code === activeCode ? 'primary' : ''}" style="margin-left:0; padding:6px 12px; font-size:12.5px; font-weight:600;" onclick="switchActiveTaskTab('${t.code}', '${escapeHtml(t.title)}')">
      ${escapeHtml(t.title)}
    </button>
  `).join('');
}

function copyLink() {
  const url = document.getElementById('generated-link-url').textContent;
  navigator.clipboard.writeText(url);
  showToast('Link copied to clipboard!');
}


function openBundleManagerModal() {
  const assignmentObj = allAssignmentsMap[activeCode];
  if (!assignmentObj || !assignmentObj.bundle_code) {
    alert('This assignment is not part of a multi-task package.');
    return;
  }
  activeBundleCode = assignmentObj.bundle_code;
  newSubtaskSchemeFiles = [];
  renderNewSubtaskBadges();
  document.getElementById('new-subtask-title').value = '';
  document.getElementById('new-subtask-scheme-text').value = '';
  document.getElementById('bundle-manager-modal').style.display = 'flex';
  loadBundleManagerTasks();
}

function closeBundleManagerModal() {
  document.getElementById('bundle-manager-modal').style.display = 'none';
}

let activeBundleCode = null;

function handleNewSubtaskFiles(e) {
  for (const f of e.target.files) newSubtaskSchemeFiles.push(f);
  renderNewSubtaskBadges();
  e.target.value = '';
}

function renderNewSubtaskBadges() {
  const grid = document.getElementById('new-subtask-badges');
  if (!grid) return;
  grid.innerHTML = newSubtaskSchemeFiles.map((f, i) => `
    <div class="file-chip">
      <span>📋 ${escapeHtml(f.name)}</span>
      <button class="file-chip-remove" onclick="newSubtaskSchemeFiles.splice(${i}, 1); renderNewSubtaskBadges();">&times;</button>
    </div>
  `).join('');
}

async function loadBundleManagerTasks() {
  const container = document.getElementById('bundle-tasks-list-container');
  container.innerHTML = 'Loading tasks...';
  try {
    const res = await fetch(`/api/public/bundle/${activeBundleCode}`);
    const d = await res.json();
    if (d.success && d.tasks) {
      container.innerHTML = d.tasks.map(t => `
        <div style="display:flex; justify-content:space-between; align-items:center; background:#F8FAFC; border:1px solid var(--border); padding:8px 12px; border-radius:6px; gap:8px;">
          <input 
            type="text" 
            id="task-rename-input-${t.code}" 
            value="${escapeHtml(t.title)}" 
            style="flex:1; padding:6px 10px; border:1px solid var(--border); border-radius:5px; font-size:13px; font-weight:600; color:var(--ink); background:#fff; outline:none;" 
            onkeydown="if(event.key==='Enter') renameSubTask('${t.code}')"
          />
          <div style="display:flex; gap:6px; flex-shrink:0;">
            <button type="button" class="ghost" style="padding:5px 9px; font-size:11.5px; border-radius:5px; font-weight:600;" onclick="renameSubTask('${t.code}')">💾 Save</button>
            <button type="button" class="ghost ghost-danger" style="padding:5px 9px; font-size:11.5px; border-radius:5px;" onclick="deleteSubTask('${t.code}')">🗑️ Delete</button>
          </div>
        </div>
      `).join('');
    }
  } catch (err) {
    container.innerHTML = 'Failed to load package tasks.';
  }
}

async function renameSubTask(taskCode) {
  const input = document.getElementById(`task-rename-input-${taskCode}`);
  if (!input) return;
  const newTitle = input.value.trim();

  if (!newTitle) {
    alert('Task title cannot be empty.');
    return;
  }

  try {
    const res = await fetch(`/api/assignments/tasks/${taskCode}/rename`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle })
    });
    const d = await res.json();

    if (d.success) {
      showToast(d.message || 'Task renamed successfully!');

      if (allAssignmentsMap[taskCode]) {
        allAssignmentsMap[taskCode].title = newTitle;
      }

      await loadTeacherAssignments();

      const assignmentObj = allAssignmentsMap[activeCode];
      if (assignmentObj && assignmentObj.bundle_code) {
        const bundleRes = await fetch(`/api/public/bundle/${assignmentObj.bundle_code}`);
        const bundleData = await bundleRes.json();
        if (bundleData.success && bundleData.tasks) {
          renderBundleTabs(bundleData.tasks);
          if (taskCode === activeCode) {
            const fullTitle = getFullActiveTitle();
            document.getElementById('live-portal-title').textContent = `Live Submissions: ${fullTitle}`;
            document.getElementById('portal-print-report-title').textContent = `Class Evaluation Summary: ${fullTitle}`;
          }
        }
      }
    } else {
      alert(d.error || 'Failed to rename task.');
    }
  } catch (err) {
    alert('Connection error renaming task.');
  }
}

async function deleteSubTask(taskCode) {
  const confirmed = await showConfirmModal('Are you sure you want to delete this task and its submissions?', 'Delete Task');
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/assignments/tasks/${taskCode}`, { method: 'DELETE' });
    const d = await res.json();
    if (d.success) {
      showToast(d.message);
      
      await loadBundleManagerTasks();
      await loadTeacherAssignments();

      const assignmentObj = allAssignmentsMap[activeCode];
      if (assignmentObj && assignmentObj.bundle_code) {
        const bundleRes = await fetch(`/api/public/bundle/${assignmentObj.bundle_code}`);
        const bundleData = await bundleRes.json();
        if (bundleData.success && bundleData.tasks) {
          renderBundleTabs(bundleData.tasks);
          
          if (taskCode === activeCode && bundleData.tasks.length > 0) {
            switchActiveTaskTab(bundleData.tasks[0].code, bundleData.tasks[0].title);
          }
        }
      }
    } else {
      alert(d.error || 'Failed to delete task.');
    }
  } catch (err) {
    alert('Connection error deleting task.');
  }
}

async function addNewSubTaskToBundle() {
  const input = document.getElementById('new-subtask-title');
  const title = input.value.trim();
  const schemeText = document.getElementById('new-subtask-scheme-text').value.trim();

  if (!title) {
    alert('Please enter a task name.');
    return;
  }

  const formData = new FormData();
  formData.append('title', title);
  formData.append('schemeText', schemeText);
  newSubtaskSchemeFiles.forEach(f => formData.append('scheme', f));

  try {
    const res = await fetch(`/api/assignments/bundle/${activeBundleCode}/tasks`, {
      method: 'POST',
      body: formData
    });
    const d = await res.json();
    if (d.success) {
      input.value = '';
      document.getElementById('new-subtask-scheme-text').value = '';
      newSubtaskSchemeFiles = [];
      renderNewSubtaskBadges();
      showToast(d.message);
      
      loadBundleManagerTasks();
      loadTeacherAssignments();

      const assignmentObj = allAssignmentsMap[activeCode];
      if (assignmentObj && assignmentObj.bundle_code) {
        const bundleRes = await fetch(`/api/public/bundle/${assignmentObj.bundle_code}`);
        const bundleData = await bundleRes.json();
        if (bundleData.success && bundleData.tasks) {
          renderBundleTabs(bundleData.tasks);
          
          if (d.code) {
            switchActiveTaskTab(d.code, title);
          }
        }
      }
    } else {
      alert(d.error || 'Failed to add task.');
    }
  } catch (err) {
    alert('Connection error adding task.');
  }
}

// ==================== DELETE ASSIGNMENT LOGIC ====================
async function deleteActiveAssignment() {
  if (!activeCode) return;
  const assignment = allAssignmentsMap[activeCode];
  const title = assignment ? assignment.group_title || assignment.title : 'this assignment';

  const confirmed = await showConfirmModal(
    `Are you sure you want to permanently delete "${title}"? This will delete all student submissions, marks, and feedback associated with this form from the database.`,
    'Delete Assignment & Submissions'
  );

  if (!confirmed) return;

  try {
    const res = await fetch(`/api/assignments/${activeCode}`, { method: 'DELETE' });
    const d = await res.json();

    if (d.success) {
      if (livePollTimer) clearInterval(livePollTimer);
      delete allAssignmentsMap[activeCode];
      activeCode = '';
      portalSubmissions = [];

      document.getElementById('portal-results-card').style.display = 'none';
      document.getElementById('generated-link-box').style.display = 'none';
      const tabs = document.getElementById('bundle-task-tabs');
      if (tabs) tabs.style.display = 'none';

      await loadTeacherAssignments();
      showToast(d.message || 'Assignment deleted successfully.');
    } else {
      alert(d.error || 'Failed to delete assignment.');
    }
  } catch (err) {
    alert('Connection error deleting assignment.');
  }
}

// ==================== DEADLINE EDITING LOGIC ====================
function openDeadlineEditModal() {
  if (!activeCode) return;
  setMinDateOnly();

  const assignment = allAssignmentsMap[activeCode];
  if (assignment && assignment.deadline) {
    try {
      const d = new Date(assignment.deadline);
      const pad = (n) => String(n).padStart(2, '0');
      
      const cairoStr = d.toLocaleString('en-US', { timeZone: 'Africa/Cairo', hour12: false });
      const [datePart, timePart] = cairoStr.split(', ');
      const [m, day, y] = datePart.split('/');
      const [h24, min] = timePart.split(':');

      document.getElementById('edit-date').value = `${y}-${pad(m)}-${pad(day)}`;

      let hourNum = parseInt(h24, 10);
      const ampm = hourNum >= 12 ? 'PM' : 'AM';
      if (hourNum > 12) hourNum -= 12;
      if (hourNum === 0) hourNum = 12;

      document.getElementById('edit-hour').value = pad(hourNum);
      document.getElementById('edit-minute').value = min;
      document.getElementById('edit-ampm').value = ampm;
    } catch (e) {
      clearEditDeadlineInputs();
    }
  } else {
    clearEditDeadlineInputs();
  }

  document.getElementById('deadline-edit-modal').style.display = 'flex';
}

function clearEditDeadlineInputs() {
  document.getElementById('edit-date').value = '';
  document.getElementById('edit-hour').value = '11';
  document.getElementById('edit-minute').value = '59';
  document.getElementById('edit-ampm').value = 'PM';
}

function closeDeadlineEditModal() {
  document.getElementById('deadline-edit-modal').style.display = 'none';
}

async function saveAssignmentDeadline() {
  if (!activeCode) return;
  const newDeadlineIso = getIsoFrom12h('edit-date', 'edit-hour', 'edit-minute', 'edit-ampm');
  const btn = document.getElementById('save-deadline-btn');

  if (newDeadlineIso) {
    const ddlTime = new Date(newDeadlineIso).getTime();
    if (!isNaN(ddlTime) && ddlTime < Date.now()) {
      alert('The deadline cannot be set to a past date or time. Please choose a future date/time.');
      return;
    }
  }

  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const res = await fetch(`/api/assignments/${activeCode}/update-deadline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deadline: newDeadlineIso })
    });
    const d = await res.json();

    btn.disabled = false;
    btn.textContent = 'Save Changes';

    if (d.success) {
      if (allAssignmentsMap[activeCode]) {
        allAssignmentsMap[activeCode].deadline = d.deadline;
      }
      const formatted = formatDeadlineString(d.deadline);
      document.getElementById('live-portal-deadline-sub').textContent = formatted;
      
      const teacherDisplay = (currentUser && currentUser.name) ? currentUser.name : 'Teacher';
      const studentCount = portalSubmissions ? portalSubmissions.length : 0;
      const countText = `${studentCount} Student${studentCount === 1 ? '' : 's'}`;
      document.getElementById('portal-print-report-sub').textContent = `Teacher: ${teacherDisplay} | Total Assessed: ${countText}`;
      
      closeDeadlineEditModal();
      await loadTeacherAssignments();
      showToast('Deadline updated successfully!');
    } else {
      alert(d.error || 'Failed to update deadline.');
    }
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Save Changes';
    alert('Connection error updating deadline.');
  }
}

// ==========================================
// MCQ TESTS (STAGE 2: REVIEW & PUBLISH)
// ==========================================

var currentMcqTestId = null;
var currentMcqTestData = null;
var currentMcqQuestions = [];
var mcqPdfFile = null;
var mcqSchemeFiles = [];
var mcqAudioFile = null;
var mcqAutoSaveTimers = {};

function initMcqFileHandlers() {
  const pdfDz = document.getElementById('mcq-pdf-dz');
  const pdfInput = document.getElementById('mcq-pdf-file');
  const schemeDz = document.getElementById('mcq-scheme-dz');
  const schemeInput = document.getElementById('mcq-scheme-file');
  const audioDz = document.getElementById('mcq-audio-dz');
  const audioInput = document.getElementById('mcq-audio-file');

  if (pdfDz && pdfInput) {
    pdfDz.addEventListener('click', () => pdfInput.click());
    pdfInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        mcqPdfFile = e.target.files[0];
        renderMcqPdfBadge();
      }
    });
    pdfDz.addEventListener('dragover', (e) => { e.preventDefault(); pdfDz.classList.add('drag'); });
    pdfDz.addEventListener('dragleave', () => pdfDz.classList.remove('drag'));
    pdfDz.addEventListener('drop', (e) => {
      e.preventDefault();
      pdfDz.classList.remove('drag');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        mcqPdfFile = e.dataTransfer.files[0];
        renderMcqPdfBadge();
      }
    });
  }

  if (schemeDz && schemeInput) {
    schemeDz.addEventListener('click', () => schemeInput.click());
    schemeInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length) {
        for (const f of e.target.files) mcqSchemeFiles.push(f);
        renderMcqSchemeBadges();
      }
      schemeInput.value = '';
    });
    schemeDz.addEventListener('dragover', (e) => { e.preventDefault(); schemeDz.classList.add('drag'); });
    schemeDz.addEventListener('dragleave', () => schemeDz.classList.remove('drag'));
    schemeDz.addEventListener('drop', (e) => {
      e.preventDefault();
      schemeDz.classList.remove('drag');
      if (e.dataTransfer.files && e.dataTransfer.files.length) {
        for (const f of e.dataTransfer.files) mcqSchemeFiles.push(f);
        renderMcqSchemeBadges();
      }
    });
  }

  if (audioDz && audioInput) {
    audioDz.addEventListener('click', () => audioInput.click());
    audioInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        const file = e.target.files[0];
        if (file.size > 100 * 1024 * 1024) {
          alert('The selected audio file exceeds the 100MB limit. Please compress it or use an MP3 version.');
          audioInput.value = '';
          return;
        }
        mcqAudioFile = file;
        renderMcqAudioBadge();
      }
    });
    audioDz.addEventListener('dragover', (e) => { e.preventDefault(); audioDz.classList.add('drag'); });
    audioDz.addEventListener('dragleave', () => audioDz.classList.remove('drag'));
    audioDz.addEventListener('drop', (e) => {
      e.preventDefault();
      audioDz.classList.remove('drag');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        const file = e.dataTransfer.files[0];
        if (file.size > 100 * 1024 * 1024) {
          alert('The selected audio file exceeds the 100MB limit. Please compress it or use an MP3 version.');
          return;
        }
        mcqAudioFile = file;
        renderMcqAudioBadge();
      }
    });
  }
}

function renderMcqPdfBadge() {
  const container = document.getElementById('mcq-pdf-badge');
  if (!container) return;
  if (!mcqPdfFile) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = `
    <div class="file-chip">
      <span>📄 Question Paper: ${escapeHtml(mcqPdfFile.name)}</span>
      <button type="button" class="file-chip-remove" onclick="removeMcqPdf()">&times;</button>
    </div>
  `;
}

function removeMcqPdf() {
  mcqPdfFile = null;
  const input = document.getElementById('mcq-pdf-file');
  if (input) input.value = '';
  renderMcqPdfBadge();
}

function renderMcqSchemeBadges() {
  const container = document.getElementById('mcq-scheme-badges');
  if (!container) return;
  container.innerHTML = mcqSchemeFiles.map((f, idx) => `
    <div class="file-chip">
      <span>📋 Scheme #${idx + 1}: ${escapeHtml(f.name)}</span>
      <button type="button" class="file-chip-remove" onclick="removeMcqSchemeFile(${idx})">&times;</button>
    </div>
  `).join('');
}

function removeMcqSchemeFile(idx) {
  mcqSchemeFiles.splice(idx, 1);
  renderMcqSchemeBadges();
}

function renderMcqAudioBadge() {
  const container = document.getElementById('mcq-audio-badge');
  if (!container) return;
  if (!mcqAudioFile) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = `
    <div class="file-chip">
      <span>🎵 Audio Track: ${escapeHtml(mcqAudioFile.name)}</span>
      <button type="button" class="file-chip-remove" onclick="removeMcqAudio()">&times;</button>
    </div>
  `;
}

function removeMcqAudio() {
  mcqAudioFile = null;
  const input = document.getElementById('mcq-audio-file');
  if (input) input.value = '';
  renderMcqAudioBadge();
}

async function generateMcqTest() {
  const titleInput = document.getElementById('mcq-title-input');
  const schemeTextInput = document.getElementById('mcq-scheme-text');
  const maxPlaysInput = document.getElementById('mcq-max-plays');
  const btn = document.getElementById('mcq-generate-btn');
  const progressWrap = document.getElementById('mcq-progress-wrap');
  const progressFill = document.getElementById('mcq-progress-fill');
  const progressLabel = document.getElementById('mcq-progress-label');

  const title = (titleInput?.value || '').trim();
  if (!title) {
    alert('Please enter a test title.');
    titleInput?.focus();
    return;
  }

  if (!mcqPdfFile) {
    alert('Please upload a test question paper PDF.');
    return;
  }

  const schemeText = (schemeTextInput?.value || '').trim();
  if (mcqSchemeFiles.length === 0 && !schemeText) {
    alert('Please provide a marking scheme as a file or text criteria.');
    return;
  }

  const deadline = getIsoFrom12h('mcq-deadline-date', 'mcq-deadline-hour', 'mcq-deadline-minute', 'mcq-deadline-ampm');
  const maxPlays = Math.max(0, parseInt(maxPlaysInput?.value || '0', 10) || 0);

  const fd = new FormData();
  fd.append('title', title);
  if (deadline) fd.append('deadline', deadline);
  fd.append('maxPlays', maxPlays);
  fd.append('pdf', mcqPdfFile);

  mcqSchemeFiles.forEach((f) => fd.append('markingScheme', f));
  if (schemeText) fd.append('markingScheme', schemeText);

  if (mcqAudioFile) {
    if (mcqAudioFile.size > 100 * 1024 * 1024) {
      alert('The selected audio file exceeds the 100MB limit. Please compress it or use an MP3 version.');
      return;
    }
    fd.append('audio', mcqAudioFile);
  }

  btn.disabled = true;
  btn.textContent = '⏳ Processing with AI...';
  if (progressWrap) progressWrap.style.display = 'block';
  if (progressFill) progressFill.style.width = '35%';
  if (progressLabel) progressLabel.textContent = 'Uploading documents and initiating AI extraction...';

  try {
    if (progressFill) progressFill.style.width = '65%';
    if (progressLabel) progressLabel.textContent = 'Analyzing PDF & generating multiple-choice questions...';

    const res = await fetch('/api/mcq/generate', {
      method: 'POST',
      body: fd
    });

    if (res.status === 401 || res.status === 403) {
      btn.disabled = false;
      btn.textContent = '⚡ Generate MCQ Test with AI';
      if (progressWrap) progressWrap.style.display = 'none';
      if (progressFill) progressFill.style.width = '0%';
      alert('Your session has expired or authentication is required. Please log in again.');
      window.location.replace('/login.html');
      return;
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const rawText = await res.text();
      console.error('Non-JSON response from server:', rawText);
      throw new Error(`Server returned status ${res.status} with non-JSON content. Check server logs.`);
    }

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to generate MCQ test.');
    }

    if (progressFill) progressFill.style.width = '100%';
    if (progressLabel) progressLabel.textContent = 'MCQ test successfully generated!';

    showToast('MCQ test generated successfully!');

    // Switch view to review card
    document.getElementById('mcq-create-card').style.display = 'none';
    document.getElementById('mcq-review-card').style.display = 'block';

    await loadMcqReview(data.test.id);
  } catch (err) {
    console.error('MCQ generation error:', err);
    if (typeof showToast === 'function') {
      showToast('Error: ' + err.message, 'error');
    }
    alert('Error: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '⚡ Generate MCQ Test with AI';
    if (progressWrap) progressWrap.style.display = 'none';
    if (progressFill) progressFill.style.width = '0%';
  }
}

async function loadMcqReview(testId) {
  try {
    const res = await fetch(`/api/mcq/${testId}`);
    if (res.status === 401 || res.status === 403) {
      alert('Your session has expired. Please log in again.');
      window.location.replace('/login.html');
      return;
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const rawText = await res.text();
      console.error('Non-JSON response from server:', rawText);
      throw new Error(`Server returned status ${res.status} with non-JSON content.`);
    }

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to load test details.');
    }

    currentMcqTestId = data.test.id;
    currentMcqTestData = data.test;
    currentMcqQuestions = data.questions || [];

    // Update Header
    const titleEl = document.getElementById('mcq-review-title');
    if (titleEl) titleEl.textContent = data.test.title || 'MCQ Test Review';

    const statusEl = document.getElementById('mcq-review-status');
    if (statusEl) {
      if (data.test.status === 'published') {
        statusEl.className = 'pill-badge pill-green';
        statusEl.textContent = 'Published';
      } else {
        statusEl.className = 'pill-badge pill-amber';
        statusEl.textContent = 'Draft';
      }
    }

    // Audio Preview
    const audioContainer = document.getElementById('mcq-preview-audio-container');
    const audioElement = document.getElementById('mcq-preview-audio');
    if (data.audioUrl) {
      if (audioElement) {
        audioElement.src = data.audioUrl;
        audioElement.load();
      }
      if (audioContainer) audioContainer.style.display = 'block';
    } else {
      if (audioContainer) audioContainer.style.display = 'none';
    }

    // If already published, show the link box
    const linkBox = document.getElementById('mcq-published-link-box');
    const linkText = document.getElementById('mcq-published-link-url');
    if (data.test.status === 'published' && data.test.code) {
      const fullLink = `${window.location.origin}/mcq-test.html?code=${data.test.code}`;
      if (linkText) linkText.textContent = fullLink;
      if (linkBox) linkBox.style.display = 'flex';
      setPublishButtonsState(true);
    } else {
      if (linkBox) linkBox.style.display = 'none';
      setPublishButtonsState(false);
    }

    renderMcqEditor();
  } catch (err) {
    console.error('Failed to load MCQ review:', err);
    alert('Error loading review: ' + err.message);
  }
}

function renderMcqEditor() {
  const container = document.getElementById('mcq-questions-editor');
  if (!container) return;

  if (currentMcqQuestions.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 40px 20px; color: var(--ink-soft); border: 1px dashed var(--border); border-radius: 8px;">
        <p style="margin: 0 0 10px 0; font-size: 14px;">No questions in this test yet.</p>
        <button type="button" class="ghost" onclick="addBlankMcqQuestion()" style="font-weight: 600;">➕ Add Your First Question</button>
      </div>
    `;
    return;
  }

  const optionLetters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];

  container.innerHTML = currentMcqQuestions.map((q, qIdx) => {
    const qType = q.question_type || 'mcq';
    const opts = Array.isArray(q.options) ? q.options : ['Option A', 'Option B', 'Option C', 'Option D'];

    let badgeHtml = '<span class="pill-badge pill-pen" style="font-size: 11px;">📝 Multiple Choice</span>';
    if (qType === 'fill_blank') {
      badgeHtml = '<span class="pill-badge pill-blue" style="font-size: 11px;">✏️ Fill in the Blank</span>';
    } else if (qType === 'matching') {
      badgeHtml = '<span class="pill-badge pill-purple" style="font-size: 11px;">🔀 Matching</span>';
    }

    let bodyHtml = '';
    if (qType === 'fill_blank') {
      bodyHtml = `
        <div style="margin-top: 10px;">
          <label style="display:block; font-size: 12px; font-weight: 600; margin-bottom: 4px; color: var(--ink-soft);">
            Acceptable Answers (Comma-separated)
          </label>
          <input type="text" class="mcq-edit-acceptable" id="mcq-q-acceptable-${q.id}"
            value="${escapeHtml((q.acceptable_answers || []).join(', '))}"
            placeholder="e.g. 14, fourteen"
            oninput="onQuestionFieldChanged(${q.id})" />
          <small style="color: var(--ink-soft); font-size: 11px; display: block; margin-top: 4px;">
            💡 Multiple variations accepted (e.g. "14, fourteen"). Grading is case-insensitive.
          </small>
        </div>
      `;
    } else if (qType === 'matching') {
      bodyHtml = `
        <div style="margin-top: 10px;">
          <label style="display:block; font-size: 12px; font-weight: 600; margin-bottom: 6px; color: var(--ink-soft);">
            Statement Pool & Correct Match
          </label>
          <div style="margin-bottom: 8px; display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 12px; font-weight: 600; color: var(--pen);">Correct Statement:</span>
            <select class="mcq-matching-key-select" id="mcq-matching-select-${q.id}"
              onchange="onMatchingCorrectChanged(${q.id}, this.value)"
              style="padding: 5px 8px; border-radius: 4px; border: 1px solid var(--border); font-size: 12.5px;">
              ${opts.map((optText, optIdx) => {
                const letter = optionLetters[optIdx] || String(optIdx + 1);
                const textVal = typeof optText === 'string' ? optText : (optText?.text || optText?.statement || optText?.value || optText?.caption || '');
                const preview = textVal ? ': ' + textVal.slice(0, 35) + (textVal.length > 35 ? '...' : '') : '';
                return `<option value="${optIdx}" ${Number(q.correct_index) === optIdx ? 'selected' : ''}>Statement ${letter}${escapeHtml(preview)}</option>`;
              }).join('')}
            </select>
          </div>
          <div class="mcq-options-grid">
            ${opts.map((optText, optIdx) => {
              const letter = optionLetters[optIdx] || String(optIdx + 1);
              const isCorrect = Number(q.correct_index) === optIdx;
              const textVal = typeof optText === 'string' ? optText : (optText?.text || optText?.statement || optText?.value || optText?.caption || '');
              return `
                <div class="mcq-option-row ${isCorrect ? 'correct' : ''}" id="mcq-opt-row-${q.id}-${optIdx}">
                  <span class="mcq-opt-label">${letter}.</span>
                  <input type="text" class="mcq-opt-input" id="mcq-opt-input-${q.id}-${optIdx}"
                    value="${escapeHtml(textVal)}" placeholder="Statement ${letter} text..."
                    oninput="onQuestionFieldChanged(${q.id})" />
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    } else {
      // 'mcq'
      const qNumMatch = (q.question_text || '').match(/(?:^|\s|\b)(?:question\s*)?([1-9]\d?)\b/i);
      const qNum = qNumMatch ? parseInt(qNumMatch[1], 10) : (qIdx + 1);
      const isPart1 = qNum <= 5;
      let displayOpts = Array.isArray(opts) ? opts : [];
      if (!isPart1) {
        displayOpts = displayOpts.slice(0, 3);
      }
      const isVisual = isPart1 && displayOpts.some(o => typeof o === 'object' && o !== null && (o.type === 'image' || o.image_url));
      if (isVisual) {
        bodyHtml = `
          <div>
            <label style="display:block; font-size: 12px; font-weight: 600; margin-bottom: 6px; color: var(--ink-soft);">
              Visual Picture Options (Select radio for correct answer, edit caption):
            </label>
            <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-top: 8px;">
              ${displayOpts.map((opt, optIdx) => {
                const isCorrect = Number(q.correct_index) === optIdx;
                const rawL = (opt && opt.label) ? String(opt.label).trim().toUpperCase() : (optionLetters[optIdx] || String(optIdx + 1));
                const letter = rawL === 'S' ? 'C' : rawL;
                const imgUrl = (opt && opt.image_url) ? opt.image_url : '';
                const caption = (opt && (opt.caption || opt.value || opt.text)) ? (opt.caption || opt.value || opt.text) : '';
                return `
                  <div class="mcq-visual-opt-card ${isCorrect ? 'is-correct' : ''}" style="border: 2px solid ${isCorrect ? '#10b981' : 'var(--border)'}; background: ${isCorrect ? '#f0fdf4' : '#fff'}; border-radius: 8px; padding: 10px; display: flex; flex-direction: column;">
                    <div style="min-height: 90px; display: flex; align-items: center; justify-content: center; background: #fafafa; border-radius: 4px; margin-bottom: 6px; border: 1px solid var(--border);">
                      ${imgUrl ? `<img src="${escapeHtml(imgUrl)}" alt="Picture ${letter}" style="max-height: 100px; max-width: 100%; object-fit: contain;" />` : `<div style="font-size: 11px; font-weight: 600; color: #b91c1c; padding: 6px; background: #fef2f2; border: 1px dashed #f87171; border-radius: 4px;">⚠️ Missing Image</div>`}
                    </div>
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
                      <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-weight: 700; font-size: 12.5px; color: var(--pen); margin: 0;">
                        <input type="radio" name="mcq-correct-${q.id}" class="mcq-radio" ${isCorrect ? 'checked' : ''} onchange="onRadioCorrectChanged(${q.id}, ${optIdx})" />
                        Picture ${letter}
                      </label>
                    </div>
                    <input type="text" class="mcq-opt-input" id="mcq-opt-input-${q.id}-${optIdx}"
                      value="${escapeHtml(caption)}" placeholder="Caption (optional)"
                      oninput="onQuestionFieldChanged(${q.id})" style="font-size: 12px; padding: 4px 6px; border: 1px solid var(--border); border-radius: 4px;" />
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        `;
      } else {
        bodyHtml = `
          <div>
            <label style="display:block; font-size: 12px; font-weight: 600; margin-bottom: 6px; color: var(--ink-soft);">
              Options & Correct Answer (Select the radio button for the correct option)
            </label>
            <div class="mcq-options-grid">
              ${displayOpts.map((optText, optIdx) => {
                const isCorrect = Number(q.correct_index) === optIdx;
                const letter = optionLetters[optIdx] || String(optIdx + 1);
                const rawVal = typeof optText === 'object' && optText !== null ? (optText.value || optText.caption || optText.text || optText.statement || '') : String(optText || '');
                const cleanVal = String(rawVal || '').replace(/^[A-E][.:]\s*/i, '').trim();
                return `
                  <div class="mcq-option-row ${isCorrect ? 'correct' : ''}" id="mcq-opt-row-${q.id}-${optIdx}">
                    <input type="radio" name="mcq-correct-${q.id}" class="mcq-radio"
                      ${isCorrect ? 'checked' : ''} onchange="onRadioCorrectChanged(${q.id}, ${optIdx})" />
                    <span class="mcq-opt-label">${letter}.</span>
                    <input type="text" class="mcq-opt-input" id="mcq-opt-input-${q.id}-${optIdx}"
                      value="${escapeHtml(cleanVal)}" placeholder="Option ${letter} text..."
                      oninput="onQuestionFieldChanged(${q.id})" />
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        `;
      }
    }

    return `
      <div class="mcq-question-card" id="mcq-q-card-${q.id}">
        <div class="mcq-question-header">
          <div style="display: flex; align-items: center; gap: 10px;">
            <span class="mcq-qnum">Question ${qIdx + 1}</span>
            ${badgeHtml}
            <div class="mcq-points-wrap">
              <span>Points:</span>
              <input type="number" class="mcq-points-input" id="mcq-q-points-${q.id}" min="0" step="0.5" value="${q.points ?? 1}"
                oninput="onQuestionFieldChanged(${q.id})" />
            </div>
          </div>
          <button type="button" class="line-delete-btn" onclick="deleteMcqQuestion(${q.id})" title="Delete Question">
            🗑️ Delete
          </button>
        </div>

        <div>
          <label style="display:block; font-size: 12px; font-weight: 600; margin-bottom: 4px; color: var(--ink-soft);">Question Prompt / Text</label>
          <textarea class="mcq-qtext-input" id="mcq-q-text-${q.id}" placeholder="Type question prompt here..."
            oninput="onQuestionFieldChanged(${q.id})">${escapeHtml(q.question_text || '')}</textarea>
        </div>

        ${bodyHtml}
      </div>
    `;
  }).join('');
}

function onQuestionFieldChanged(questionId) {
  scheduleQuestionSave(questionId);
}

function onRadioCorrectChanged(questionId, selectedIdx) {
  const q = currentMcqQuestions.find((item) => item.id === questionId);
  if (q) {
    q.correct_index = selectedIdx;
  }
  for (let i = 0; i < 4; i++) {
    const row = document.getElementById(`mcq-opt-row-${questionId}-${i}`);
    if (row) {
      if (i === selectedIdx) row.classList.add('correct');
      else row.classList.remove('correct');
    }
  }
  scheduleQuestionSave(questionId);
}

function onMatchingCorrectChanged(questionId, selectedIdx) {
  const q = currentMcqQuestions.find((item) => item.id === questionId);
  const idx = parseInt(selectedIdx, 10);
  if (q) {
    q.correct_index = isNaN(idx) ? 0 : idx;
  }
  const count = q && Array.isArray(q.options) ? q.options.length : 4;
  for (let i = 0; i < count; i++) {
    const row = document.getElementById(`mcq-opt-row-${questionId}-${i}`);
    if (row) {
      if (i === idx) row.classList.add('correct');
      else row.classList.remove('correct');
    }
  }
  scheduleQuestionSave(questionId);
}

function scheduleQuestionSave(questionId) {
  showAutoSaveIndicator('saving');

  if (mcqAutoSaveTimers[questionId]) {
    clearTimeout(mcqAutoSaveTimers[questionId]);
  }

  mcqAutoSaveTimers[questionId] = setTimeout(() => {
    executeQuestionSave(questionId);
  }, 600);
}

async function executeQuestionSave(questionId) {
  if (!currentMcqTestId) return;

  const textEl = document.getElementById(`mcq-q-text-${questionId}`);
  const pointsEl = document.getElementById(`mcq-q-points-${questionId}`);
  if (!textEl) return;

  const question_text = textEl.value.trim();
  const points = Math.max(0, parseFloat(pointsEl?.value || '1') || 1);

  const q = currentMcqQuestions.find((item) => item.id === questionId);
  const qType = q?.question_type || 'mcq';

  let options = [];
  let correct_index = null;
  let acceptable_answers = [];

  if (qType === 'fill_blank') {
    const accEl = document.getElementById(`mcq-q-acceptable-${questionId}`);
    const rawAcc = accEl ? accEl.value : '';
    acceptable_answers = rawAcc.split(',').map((s) => s.trim()).filter(Boolean);
    options = [];
    correct_index = null;
  } else if (qType === 'matching') {
    const existingCount = Array.isArray(q?.options) ? q.options.length : 4;
    for (let i = 0; i < existingCount; i++) {
      const optEl = document.getElementById(`mcq-opt-input-${questionId}-${i}`);
      if (optEl) {
        options.push(optEl.value.trim());
      }
    }
    const selEl = document.getElementById(`mcq-matching-select-${questionId}`);
    const selVal = selEl ? parseInt(selEl.value, 10) : 0;
    correct_index = isNaN(selVal) ? 0 : selVal;
  } else {
    // 'mcq'
    const qNumMatch = (q?.question_text || '').match(/(?:^|\s|\b)(?:question\s*)?([1-9]\d?)\b/i);
    const qNum = qNumMatch ? parseInt(qNumMatch[1], 10) : (currentMcqQuestions.findIndex(x => x.id === questionId) + 1);
    const isPart1 = qNum <= 5;
    const isVisual = isPart1 && Array.isArray(q?.options) && q.options.some(o => typeof o === 'object' && o !== null && (o.type === 'image' || o.image_url));
    const optCount = isPart1 ? (Array.isArray(q?.options) ? q.options.length : 3) : 3;
    for (let i = 0; i < optCount; i++) {
      const optEl = document.getElementById(`mcq-opt-input-${questionId}-${i}`);
      const val = optEl ? optEl.value.trim() : '';
      if (isVisual) {
        const orig = q.options[i] || {};
        options.push({
          type: 'image',
          label: orig.label || optionLetters[i] || String.fromCharCode(65 + i),
          image_url: orig.image_url || '',
          object_key: orig.object_key || null,
          caption: val
        });
      } else {
        options.push(val);
      }
    }
    const radios = document.getElementsByName(`mcq-correct-${questionId}`);
    correct_index = 0;
    for (let i = 0; i < radios.length; i++) {
      if (radios[i].checked) {
        correct_index = i;
        break;
      }
    }
  }

  if (q) {
    q.question_text = question_text;
    q.options = options;
    q.correct_index = correct_index;
    q.acceptable_answers = acceptable_answers;
    q.points = points;
  }

  try {
    const res = await fetch(`/api/mcq/${currentMcqTestId}/questions/${questionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question_type: qType,
        question_text,
        options,
        correct_index,
        acceptable_answers,
        points
      })
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      console.warn('Auto-save error:', data.error);
      showAutoSaveIndicator('error');
    } else {
      showAutoSaveIndicator('saved');
    }
  } catch (err) {
    console.error('Auto-save network error:', err);
    showAutoSaveIndicator('error');
  }
}

function showAutoSaveIndicator(status) {
  const indicator = document.getElementById('mcq-autosave-indicator');
  if (!indicator) return;

  if (status === 'saving') {
    indicator.style.display = 'inline';
    indicator.style.color = '#D97706';
    indicator.textContent = 'Saving...';
  } else if (status === 'saved') {
    indicator.style.display = 'inline';
    indicator.style.color = '#059669';
    indicator.textContent = '✓ Saved';
    setTimeout(() => {
      if (indicator.textContent === '✓ Saved') {
        indicator.style.display = 'none';
      }
    }, 2000);
  } else if (status === 'error') {
    indicator.style.display = 'inline';
    indicator.style.color = '#DC2626';
    indicator.textContent = '⚠️ Save error';
  }
}

async function addBlankMcqQuestion() {
  if (!currentMcqTestId) return;

  try {
    const res = await fetch(`/api/mcq/${currentMcqTestId}/questions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to add question.');
    }

    currentMcqQuestions.push(data.question);
    renderMcqEditor();
    showToast('New question added!');

    const newCard = document.getElementById(`mcq-q-card-${data.question.id}`);
    if (newCard) newCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (err) {
    alert('Failed to add question: ' + err.message);
  }
}

async function deleteMcqQuestion(questionId) {
  if (!currentMcqTestId) return;

  const confirmed = await showConfirmModal('Are you sure you want to delete this question?');
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/mcq/${currentMcqTestId}/questions/${questionId}`, {
      method: 'DELETE'
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to delete question.');
    }

    currentMcqQuestions = currentMcqQuestions.filter((q) => q.id !== questionId);
    renderMcqEditor();
    showToast('Question deleted.');
  } catch (err) {
    alert('Failed to delete question: ' + err.message);
  }
}

async function publishMcqTest() {
  if (!currentMcqTestId) return;

  // Flush any pending auto-saves first
  for (const q of currentMcqQuestions) {
    if (mcqAutoSaveTimers[q.id]) {
      clearTimeout(mcqAutoSaveTimers[q.id]);
      await executeQuestionSave(q.id);
    }
  }

  if (currentMcqQuestions.length === 0) {
    alert('Cannot publish test without any questions. Please add at least one question.');
    return;
  }

  for (let i = 0; i < currentMcqQuestions.length; i++) {
    const q = currentMcqQuestions[i];
    const qType = q.question_type || 'mcq';

    if (!q.question_text || !q.question_text.trim()) {
      alert(`Cannot publish: Question #${i + 1} has an empty question prompt.`);
      const textEl = document.getElementById(`mcq-q-text-${q.id}`);
      if (textEl) textEl.focus();
      return;
    }

    if (qType === 'fill_blank') {
      const acceptable = Array.isArray(q.acceptable_answers) ? q.acceptable_answers : [];
      if (acceptable.length === 0 || !acceptable.some((a) => a && a.trim())) {
        alert(`Cannot publish: Question #${i + 1} (Fill in the Blank) must have at least 1 acceptable answer.`);
        const accEl = document.getElementById(`mcq-q-acceptable-${q.id}`);
        if (accEl) accEl.focus();
        return;
      }
    } else {
      const opts = Array.isArray(q.options) ? q.options : [];
      if (opts.length < 2) {
        alert(`Cannot publish: Question #${i + 1} must have at least 2 options.`);
        return;
      }

      for (let j = 0; j < opts.length; j++) {
        if (!opts[j] || !opts[j].trim()) {
          alert(`Cannot publish: Question #${i + 1}, Option ${String.fromCharCode(65 + j)} is empty.`);
          const optEl = document.getElementById(`mcq-opt-input-${q.id}-${j}`);
          if (optEl) optEl.focus();
          return;
        }
      }

      if (q.correct_index === null || q.correct_index === undefined || q.correct_index < 0 || q.correct_index >= opts.length) {
        alert(`Cannot publish: Question #${i + 1} does not have a correct answer selected.`);
        return;
      }
    }
  }

  const btn1 = document.getElementById('mcq-publish-btn');
  const btn2 = document.getElementById('mcq-publish-btn-bottom');
  if (btn1) btn1.disabled = true;
  if (btn2) btn2.disabled = true;

  try {
    const res = await fetch(`/api/mcq/${currentMcqTestId}/publish`, {
      method: 'POST'
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || 'Failed to publish test.');
    }

    const statusEl = document.getElementById('mcq-review-status');
    if (statusEl) {
      statusEl.className = 'pill-badge pill-green';
      statusEl.textContent = 'Published';
    }

    const linkBox = document.getElementById('mcq-published-link-box');
    const linkText = document.getElementById('mcq-published-link-url');
    if (linkText) linkText.textContent = data.link;
    if (linkBox) {
      linkBox.style.display = 'flex';
      linkBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    setPublishButtonsState(true);
    showToast('Test published successfully!');
  } catch (err) {
    alert('Failed to publish test: ' + err.message);
    if (btn1) btn1.disabled = false;
    if (btn2) btn2.disabled = false;
  }
}

function setPublishButtonsState(isPublished) {
  const btn1 = document.getElementById('mcq-publish-btn');
  const btn2 = document.getElementById('mcq-publish-btn-bottom');
  if (isPublished) {
    if (btn1) { btn1.textContent = '✓ Published'; btn1.disabled = true; }
    if (btn2) { btn2.textContent = '✓ Published'; btn2.disabled = true; }
  } else {
    if (btn1) { btn1.textContent = '🚀 Publish Test Link'; btn1.disabled = false; }
    if (btn2) { btn2.textContent = '🚀 Publish Test Link'; btn2.disabled = false; }
  }
}

function copyMcqPublishedLink() {
  const linkText = document.getElementById('mcq-published-link-url')?.textContent;
  if (!linkText) return;
  navigator.clipboard.writeText(linkText).then(() => {
    showToast('Shareable test link copied to clipboard!');
  }).catch(() => {
    alert('Copied link: ' + linkText);
  });
}

function resetMcqCreationForm() {
  currentMcqTestId = null;
  currentMcqTestData = null;
  currentMcqQuestions = [];
  mcqPdfFile = null;
  mcqSchemeFiles = [];
  mcqAudioFile = null;

  const titleInp = document.getElementById('mcq-title-input');
  if (titleInp) titleInp.value = '';
  const schemeTxt = document.getElementById('mcq-scheme-text');
  if (schemeTxt) schemeTxt.value = '';
  const maxPlays = document.getElementById('mcq-max-plays');
  if (maxPlays) maxPlays.value = '0';

  renderMcqPdfBadge();
  renderMcqSchemeBadges();
  renderMcqAudioBadge();

  document.getElementById('mcq-create-card').style.display = 'block';
  document.getElementById('mcq-review-card').style.display = 'none';
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initMcqFileHandlers);
} else {
  initMcqFileHandlers();
}
