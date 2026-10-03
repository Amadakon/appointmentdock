// Shared browser helpers. Pages use relative URLs; <base href> points at the app root.
export async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(path.replace(/^\//, ''), opts);
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Tiny element builder: h('div.card', {onclick}, child, 'text')
export function h(tag, attrs, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { children.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k in el && k !== 'list' && k !== 'form') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const money = (cents) => (cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);
export const duration = (min) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)} hr${min % 60 ? ` ${min % 60} min` : ''}`);

export function fmt(ms, tz, opts) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).format(new Date(ms));
}
export const fmtTime = (ms, tz) => fmt(ms, tz, { hour: 'numeric', minute: '2-digit' });
export const fmtDay = (ms, tz) => fmt(ms, tz, { weekday: 'long', month: 'long', day: 'numeric' });
export const fmtDateTime = (ms, tz) => fmt(ms, tz, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export function localDate(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export const minToTime = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export const timeToMin = (t) => { const [hh, mm] = t.split(':').map(Number); return hh * 60 + mm; };
export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function toast(msg) {
  const t = h('div.toast', msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

export function setBrand(color) {
  if (!color) return;
  document.documentElement.style.setProperty('--brand', color);
  // Pick readable text on the brand color.
  const n = parseInt(color.slice(1), 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  document.documentElement.style.setProperty('--brand-ink', lum > 0.62 ? '#111' : '#fff');
}

export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else out[el.name] = el.value;
  }
  return out;
}

export function errorBox(target, err) {
  target.replaceChildren(err ? h('div.alert.error', err.message || String(err)) : '');
}

export async function initTopnav() {
  const nav = document.getElementById('topnav');
  let me = { user: null };
  try { me = await api('api/me'); } catch { /* offline */ }
  if (!nav) return me;
  if (me.user) {
    nav.replaceChildren(h('div.row',
      h('a.btn.small', { href: 'dashboard' }, 'Dashboard'),
      h('button.btn.small', { onclick: async () => { await api('api/auth/logout', { method: 'POST', body: {} }); location.href = './'; } }, 'Sign out')));
  } else {
    nav.replaceChildren(h('a.btn.small', { href: 'login' }, 'Sign in'));
  }
  return me;
}
