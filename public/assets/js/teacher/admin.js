// ==========================================
// ADMIN.JS - User Management & Authorization
// ==========================================

var activeResetUserId = null;
var activeResetUserEmail = '';

// Admin Modals
function openAdminModal() {
  document.getElementById('admin-modal').style.display = 'flex';
  loadAdminUsers();
}
function closeAdminModal() {
  document.getElementById('admin-modal').style.display = 'none';
}

async function loadAdminUsers() {
  const tbody = document.getElementById('admin-users-list');
  tbody.innerHTML = '<tr><td colspan="4">Loading users...</td></tr>';
  try {
    const res = await fetch('/api/admin/users');
    const data = await res.json();
    if (data.success) {
      tbody.innerHTML = '';
      data.users.forEach(u => {
        const isSelf = currentUser && currentUser.id === u.id;
        const isRoot = u.role === 'root';
        const tr = document.createElement('tr');
        
        let roleBadge = `<span class="role-teacher">Teacher</span>`;
        if (u.role === 'root') roleBadge = `<span class="role-root">👑 Root</span>`;
        else if (u.role === 'admin') roleBadge = `<span class="role-admin">Admin</span>`;

        tr.innerHTML = `
          <td><b>${u.name}</b><br><small>${u.email}</small></td>
          <td>${roleBadge}</td>
          <td>
            <span style="font-weight:600; text-transform:uppercase; font-size:11px; color:${u.status === 'approved' ? '#059669' : '#D97706'}">
              ${u.status}
            </span>
          </td>
          <td>
            ${!isRoot && u.status !== 'approved' ? `<button class="btn-approve" onclick="setUserStatus(${u.id}, 'approved')">Approve</button>` : ''}
            ${!isRoot && u.status === 'approved' && u.role !== 'admin' ? `<button class="btn-reject" onclick="setUserStatus(${u.id}, 'rejected')">Revoke</button>` : ''}
            <button class="admin-btn" style="padding:3px 7px; font-size:11px; font-weight:600;" onclick="openAdminResetModal(${u.id}, '${escapeHtml(u.email).replace(/'/g, "\\'")}')">🔑 Set Password</button>
            ${!isRoot && !isSelf ? (u.role === 'admin' 
           ? `<button class="admin-btn" style="padding:3px 7px; font-size:11px;" onclick="toggleUserRole(${u.id}, 'teacher')">Demote</button>` 
            : `<button class="admin-btn" style="padding:3px 7px; font-size:11px;" onclick="toggleUserRole(${u.id}, 'admin')">Make Admin</button>`
            ) : ''}
            ${!isRoot && !isSelf ? `<button class="btn-delete" onclick="deleteUser(${u.id}, '${escapeHtml(u.email).replace(/'/g, "\\'")}')">Delete</button>` : ''}
          </td>
        `;
        tbody.appendChild(tr);
      });
    }
  } catch(e) {
    tbody.innerHTML = '<tr><td colspan="4">Error loading users.</td></tr>';
  }
}

function openAdminResetModal(userId, email) {
  activeResetUserId = userId;
  activeResetUserEmail = email;
  document.getElementById('reset-modal-target-email').textContent = email;
  const input = document.getElementById('admin-temp-pass-input');
  input.value = 'EduPlanet' + Math.floor(100 + Math.random() * 900) + '!';
  
  const msgEl = document.getElementById('admin-reset-modal-msg');
  msgEl.style.display = 'none';
  document.getElementById('admin-reset-modal').style.display = 'flex';
}

function closeAdminResetModal() {
  document.getElementById('admin-reset-modal').style.display = 'none';
  activeResetUserId = null;
  activeResetUserEmail = '';
}

function generateRandomAdminPass() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  let result = 'Edu';
  for (let i = 0; i < 6; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  result += '!';
  document.getElementById('admin-temp-pass-input').value = result;
}

async function executeAdminPasswordReset() {
  const input = document.getElementById('admin-temp-pass-input');
  const msgEl = document.getElementById('admin-reset-modal-msg');
  const btn = document.getElementById('admin-confirm-reset-btn');
  const newPass = input.value.trim();

  if (newPass.length < 8) {
    msgEl.style.display = 'block';
    msgEl.style.background = '#FDE8E8';
    msgEl.style.color = '#9B1C1C';
    msgEl.textContent = 'Password must be at least 8 characters long.';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const res = await fetch(`/api/admin/users/${activeResetUserId}/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newPassword: newPass })
    });
    const data = await res.json();

    btn.disabled = false;
    btn.textContent = 'Save & Update';

    if (data.success) {
      navigator.clipboard.writeText(newPass);
      showToast(`Password updated and copied: ${newPass}`);
      closeAdminResetModal();
    } else {
      msgEl.style.display = 'block';
      msgEl.style.background = '#FDE8E8';
      msgEl.style.color = '#9B1C1C';
      msgEl.textContent = data.error || 'Failed to update password.';
    }
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Save & Update';
    msgEl.style.display = 'block';
    msgEl.style.background = '#FDE8E8';
    msgEl.style.color = '#9B1C1C';
    msgEl.textContent = 'Connection error updating password.';
  }
}

async function setUserStatus(userId, status) {
  const res = await fetch(`/api/admin/users/${userId}/status`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ status })
  });
  const data = await res.json();
  if (!data.success) {
    alert(data.error || 'Action failed.');
  } else {
    showToast(data.message || `Account updated to ${status}.`);
  }
  loadAdminUsers();
}

async function toggleUserRole(userId, newRole) {
  try {
    const res = await fetch(`/api/admin/users/${userId}/role`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: newRole })
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message || `User role changed to ${newRole}.`);
      loadAdminUsers();
    } else {
      alert(data.error || 'Failed to update user role.');
    }
  } catch (err) {
    alert('Connection error updating user role.');
  }
}

async function deleteUser(userId, userEmail) {
  const confirmed = await showConfirmModal(`Are you sure you want to permanently delete the account for ${userEmail}?`, 'Delete Account');
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/admin/users/${userId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast(`User ${userEmail} has been deleted successfully.`);
      loadAdminUsers();
    } else {
      alert(data.error || 'Failed to delete account.');
    }
  } catch (err) {
    alert('Connection error deleting user.');
  }
}

