let mode = 'login';

const authForm = document.getElementById('auth-form');
const forgotPane = document.getElementById('forgot-pane');
const nameGroup = document.getElementById('name-group');
const authTitle = document.getElementById('auth-title');
const submitBtn = document.getElementById('submit-btn');
const authMsg = document.getElementById('auth-msg');
const tabContainer = document.getElementById('tab-container');
const forgotLinkWrap = document.getElementById('forgot-link-wrap');
const googleSection = document.getElementById('google-section');
const passwordInput = document.getElementById('password');
const regPasswordMeter = document.getElementById('reg-password-meter');

function evaluatePassword(pwd) {
  const rules = {
    len: pwd.length >= 8,
    num: /[0-9]/.test(pwd),
    upper: /[A-Z]/.test(pwd),
    lower: /[a-z]/.test(pwd),
    spec: /[^A-Za-z0-9]/.test(pwd)
  };

  let passedCount = 0;
  for (const [key, passed] of Object.entries(rules)) {
    const el = document.getElementById(`rule-${key}`);
    if (el) {
      if (passed) {
        el.className = 'valid';
        el.querySelector('.rule-icon').textContent = '✓';
        passedCount++;
      } else {
        el.className = pwd.length > 0 ? 'invalid' : '';
        el.querySelector('.rule-icon').textContent = pwd.length > 0 ? '✕' : '○';
      }
    }
  }

  const fillEl = document.getElementById('reg-meter-fill');
  const textEl = document.getElementById('reg-strength-text');
  const strengthPct = (passedCount / 5) * 100;
  fillEl.style.width = `${strengthPct}%`;

  if (passedCount <= 2) {
    fillEl.style.backgroundColor = '#DC2626';
    textEl.textContent = pwd.length ? 'Weak' : '—';
    textEl.style.color = '#DC2626';
  } else if (passedCount === 3 || passedCount === 4) {
    fillEl.style.backgroundColor = '#D97706';
    textEl.textContent = 'Medium';
    textEl.style.color = '#D97706';
  } else {
    fillEl.style.backgroundColor = '#059669';
    textEl.textContent = 'Strong';
    textEl.style.color = '#059669';
  }

  return passedCount === 5;
}

passwordInput.addEventListener('input', (e) => {
  if (mode === 'register') evaluatePassword(e.target.value);
});

function switchMode(newMode) {
  mode = newMode;
  authMsg.className = 'msg';
  authMsg.style.display = 'none';

  authForm.style.display = (mode === 'login' || mode === 'register') ? 'block' : 'none';
  forgotPane.style.display = (mode === 'forgot') ? 'block' : 'none';
  tabContainer.style.display = (mode === 'login' || mode === 'register') ? 'flex' : 'none';

  if (mode === 'register') {
    document.getElementById('tab-register').classList.add('active');
    document.getElementById('tab-login').classList.remove('active');
    nameGroup.style.display = 'block';
    forgotLinkWrap.style.display = 'none';
    googleSection.style.display = 'block';
    regPasswordMeter.style.display = 'block';
    authTitle.textContent = 'Create Teacher Account';
    submitBtn.textContent = 'Create Account';
    passwordInput.setAttribute('autocomplete', 'new-password');
    evaluatePassword(passwordInput.value);
  } else if (mode === 'login') {
    document.getElementById('tab-login').classList.add('active');
    document.getElementById('tab-register').classList.remove('active');
    nameGroup.style.display = 'none';
    forgotLinkWrap.style.display = 'flex';
    googleSection.style.display = 'block';
    regPasswordMeter.style.display = 'none';
    authTitle.textContent = 'Sign In to Dashboard';
    submitBtn.textContent = 'Sign In';
    passwordInput.setAttribute('autocomplete', 'current-password');
  } else if (mode === 'forgot') {
    authTitle.textContent = 'Password Recovery';
  }
}

window.handleGoogleCredentialResponse = async function(response) {
  authMsg.className = 'msg success';
  authMsg.style.display = 'block';
  authMsg.textContent = 'Verifying credentials...';
  submitBtn.disabled = true;

  if (!response || !response.credential) {
    authMsg.className = 'msg error';
    authMsg.textContent = 'Google did not return a valid credential token.';
    submitBtn.disabled = false;
    return;
  }

  try {
    const res = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: response.credential })
    });

    const data = await res.json();
    if (data.success) {
      authMsg.className = 'msg success';
      authMsg.textContent = 'Google sign-in successful! Redirecting...';
      window.location.replace('/index.html');
    } else {
      authMsg.className = 'msg error';
      authMsg.textContent = data.error || 'Google Sign-In failed on server.';
      submitBtn.disabled = false;
    }
  } catch (err) {
    authMsg.className = 'msg error';
    authMsg.textContent = 'Network connection error during Google authentication.';
    submitBtn.disabled = false;
  }
};

window.onload = async () => {
  try {
    const res = await fetch('/api/auth/config');
    const { googleClientId } = await res.json();

    if (googleClientId && window.google && window.google.accounts) {
      google.accounts.id.initialize({
        client_id: googleClientId,
        callback: window.handleGoogleCredentialResponse,
        ux_mode: 'popup',
        auto_select: false,
        cancel_on_tap_outside: true,
        itp_support: true
      });

      google.accounts.id.renderButton(
        document.getElementById('google-btn'),
        { 
          type: 'standard',
          theme: 'outline', 
          size: 'large', 
          width: 370, 
          text: 'continue_with',
          shape: 'rectangular'
        }
      );
    }
  } catch (err) {
    console.error('Google Auth configuration load error:', err);
  }
};

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  authMsg.className = 'msg';
  authMsg.style.display = 'none';

  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const name = document.getElementById('name').value.trim();

  if (mode === 'register' && !evaluatePassword(password)) {
    authMsg.className = 'msg error';
    authMsg.textContent = 'Please satisfy all 5 password security requirements.';
    return;
  }

  submitBtn.disabled = true;
  const endpoint = mode === 'register' ? '/api/auth/register' : '/api/auth/login';
  const payload = mode === 'register' ? { name, email, password } : { email, password };

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (data.success) {
      authMsg.className = 'msg success';
      authMsg.textContent = mode === 'register' ? 'Account created! Redirecting...' : 'Success! Logging in...';
      setTimeout(() => { window.location.replace('/index.html'); }, 600);
    } else {
      authMsg.className = 'msg error';
      authMsg.textContent = data.error || 'Authentication failed.';
      submitBtn.disabled = false;
    }
  } catch (err) {
    authMsg.className = 'msg error';
    authMsg.textContent = 'Connection error. Please try again.';
    submitBtn.disabled = false;
  }
});
