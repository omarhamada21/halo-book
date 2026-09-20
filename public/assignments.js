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
    document.getElementById('bundle-task-tabs').style.display = 'none';
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
