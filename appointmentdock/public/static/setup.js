import { api, h, formData, errorBox } from './common.js';

const box = document.getElementById('box');
const token = new URLSearchParams(location.search).get('token') || '';

async function verify() {
  try {
    await api('api/auth/verify', { method: 'POST', body: { token } });
    box.replaceChildren(h('h1', 'Email confirmed'), h('p.muted', 'Your bookings will now show up in your account.'), h('a.btn.primary', { href: 'dashboard' }, 'See my appointments'));
  } catch (e) {
    box.replaceChildren(h('h1', 'Link expired'), h('p.muted', e.message), h('a.btn', { href: 'dashboard' }, 'Go to my account'));
  }
}

async function main() {
  if (location.pathname.endsWith('/verify')) return verify();
  let info;
  try { info = await api('api/auth/token?token=' + encodeURIComponent(token)); }
  catch (e) {
    box.replaceChildren(h('h1', 'Link expired'), h('p.muted', e.message), h('a.btn', { href: 'login' }, 'Go to sign in'));
    return;
  }
  const err = h('div');
  const form = h('form.stack', {
    onsubmit: async (e) => {
      e.preventDefault();
      const d = formData(form);
      if (d.password !== d.confirm) return errorBox(err, new Error('Passwords do not match.'));
      try {
        await api('api/auth/token', { method: 'POST', body: { token, password: d.password, name: d.name } });
        location.href = 'dashboard';
      } catch (x) { errorBox(err, x); }
    },
  },
  h('h1', 'Set your password'),
  h('p.muted', 'Signing in as ', h('b', info.email)),
  err,
  !info.name || info.name === 'Platform admin' ? h('div', h('label', 'Your name'), h('input', { name: 'name', autocomplete: 'name' })) : null,
  h('div', h('label', 'New password'), h('input', { name: 'password', type: 'password', minLength: 10, autocomplete: 'new-password', required: true }), h('div.hint', 'At least 10 characters.')),
  h('div', h('label', 'Confirm password'), h('input', { name: 'confirm', type: 'password', autocomplete: 'new-password', required: true })),
  h('button.btn.primary.block', { type: 'submit' }, 'Save and continue'));
  box.replaceChildren(form);
}
main();
