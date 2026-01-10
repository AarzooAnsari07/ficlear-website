document.addEventListener('DOMContentLoaded', function () {
  // Check if already logged in
  fetch('/api/check-auth')
    .then(res => res.json())
    .then(data => {
      if (data.authenticated) {
        window.location.href = '/AdminDashboard.html';
      }
    })
    .catch(() => {
      // Not authenticated, continue with login page
    });

  // Login form submission
  const loginForm = document.getElementById('admin-login-form');
  if (loginForm) {
    loginForm.addEventListener('submit', function (e) {
      e.preventDefault();
      const username = document.getElementById('username').value;
      const password = document.getElementById('password').value;

      fetch('/api/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ username, password })
      })
        .then(res => res.json())
        .then(data => {
          if (data.success) {
            // Redirect to dashboard on successful login
            window.location.href = '/AdminDashboard.html';
          } else {
            alert('Login failed: ' + (data.error || 'Invalid credentials'));
          }
        })
        .catch(err => {
          alert('Login error: ' + err.message);
        });
    });
  }

  // Password toggle
  const toggle = document.getElementById('toggle-password');
  const password = document.getElementById('password');
  if (toggle && password) {
    toggle.addEventListener('click', function () {
      if (password.type === 'password') {
        password.type = 'text';
        toggle.textContent = 'Hide';
      } else {
        password.type = 'password';
        toggle.textContent = 'Show';
      }
    });
  }

  // Forgot password modal
  const forgotTrigger = document.getElementById('forgot-password-trigger');
  const forgotModal = document.getElementById('forgot-password-modal');
  const forgotCancel = document.getElementById('forgot-cancel');
  const forgotForm = document.getElementById('forgot-password-form');

  if (forgotTrigger && forgotModal) {
    forgotTrigger.addEventListener('click', function () {
      forgotModal.classList.remove('hidden');
      forgotModal.classList.add('flex');
      const emailInput = document.getElementById('reset-email');
      if (emailInput) emailInput.focus();
    });
  }

  if (forgotCancel && forgotModal) {
    forgotCancel.addEventListener('click', function () {
      forgotModal.classList.remove('flex');
      forgotModal.classList.add('hidden');
    });
  }

  if (forgotForm) {
    forgotForm.addEventListener('submit', function (e) {
      e.preventDefault();
      const email = document.getElementById('reset-email').value;
      alert('If an account exists for ' + email + ', a reset link has been sent.');
      forgotModal.classList.remove('flex');
      forgotModal.classList.add('hidden');
    });
  }
});
