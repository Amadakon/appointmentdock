import { api, h, money, duration, fmtDay, fmtTime, setBrand, addDays, errorBox, formData } from './common.js';

const app = document.getElementById('app');
const slug = location.pathname.split('/').filter(Boolean).pop();
const S = { step: 1, services: [], staff: 'any', date: null, slot: null, month: null, days: null, slots: null };
let D; // business data

async function main() {
  try { D = await api('api/public/' + encodeURIComponent(slug)); }
  catch (e) {
    app.replaceChildren(h('main.narrow', h('div.card', { style: { marginTop: '48px' } }, h('h1', 'Booking page not found'), h('p.muted', e.message))));
    return;
  }
  setBrand(D.business.brand_color);
  document.title = `Book · ${D.business.name}`;
  S.month = D.today.slice(0, 7);
  render();
}

const B = () => D.business;
const chosen = () => S.services.map((id) => D.services.find((s) => s.id === id)).filter(Boolean);
const totalMin = () => chosen().reduce((t, s) => t + s.duration_min, 0);
const totalCents = () => chosen().reduce((t, s) => t + s.price_cents, 0);
const staffFor = () => D.staff.filter((st) => S.services.every((id) => st.service_ids.includes(id)));
const staffName = (id) => (D.staff.find((s) => s.id === id) || {}).name;

function go(step) { S.step = step; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); }

function render() {
  const b = B();
  const steps = h('div.steps', [1, 2, 3, 4].map((i) => h('span', { class: i <= S.step ? 'on' : '' })));
  let body, bar = null;
  if (S.step === 1) [body, bar] = stepServices();
  else if (S.step === 2) [body, bar] = stepStaff();
  else if (S.step === 3) [body, bar] = stepTime();
  else if (S.step === 4) [body, bar] = stepDetails();
  else body = S.doneView;
  app.replaceChildren(
    h('div.hero', h('div.narrow',
      h('h1', b.name),
      h('p', [b.address, b.phone].filter(Boolean).join(' · ')))),
    h('main.narrow.book-main', h('div.card', S.step <= 4 ? steps : null, body)),
    bar ? h('div.bar', h('div.narrow', bar)) : null,
  );
}

function summaryLine() {
  if (!S.services.length) return h('span.muted', 'Pick one or more services');
  return h('div', h('b', money(totalCents())), h('span.muted', ` · ${duration(totalMin())}`));
}

function stepServices() {
  const groups = new Map();
  for (const s of D.services) {
    const k = s.category || '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const list = [];
  for (const [cat, items] of groups) {
    if (cat) list.push(h('div.cat', cat));
    for (const s of items) {
      const on = S.services.includes(s.id);
      list.push(h('button.option', {
        type: 'button', class: on ? 'selected' : '', 'aria-pressed': String(on),
        onclick: () => {
          S.services = on ? S.services.filter((x) => x !== s.id) : [...S.services, s.id];
          S.slot = null; S.date = null; S.days = null;
          if (S.staff !== 'any' && !staffFor().some((st) => st.id === S.staff)) S.staff = 'any';
          render();
        },
      },
      h('span.tick'),
      h('span.grow', h('b', s.name), h('div.small.muted', duration(s.duration_min), s.description ? ` · ${s.description}` : '')),
      h('span.price', money(s.price_cents))));
    }
  }
  const body = h('div',
    h('h2', 'Choose services'),
    h('p.muted.small', 'You can pick more than one.'),
    D.services.length ? list : h('p.empty', 'No services are bookable online yet.'),
    B().about ? h('p.small.muted', { style: { marginTop: '16px' } }, B().about) : null);
  const bar = [summaryLine(), h('span.spacer'),
    h('button.btn.primary', { disabled: !S.services.length, onclick: () => go(2) }, 'Continue')];
  return [body, bar];
}

function stepStaff() {
  const staff = staffFor();
  const opt = (id, name, sub) => h('button.option.radio', {
    type: 'button', class: S.staff === id ? 'selected' : '',
    onclick: () => { S.staff = id; S.slot = null; S.date = null; S.days = null; render(); },
  }, h('span.tick'), id === 'any' ? h('span.avatar', '★') : h('span.avatar', name[0]), h('span.grow', h('b', name), sub ? h('div.small.muted', sub) : null));
  const body = h('div',
    h('h2', 'Who would you like?'),
    staff.length ? [
      opt('any', 'Anyone available', 'Most open times'),
      ...staff.map((st) => opt(st.id, st.name, [st.title, st.bio].filter(Boolean).join(' · '))),
    ] : h('div.alert.info', 'Nobody offers that exact combination of services. Go back and try fewer services.'));
  const bar = [h('button.btn', { onclick: () => go(1) }, 'Back'), h('span.spacer'),
    h('button.btn.primary', { disabled: !staff.length, onclick: () => go(3) }, 'Continue')];
  return [body, bar];
}

function query() {
  return `services=${S.services.join(',')}&staff=${S.staff}`;
}

async function loadDays() {
  const first = `${S.month}-01`;
  const [y, m] = S.month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  S.days = null;
  try {
    const r = await api(`api/public/${slug}/days?${query()}&from=${first}&days=${daysInMonth}`);
    S.days = new Set(r.days);
    S.daysErr = null;
    if (!S.date) {
      // Jump to the first open day; if none this month, try next month once.
      const firstOpen = r.days[0];
      if (firstOpen) { S.date = firstOpen; loadSlots(); }
      else if (!S.autoAdvanced && S.month === D.today.slice(0, 7)) { S.autoAdvanced = true; S.month = addDays(`${S.month}-01`, daysInMonth).slice(0, 7); return loadDays(); }
    }
  } catch (e) { S.days = new Set(); S.daysErr = e; }
  if (S.step === 3) render();
}

async function loadSlots() {
  S.slots = null;
  if (S.step === 3) render();
  try {
    const r = await api(`api/public/${slug}/slots?${query()}&date=${S.date}`);
    S.slots = r.slots;
  } catch (e) { S.slots = []; S.daysErr = e; }
  if (S.step === 3) render();
}

function stepTime() {
  const tz = B().timezone;
  if (S.days === null && !S.loading) { S.loading = true; loadDays().finally(() => { S.loading = false; }); }
  const [y, m] = S.month.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const monthLabel = first.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const thisMonth = D.today.slice(0, 7);
  const lastMonth = addDays(D.today, B().window_days).slice(0, 7);
  const shift = (n) => {
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    S.month = d.toISOString().slice(0, 7); S.days = null; render();
  };

  const cells = ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => h('div.dow', d));
  for (let i = 0; i < first.getUTCDay(); i++) cells.push(h('span'));
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${S.month}-${String(d).padStart(2, '0')}`;
    const avail = S.days && S.days.has(date);
    cells.push(h('button', {
      type: 'button', disabled: !avail, 'aria-label': date,
      class: [avail ? 'avail' : '', S.date === date ? 'sel' : '', date === D.today ? 'today' : ''].join(' '),
      onclick: () => { S.date = date; S.slot = null; loadSlots(); },
    }, d));
  }

  let slotsView;
  if (!S.date) slotsView = S.days && !S.days.size ? h('p.muted', 'No openings this month. Try the next month.') : null;
  else if (S.slots === null) slotsView = h('p.muted', 'Loading times…');
  else if (!S.slots.length) slotsView = h('p.muted', 'No times left on this day.');
  else {
    const groups = [['Morning', (x) => x < 12], ['Afternoon', (x) => x >= 12 && x < 17], ['Evening', (x) => x >= 17]];
    const hourOf = (ms) => Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date(ms)));
    slotsView = groups.map(([label, test]) => {
      const list = S.slots.filter((s) => test(hourOf(s.start)));
      if (!list.length) return null;
      return [h('div.cat', label), h('div.slots', list.map((s) => h('button', {
        type: 'button', class: S.slot && S.slot.start === s.start ? 'sel' : '',
        onclick: () => { S.slot = s; render(); },
      }, fmtTime(s.start, tz))))];
    });
  }

  const err = h('div');
  if (S.daysErr) errorBox(err, S.daysErr);
  const body = h('div',
    h('h2', 'Pick a time'),
    err,
    h('div.cal-head',
      h('button.btn.small', { disabled: S.month <= thisMonth, onclick: () => shift(-1), 'aria-label': 'Previous month' }, '‹'),
      h('b', monthLabel),
      h('button.btn.small', { disabled: S.month >= lastMonth, onclick: () => shift(1), 'aria-label': 'Next month' }, '›')),
    h('div.cal', cells),
    S.days === null ? h('p.muted.small', 'Checking availability…') : null,
    S.date ? h('h3', { style: { marginTop: '20px' } }, fmtDay(Date.parse(S.date + 'T12:00:00Z'), 'UTC')) : null,
    slotsView,
    h('p.small.muted', { style: { marginTop: '16px' } }, `Times shown in ${tz.replace('_', ' ')}.`));
  const bar = [h('button.btn', { onclick: () => go(2) }, 'Back'), h('span.spacer'),
    h('button.btn.primary', { disabled: !S.slot, onclick: () => go(4) }, 'Continue')];
  return [body, bar];
}

function stepDetails() {
  const tz = B().timezone;
  const me = D.me || {};
  const err = h('div');
  const staffLabel = S.staff === 'any'
    ? (S.slot.staffIds.length === 1 ? staffName(S.slot.staffIds[0]) : 'First available')
    : staffName(S.staff);
  const form = h('form.stack', {
    onsubmit: async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = 'Booking…';
      const d = formData(form);
      try {
        const r = await api(`api/public/${slug}/book`, {
          method: 'POST',
          body: { services: S.services, staff: S.staff, start: S.slot.start, name: d.name, email: d.email, phone: d.phone, notes: d.notes, password: d.make_account ? d.password : '' },
        });
        S.doneView = doneView(r);
        go(5);
      } catch (x) {
        errorBox(err, x);
        btn.disabled = false; btn.textContent = 'Confirm booking';
        if (x.status === 409) { S.slot = null; S.days = null; S.slots = null; }
      }
    },
  },
  h('h2', 'Your details'),
  h('div.summary.stack',
    h('div', h('span.muted', 'When'), h('b', `${fmtDay(S.slot.start, tz)}, ${fmtTime(S.slot.start, tz)}`)),
    h('div', h('span.muted', 'With'), h('b', staffLabel)),
    ...chosen().map((s) => h('div', h('span', s.name), h('span', money(s.price_cents)))),
    h('div', h('b', 'Total'), h('b', money(totalCents())))),
  err,
  h('div', h('label', { for: 'f-name' }, 'Name'), h('input', { id: 'f-name', name: 'name', autocomplete: 'name', required: true, value: me.name || '' })),
  h('div.grid2',
    h('div', h('label', { for: 'f-email' }, 'Email'), h('input', { id: 'f-email', name: 'email', type: 'email', autocomplete: 'email', required: true, value: me.email || '' })),
    h('div', h('label', { for: 'f-phone' }, 'Mobile phone'), h('input', { id: 'f-phone', name: 'phone', type: 'tel', autocomplete: 'tel', value: me.phone || '' }), h('div.hint', 'For text confirmations and reminders.'))),
  h('div', h('label', { for: 'f-notes' }, 'Notes (optional)'), h('textarea', { id: 'f-notes', name: 'notes', maxLength: 1000, placeholder: 'Anything we should know?' })),
  D.me ? null : accountBox(),
  h('button.btn.primary.block', { type: 'submit' }, 'Confirm booking'),
  h('p.small.muted', `Free cancellation up to ${B().cancel_hours} hours before.`));
  const bar = [h('button.btn', { onclick: () => go(3) }, 'Back'), h('span.spacer'), summaryLine()];
  return [form, bar];
}

function accountBox() {
  const pw = h('div.hidden', h('label', 'Choose a password'), h('input', { name: 'password', type: 'password', minLength: 10, autocomplete: 'new-password' }), h('div.hint', 'At least 10 characters.'));
  return h('div',
    h('label.check', h('input', { type: 'checkbox', name: 'make_account', onchange: (e) => pw.classList.toggle('hidden', !e.target.checked) }), 'Create an account to manage my bookings'),
    pw);
}

function doneView(r) {
  const tz = B().timezone;
  return h('div',
    h('div.done-icon', '✓'),
    h('h2', "You're booked!"),
    h('p', `${fmtDay(r.start, tz)} at ${fmtTime(r.start, tz)} with ${r.staff}.`),
    h('p.muted', 'A confirmation is on its way. You can view or cancel any time from the link in it.'),
    r.account === 'exists' ? h('p.small.muted', 'You already have an account with that email. Sign in to see this booking.') : null,
    h('div.row',
      h('a.btn.primary', { href: `m/${r.token}` }, 'View appointment'),
      h('a.btn', { href: `b/${slug}` }, 'Book another')));
}

main();
