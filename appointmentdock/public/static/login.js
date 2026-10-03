import { api, h, formData, errorBox, initTopnav } from './common.js';

const box = document.getElementById('box');
const params = new URLSearchParams(location.search);
const next = params.get('next');
const signup = location.pathname.endsWith('/signup');
initTopnav();

function done() {
  location.href = next && /^[a-z0-9/_-]+$/i.test(next) ? next : 'dashboard';
}

function loginForm() {
  const err = h('div');
  const form = h('form.stack', {
    onsubmit: async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try { await api('api/auth/login', { method: 'POST', body: formData(form) }); done(); }
      catch (x) { errorBox(err, x); btn.disabled = false; }
    },
  },
  h('h1', 'Sign in'),
  h('p.muted', 'Business owners, staff and customers all sign in here.'),
  err,
  h('div', h('label', { for: 'email' }, 'Email'), h('input', { id: 'email', name: 'email', type: 'email', autocomplete: 'email', required: true })),
  h('div', h('label', { for: 'pw' }, 'Password'), h('input', { id: 'pw', name: 'password', type: 'password', autocomplete: 'current-password', required: true })),
  h('button.btn.primary.block', { type: 'submit' }, 'Sign in'),
  h('p.small.muted', 'New customer? ', h('a', { href: 'signup' + location.search }, 'Create an account'), '. Forgot your password? Ask the business to send you a new link.'));
  box.replaceChildren(form);
}

function signupForm() {
  const err = h('div');
  const form = h('form.stack', {
    onsubmit: async (e) => {
      e.preventDefault();
      try { await api('api/auth/signup', { method: 'POST', body: formData(form) }); done(); }
      catch (x) { errorBox(err, x); }
    },
  },
  h('h1', 'Create your account'),
  h('p.muted', 'See and manage all of your bookings in one place.'),
  err,
  h('div', h('label', 'Name'), h('input', { name: 'name', autocomplete: 'name', required: true })),
  h('div', h('label', 'Email'), h('input', { name: 'email', type: 'email', autocomplete: 'email', required: true })),
  h('div', h('label', 'Mobile phone'), h('input', { name: 'phone', type: 'tel', autocomplete: 'tel' })),
  h('div', h('label', 'Password'), h('input', { name: 'password', type: 'password', minLength: 10, autocomplete: 'new-password', required: true }), h('div.hint', 'At least 10 characters.')),
  h('button.btn.primary.block', { type: 'submit' }, 'Create account'),
  h('p.small.muted', 'Already have one? ', h('a', { href: 'login' + location.search }, 'Sign in')));
  box.replaceChildren(form);
}

signup ? signupForm() : loginForm();
