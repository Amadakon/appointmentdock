import {
  api, h, money, duration, fmtDay, fmtTime, fmtDateTime, localDate, addDays, minToTime, timeToMin, DAYS,
  toast, setBrand, formData, errorBox, initTopnav,
} from './common.js';

const app = document.getElementById('app');
let ME;            // /api/me
let BIZ = null;    // business being managed
let view = null;

const isPlatform = () => ME.user.role === 'platform';
const isOwner = () => ME.user.role === 'owner' || isPlatform();
const bq = (path) => (isPlatform() && BIZ ? path + (path.includes('?') ? '&' : '?') + 'business=' + BIZ.id : path);
const bizApi = (path, opts) => api(bq(path), opts);

async function main() {
  ME = await initTopnav();
  if (!ME.user) { location.href = 'login?next=dashboard'; return; }
  if (ME.business) { BIZ = ME.business; setBrand(BIZ.brand_color); }
  const start = { platform: 'businesses', owner: 'appointments', staff: 'appointments', customer: 'mine' }[ME.user.role];
  show(new URLSearchParams(location.search).get('view') || start);
}

function nav() {
  const items = [];
  const btn = (id, label) => h('button', { class: view === id ? 'on' : '', onclick: () => show(id) }, label);
  if (isPlatform()) {
    items.push(h('div.label', 'Platform'), btn('businesses', 'Businesses'));
    if (BIZ) items.push(h('div.label', BIZ.name));
  }
  if (BIZ && ME.user.role !== 'customer') {
    items.push(btn('appointments', 'Appointments'));
    if (isOwner()) items.push(btn('services', 'Services'), btn('staff', 'Staff'), btn('customers', 'Customers'), btn('settings', 'Settings'), btn('messages', 'Message log'));
    else items.push(btn('myhours', 'My hours & time off'));
    items.push(h('a.btn.small', { href: `b/${BIZ.slug}`, target: '_blank', style: { margin: '12px' } }, 'Open booking page ↗'));
  }
  if (ME.user.role === 'customer') items.push(btn('mine', 'My appointments'));
  items.push(h('div.label', 'You'), btn('account', 'Account'));
  return h('nav.side', items);
}

async function show(id) {
  view = id;
  const main = h('section.main', h('p.muted', 'Loading…'));
  fill(app, h('div.dash', nav(), main));
  const views = { businesses, appointments, services, staff, customers, settings, messages, myhours, mine, account };
  try { await (views[id] || appointments)(main); }
  catch (e) { fill(main, h('div.alert.error', e.message)); }
}

function head(title, ...right) {
  return h('div.main-head', h('h1', title), h('span.spacer'), ...right);
}

function dialog(title, content, { onSubmit, submitLabel = 'Save', danger } = {}) {
  const err = h('div');
  const dlg = h('dialog');
  const close = () => { dlg.close(); dlg.remove(); };
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      if (!onSubmit) return close();
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try { const keep = await onSubmit(formData(form), form); if (!keep) close(); }
      catch (x) { errorBox(err, x); }
      btn.disabled = false;
    },
  },
  h('h2', title), err, content,
  h('div.dlg-actions',
    h('button.btn', { type: 'button', onclick: close }, onSubmit ? 'Cancel' : 'Close'),
    onSubmit ? h('button.btn' + (danger ? '.danger' : '.primary'), { type: 'submit' }, submitLabel) : null));
  dlg.append(form);
  document.body.append(dlg);
  dlg.showModal();
  return { dlg, form, err, close };
}

function linkDialog(title, text, link) {
  const input = h('input', { value: link, readOnly: true });
  dialog(title, h('div.stack',
    h('p', text),
    h('div.copy', input, h('button.btn', { type: 'button', onclick: async () => { input.select(); try { await navigator.clipboard.writeText(link); toast('Copied'); } catch { document.execCommand('copy'); } } }, 'Copy')),
    h('p.small.muted', 'The link works once and expires in 7 days.')));
}

const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
const field = (label, input, hint) => h('div.field', h('label', label), input, hint ? h('div.hint', hint) : null);

// ---------------- Platform ----------------
async function businesses(main) {
  const [{ businesses: list }, stats] = await Promise.all([api('api/platform/businesses'), api('api/platform/stats')]);
  const rows = list.map((b) => h('tr',
    h('td', h('b', b.name), h('div.small.muted', b.industry || '')),
    h('td', h('a', { href: `b/${b.slug}`, target: '_blank' }, `/b/${b.slug}`)),
    h('td', b.owner_email || h('span.muted', 'No owner yet')),
    h('td', b.staff_count), h('td', b.upcoming),
    h('td', b.active ? h('span.pill.completed', 'Live') : h('span.pill', 'Paused')),
    h('td', h('div.row',
      h('button.btn.small.primary', { onclick: () => { BIZ = b; setBrand(b.brand_color); show('appointments'); } }, 'Manage'),
      h('button.btn.small', { onclick: () => ownerDialog(b) }, b.owner_email ? 'Re-invite owner' : 'Invite owner'),
      h('button.btn.small', { onclick: async () => { await api(`api/platform/businesses/${b.id}`, { method: 'PATCH', body: { active: !b.active } }); show('businesses'); } }, b.active ? 'Pause' : 'Resume')))));
  fill(main, 
    head('Businesses', h('button.btn.primary', { onclick: newBusiness }, '+ New business')),
    h('div.stats',
      h('div.stat', h('b', stats.businesses), h('span', 'Live businesses')),
      h('div.stat', h('b', stats.upcoming), h('span', 'Upcoming appointments')),
      h('div.stat', h('b', stats.last30), h('span', 'Bookings, last 30 days')),
      h('div.stat', h('b', `${stats.integrations.email ? 'On' : 'Off'} / ${stats.integrations.sms ? 'On' : 'Off'}`), h('span', 'Email / SMS sending'))),
    list.length ? h('div.card.table-wrap', h('table',
      h('thead', h('tr', ['Business', 'Booking link', 'Owner', 'Staff', 'Upcoming', 'Status', ''].map((t) => h('th', t)))),
      h('tbody', rows))) : h('div.card.empty', 'No businesses yet. Create your first client.'));
}

function newBusiness() {
  const name = h('input', { name: 'name', required: true });
  const slug = h('input', { name: 'slug', required: true, pattern: '[a-z0-9-]+' });
  name.addEventListener('input', () => { if (!slug.dataset.touched) slug.value = name.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); });
  slug.addEventListener('input', () => { slug.dataset.touched = '1'; });
  dialog('New business', h('div',
    field('Business name', name),
    field('Booking link', slug, 'Lowercase letters, numbers and dashes. Becomes /b/your-link.'),
    h('div.grid2',
      field('Industry', h('input', { name: 'industry', placeholder: 'Barbershop, salon, spa…' })),
      field('Time zone', tzSelect('America/Chicago'))),
    h('div.grid2',
      field('Owner name', h('input', { name: 'owner_name' })),
      field('Owner email', h('input', { name: 'owner_email', type: 'email' }, ), 'Optional. You\'ll get a link to send them.'))),
  {
    submitLabel: 'Create',
    onSubmit: async (d) => {
      const { business } = await api('api/platform/businesses', { method: 'POST', body: d });
      show('businesses');
      if (d.owner_email) {
        const { link } = await api(`api/platform/businesses/${business.id}/owner`, { method: 'POST', body: { email: d.owner_email, name: d.owner_name } });
        linkDialog('Send this to the owner', `Send ${d.owner_email} this link so they can set a password and manage ${business.name}.`, link);
      }
    },
  });
}

function ownerDialog(b) {
  dialog(`Owner login for ${b.name}`, h('div',
    field('Owner name', h('input', { name: 'name' })),
    field('Owner email', h('input', { name: 'email', type: 'email', required: true, value: b.owner_email || '' }))),
  {
    submitLabel: 'Create link',
    onSubmit: async (d) => {
      const { link } = await api(`api/platform/businesses/${b.id}/owner`, { method: 'POST', body: d });
      show('businesses');
      linkDialog('Send this to the owner', `Send ${d.email} this link to set their password.`, link);
    },
  });
}

function tzSelect(value) {
  const zones = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone').filter((z) => /^(America|Europe|Pacific|Australia|Asia|Africa|Atlantic)\//.test(z)) : [value];
  return h('select', { name: 'timezone' }, zones.map((z) => h('option', { value: z, selected: z === value }, z.replace(/_/g, ' '))));
}

// ---------------- Appointments ----------------
let apptRange = null;
async function appointments(main) {
  const tz = BIZ.timezone;
  const today = localDate(Date.now(), tz);
  apptRange = apptRange || { from: today, days: 7, staff: '' };
  const isStaff = ME.user.role === 'staff';
  const [{ appointments: list }, staffList] = await Promise.all([
    bizApi(`api/biz/appointments?from=${apptRange.from}&to=${addDays(apptRange.from, apptRange.days)}&status=${apptRange.showCancelled ? 'all' : ''}${apptRange.staff ? '&staff=' + apptRange.staff : ''}`),
    isStaff ? Promise.resolve({ staff: [] }) : bizApi('api/biz/staff'),
  ]);
  const move = (n) => { apptRange.from = addDays(apptRange.from, n * apptRange.days); show('appointments'); };
  const groups = new Map();
  for (const a of list) {
    const d = localDate(a.starts_at, tz);
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(a);
  }
  const status = (a, s, label) => h('button.btn.small', {
    onclick: async () => {
      if (s === 'cancelled' && !confirm('Cancel this appointment? The customer will be notified.')) return;
      await bizApi(`api/biz/appointments/${a.id}`, { method: 'PATCH', body: { status: s } });
      toast('Updated'); show('appointments');
    },
  }, label);
  const card = (a) => h('div.appt',
    h('div', h('div.time', fmtTime(a.starts_at, tz)), h('div.small.muted', `${Math.round((a.ends_at - a.starts_at) / 60000)} min`)),
    h('div',
      h('div', h('b', a.customer_name), ' ', h('span.pill.' + a.status, a.status.replace('_', '-'))),
      h('div.small', a.services.map((s) => s.name).join(' + '), ` · ${money(a.total_cents)}`),
      h('div.small.muted', [isStaff ? null : `with ${a.staff_name}`, a.customer_phone, a.customer_email].filter(Boolean).join(' · ')),
      a.notes ? h('div.small', { style: { marginTop: '4px' } }, '“', a.notes, '”') : null),
    h('div.actions', a.status === 'booked' ? [
      a.starts_at < Date.now() + 3600000 ? status(a, 'completed', 'Done') : null,
      a.starts_at < Date.now() ? status(a, 'no_show', 'No-show') : null,
      h('button.btn.small', { onclick: () => rescheduleDialog(a, staffList.staff) }, 'Move'),
      status(a, 'cancelled', 'Cancel'),
    ] : null));

  const days = [];
  for (let i = 0; i < apptRange.days; i++) {
    const d = addDays(apptRange.from, i);
    const items = groups.get(d) || [];
    if (!items.length && apptRange.days > 1) continue;
    days.push(h('div.day-group', h('h3', fmtDay(Date.parse(d + 'T12:00:00Z'), 'UTC'), d === today ? ' · Today' : ''), items.length ? items.map(card) : h('p.muted', 'Nothing booked.')));
  }

  fill(main, 
    head(isStaff ? 'My appointments' : 'Appointments', h('button.btn.primary', { onclick: () => newAppointment(staffList.staff) }, '+ New appointment')),
    h('div.row', { style: { marginBottom: '8px' } },
      h('button.btn.small', { onclick: () => move(-1) }, '‹'),
      h('input', { type: 'date', value: apptRange.from, style: { width: 'auto' }, onchange: (e) => { apptRange.from = e.target.value; show('appointments'); } }),
      h('button.btn.small', { onclick: () => move(1) }, '›'),
      h('button.btn.small', { onclick: () => { apptRange.from = today; show('appointments'); } }, 'Today'),
      h('select', { style: { width: 'auto' }, onchange: (e) => { apptRange.days = Number(e.target.value); show('appointments'); } },
        [[1, 'Day'], [7, 'Week'], [30, '30 days']].map(([v, l]) => h('option', { value: v, selected: apptRange.days === v }, l))),
      isStaff ? null : h('select', { style: { width: 'auto' }, onchange: (e) => { apptRange.staff = e.target.value; show('appointments'); } },
        h('option', { value: '' }, 'All staff'), staffList.staff.filter((s) => s.active).map((s) => h('option', { value: s.id, selected: String(s.id) === String(apptRange.staff) }, s.name))),
      h('label.check', h('input', { type: 'checkbox', checked: !!apptRange.showCancelled, onchange: (e) => { apptRange.showCancelled = e.target.checked; show('appointments'); } }), 'Show cancelled')),
    days.length ? days : h('div.card.empty', 'No appointments in this range.'));
}

async function newAppointment(staff) {
  const { services: svc } = await bizApi('api/biz/services');
  const active = svc.filter((s) => s.active);
  const isStaff = ME.user.role === 'staff';
  const svcBoxes = active.map((s) => h('label.check', h('input', { type: 'checkbox', value: s.id, 'data-svc': '1' }), `${s.name} (${duration(s.duration_min)}, ${money(s.price_cents)})`));
  const staffSel = isStaff ? null : h('select', { name: 'staff' }, h('option', { value: 'any' }, 'Anyone available'), staff.filter((s) => s.active).map((s) => h('option', { value: s.id }, s.name)));
  const date = h('input', { type: 'date', name: 'date', required: true, value: localDate(Date.now(), BIZ.timezone) });
  const slotsBox = h('div.slots');
  const timeInput = h('input', { type: 'time', name: 'time', required: true, step: 300 });
  const ids = () => [...document.querySelectorAll('[data-svc]:checked')].map((x) => Number(x.value));
  async function refresh() {
    slotsBox.replaceChildren();
    if (!ids().length || !date.value) return;
    try {
      const { slots } = await bizApi(`api/biz/slots?services=${ids().join(',')}&staff=${staffSel ? staffSel.value : ME.user.staff_id}&date=${date.value}`);
      slotsBox.replaceChildren(...(slots.length ? slots.map((s) => h('button', {
        type: 'button', onclick: (e) => { timeInput.value = minToTime(timeToMin(fmt24(s.start))); slotsBox.querySelectorAll('button').forEach((b) => b.classList.remove('sel')); e.target.classList.add('sel'); },
      }, fmtTime(s.start, BIZ.timezone))) : [h('span.muted.small', 'No open times within working hours. You can still type a time and tick "Override".')]));
    } catch (e) { slotsBox.replaceChildren(h('span.small.muted', e.message)); }
  }
  const fmt24 = (ms) => new Intl.DateTimeFormat('en-GB', { timeZone: BIZ.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
  svcBoxes.forEach((b) => b.addEventListener('change', refresh));
  date.addEventListener('change', refresh);
  staffSel && staffSel.addEventListener('change', refresh);
  dialog('New appointment', h('div',
    field('Services', h('div.stack', svcBoxes)),
    h('div.grid2', staffSel ? field('Staff', staffSel) : null, field('Date', date)),
    field('Open times', slotsBox),
    field('Time', timeInput),
    h('label.check.field', h('input', { type: 'checkbox', name: 'force' }), 'Override working hours (still prevents double-booking)'),
    h('div.grid3',
      field('Customer name', h('input', { name: 'name', required: true })),
      field('Phone', h('input', { name: 'phone', type: 'tel' })),
      field('Email', h('input', { name: 'email', type: 'email' }))),
    field('Notes', h('textarea', { name: 'notes' })),
    h('label.check', h('input', { type: 'checkbox', name: 'notify', checked: true }), 'Send confirmation to customer')),
  {
    submitLabel: 'Book',
    onSubmit: async (d) => {
      if (!ids().length) throw new Error('Pick at least one service.');
      await bizApi('api/biz/appointments', { method: 'POST', body: { ...d, services: ids() } });
      toast('Booked'); show('appointments');
    },
  });
  refresh();
}

function rescheduleDialog(a, staff) {
  const tz = BIZ.timezone;
  const t = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(a.starts_at));
  dialog(`Move ${a.customer_name}`, h('div',
    h('p.muted', `Currently ${fmtDateTime(a.starts_at, tz)} with ${a.staff_name}.`),
    h('div.grid2',
      field('Date', h('input', { type: 'date', name: 'date', required: true, value: localDate(a.starts_at, tz) })),
      field('Time', h('input', { type: 'time', name: 'time', required: true, value: t, step: 300 }))),
    ME.user.role === 'staff' ? null : field('Staff', h('select', { name: 'staff_id' }, staff.filter((s) => s.active).map((s) => h('option', { value: s.id, selected: s.id === a.staff_id }, s.name)))),
    h('label.check', h('input', { type: 'checkbox', name: 'force' }), 'Override working hours')),
  {
    submitLabel: 'Move',
    onSubmit: async (d) => {
      await bizApi(`api/biz/appointments/${a.id}`, { method: 'PATCH', body: d });
      toast('Moved'); show('appointments');
    },
  });
}

// ---------------- Services ----------------
async function services(main) {
  const { services: list } = await bizApi('api/biz/services');
  fill(main, 
    head('Services', h('button.btn.primary', { onclick: () => serviceDialog() }, '+ Add service')),
    list.length ? h('div.card.table-wrap', h('table',
      h('thead', h('tr', ['Service', 'Category', 'Duration', 'Buffer', 'Price', ''].map((t) => h('th', t)))),
      h('tbody', list.map((s) => h('tr', { style: s.active ? null : { opacity: 0.5 } },
        h('td', h('b', s.name), s.active ? null : ' (hidden)', s.description ? h('div.small.muted', s.description) : null),
        h('td', s.category), h('td', duration(s.duration_min)), h('td', s.buffer_min ? `${s.buffer_min} min` : '—'), h('td', money(s.price_cents)),
        h('td', h('button.btn.small', { onclick: () => serviceDialog(s) }, 'Edit'))))))) : h('div.card.empty', 'No services yet.'),
    h('p.small.muted', { style: { marginTop: '12px' } }, 'Buffer is cleanup time after the service; it blocks the calendar but isn\'t shown to customers. New services are assigned to every staff member; adjust under Staff.'));
}

function serviceDialog(s = {}) {
  dialog(s.id ? 'Edit service' : 'New service', h('div',
    field('Name', h('input', { name: 'name', required: true, value: s.name || '' })),
    field('Description', h('textarea', { name: 'description', value: s.description || '' })),
    h('div.grid2',
      field('Category', h('input', { name: 'category', value: s.category || '', placeholder: 'e.g. Hair, Beard, Color' })),
      field('Price ($)', h('input', { name: 'price', type: 'number', min: 0, step: '0.01', value: s.id ? (s.price_cents / 100).toFixed(2) : '' }))),
    h('div.grid3',
      field('Duration (min)', h('input', { name: 'duration_min', type: 'number', min: 5, max: 720, step: 5, required: true, value: s.duration_min || 30 })),
      field('Buffer (min)', h('input', { name: 'buffer_min', type: 'number', min: 0, max: 240, step: 5, value: s.buffer_min || 0 })),
      field('Display order', h('input', { name: 'sort', type: 'number', min: 0, value: s.sort || 0 }))),
    h('label.check', h('input', { type: 'checkbox', name: 'active', checked: s.id ? !!s.active : true }), 'Bookable online')),
  {
    onSubmit: async (d) => {
      if (s.id) await bizApi(`api/biz/services/${s.id}`, { method: 'PUT', body: d });
      else await bizApi('api/biz/services', { method: 'POST', body: d });
      toast('Saved'); show('services');
    },
  });
}

// ---------------- Staff ----------------
async function staff(main) {
  const [{ staff: list }, { services: svc }] = await Promise.all([bizApi('api/biz/staff'), bizApi('api/biz/services')]);
  fill(main, 
    head('Staff', h('button.btn.primary', { onclick: () => staffDialog({}, svc) }, '+ Add staff')),
    list.length ? list.map((s) => h('div.card', { style: s.active ? null : { opacity: 0.6 } },
      h('div.row',
        h('span.avatar', s.name[0]),
        h('div', h('b', s.name), s.active ? null : ' (inactive)', h('div.small.muted', [s.title, s.email, s.phone].filter(Boolean).join(' · '))),
        h('span.spacer'),
        h('button.btn.small', { onclick: () => staffDialog(s, svc) }, 'Edit'),
        h('button.btn.small', { onclick: () => hoursDialog(s) }, 'Hours & time off'),
        h('button.btn.small', { onclick: () => inviteStaff(s) }, s.login ? (s.login.active ? 'Reset login' : 'Re-send invite') : 'Give login')),
      h('div.small.muted', { style: { marginTop: '8px' } }, hoursSummary(s.hours)),
      h('div.small.muted', 'Offers: ', svc.filter((x) => s.service_ids.includes(x.id) && x.active).map((x) => x.name).join(', ') || 'nothing yet'),
      s.time_off.length ? h('div.small.muted', 'Time off: ', s.time_off.map((t) => fmtRange(t)).join('; ')) : null)) : h('div.card.empty', 'Add your first staff member.'));
}

function hoursSummary(hours) {
  if (!hours.length) return 'No working hours set (not bookable).';
  const byDay = DAYS.map((d, i) => [d.slice(0, 3), hours.filter((x) => x.weekday === i)]).filter(([, x]) => x.length);
  return byDay.map(([d, x]) => `${d} ${x.map((s) => `${fmt12(s.start_min)}–${fmt12(s.end_min)}`).join(', ')}`).join(' · ');
}
const fmt12 = (m) => { const hh = Math.floor(m / 60) % 24, mm = m % 60; return `${hh % 12 || 12}${mm ? ':' + String(mm).padStart(2, '0') : ''}${hh < 12 ? 'a' : 'p'}`; };
function fmtRange(t) {
  const tz = BIZ.timezone;
  const allDay = fmtTime(t.starts_at, tz) === '12:00 AM' && fmtTime(t.ends_at, tz) === '12:00 AM';
  if (allDay) {
    const last = t.ends_at - 1;
    const a = fmtDay(t.starts_at, tz), b = fmtDay(last, tz);
    return (a === b ? a : `${a} – ${b}`) + (t.reason ? ` (${t.reason})` : '');
  }
  return `${fmtDateTime(t.starts_at, tz)}–${fmtTime(t.ends_at, tz)}` + (t.reason ? ` (${t.reason})` : '');
}

function staffDialog(s, svc) {
  const boxes = svc.filter((x) => x.active).map((x) => h('label.check', h('input', { type: 'checkbox', value: x.id, 'data-ss': '1', checked: s.id ? s.service_ids.includes(x.id) : true }), x.name));
  dialog(s.id ? `Edit ${s.name}` : 'New staff member', h('div',
    h('div.grid2',
      field('Name', h('input', { name: 'name', required: true, value: s.name || '' })),
      field('Title', h('input', { name: 'title', value: s.title || '', placeholder: 'Barber, Stylist…' }))),
    h('div.grid2',
      field('Email', h('input', { name: 'email', type: 'email', value: s.email || '' }), 'Gets new-booking emails.'),
      field('Phone', h('input', { name: 'phone', type: 'tel', value: s.phone || '' }))),
    field('Short bio', h('textarea', { name: 'bio', value: s.bio || '' })),
    field('Services they offer', h('div.grid2', boxes)),
    h('div.grid2',
      field('Display order', h('input', { name: 'sort', type: 'number', min: 0, value: s.sort || 0 })),
      h('label.check', { style: { alignSelf: 'end', marginBottom: '20px' } }, h('input', { type: 'checkbox', name: 'active', checked: s.id ? !!s.active : true }), 'Active (bookable)'))),
  {
    onSubmit: async (d) => {
      d.service_ids = [...document.querySelectorAll('[data-ss]:checked')].map((x) => Number(x.value));
      if (s.id) await bizApi(`api/biz/staff/${s.id}`, { method: 'PUT', body: d });
      else await bizApi('api/biz/staff', { method: 'POST', body: d });
      toast(s.id ? 'Saved' : 'Added with default hours Tue–Sat 9–5'); show('staff');
    },
  });
}

async function inviteStaff(s) {
  dialog(`Login for ${s.name}`, h('div',
    h('p.muted', 'Staff can see their own appointments and manage their own hours and time off.'),
    field('Email', h('input', { name: 'email', type: 'email', required: true, value: (s.login && s.login.email) || s.email || '' }))),
  {
    submitLabel: 'Create link',
    onSubmit: async (d) => {
      const { link } = await bizApi(`api/biz/staff/${s.id}/invite`, { method: 'POST', body: d });
      show('staff');
      linkDialog('Send this to ' + s.name, `Send ${d.email} this link to set their password.`, link);
    },
  });
}

function hoursEditor(s) {
  const rows = DAYS.map((name, wd) => {
    const list = h('div');
    const addShift = (start = 540, end = 1020) => {
      const row = h('div.shift',
        h('input', { type: 'time', value: minToTime(start), 'data-wd': wd, 'data-k': 'start', step: 300 }),
        h('span', 'to'),
        h('input', { type: 'time', value: minToTime(end), 'data-k': 'end', step: 300 }),
        h('button.btn.small', { type: 'button', onclick: () => row.remove(), 'aria-label': 'Remove shift' }, '✕'));
      list.append(row);
    };
    for (const x of s.hours.filter((x) => x.weekday === wd)) addShift(x.start_min, x.end_min);
    return h('div.hours-row', h('b', name), h('div', list, h('button.linkbtn.small', { type: 'button', onclick: () => addShift() }, '+ Add hours')));
  });
  const collect = (root) => [...root.querySelectorAll('.shift')].map((r) => {
    const [a, b] = r.querySelectorAll('input');
    if (!a.value || !b.value) throw new Error('Fill in every start and end time.');
    return { weekday: Number(a.dataset.wd), start_min: timeToMin(a.value), end_min: timeToMin(b.value) };
  });
  return { el: h('div', rows), collect };
}

function timeOffEditor(s, onChange) {
  const list = h('div.stack', s.time_off.length ? s.time_off.map((t) => h('div.row',
    h('span', fmtRange(t)), h('span.spacer'),
    h('button.btn.small.danger', { type: 'button', onclick: async () => { const r = await bizApi(`api/biz/staff/${s.id}/time-off/${t.id}`, { method: 'DELETE' }); onChange(r.staff); } }, 'Remove'))) : h('p.muted.small', 'No upcoming time off.'));
  const from = h('input', { type: 'date' }), to = h('input', { type: 'date' });
  const st = h('input', { type: 'time', step: 300 }), en = h('input', { type: 'time', step: 300 });
  const reason = h('input', { placeholder: 'Vacation, appointment…' });
  const err = h('div');
  return h('div.stack', list,
    h('div.grid2', field('From', from), field('To (for multiple days)', to)),
    h('div.grid3', field('Only from (optional)', st), field('until', en), field('Reason', reason)),
    err,
    h('button.btn', {
      type: 'button',
      onclick: async () => {
        try {
          const r = await bizApi(`api/biz/staff/${s.id}/time-off`, { method: 'POST', body: { from: from.value, to: to.value, start_min: st.value ? timeToMin(st.value) : '', end_min: en.value ? timeToMin(en.value) : '', reason: reason.value } });
          onChange(r.staff);
        } catch (e) { errorBox(err, e); }
      },
    }, 'Add time off'));
}

function hoursDialog(s) {
  const ed = hoursEditor(s);
  const off = h('div');
  const renderOff = (st) => { s = st; off.replaceChildren(timeOffEditor(st, renderOff)); };
  renderOff(s);
  dialog(`${s.name}: hours & time off`, h('div',
    h('h3', 'Weekly hours'), ed.el,
    h('h3', { style: { marginTop: '20px' } }, 'Time off'), off),
  {
    submitLabel: 'Save hours',
    onSubmit: async (d, form) => {
      await bizApi(`api/biz/staff/${s.id}/hours`, { method: 'PUT', body: { hours: ed.collect(form) } });
      toast('Saved'); show(view);
    },
  });
}

async function myhours(main) {
  const { staff: list } = await bizApi('api/biz/staff');
  const s = list.find((x) => x.id === ME.user.staff_id);
  if (!s) { fill(main, h('div.alert.error', 'Your login is not linked to a staff profile.')); return; }
  const ed = hoursEditor(s);
  const err = h('div');
  const off = h('div');
  const renderOff = (st) => off.replaceChildren(timeOffEditor(st, renderOff));
  renderOff(s);
  fill(main, 
    head('My hours & time off'),
    h('div.card', h('h2', 'Weekly hours'), ed.el, err,
      h('button.btn.primary', { style: { marginTop: '12px' }, onclick: async () => {
        try { await bizApi(`api/biz/staff/${s.id}/hours`, { method: 'PUT', body: { hours: ed.collect(main) } }); toast('Saved'); }
        catch (e) { errorBox(err, e); }
      } }, 'Save hours')),
    h('div.card', h('h2', 'Time off'), off));
}

// ---------------- Customers ----------------
async function customers(main) {
  const search = h('input', { type: 'search', placeholder: 'Search name, email, phone', style: { maxWidth: '320px' } });
  const box = h('div');
  const load = async () => {
    const { customers: list } = await bizApi('api/biz/customers?q=' + encodeURIComponent(search.value));
    box.replaceChildren(list.length ? h('div.card.table-wrap', h('table',
      h('thead', h('tr', ['Name', 'Phone', 'Email', 'Visits', 'Last visit'].map((t) => h('th', t)))),
      h('tbody', list.map((c) => h('tr', h('td', h('b', c.name)), h('td', c.phone), h('td', c.email), h('td', c.visits),
        h('td', c.last_visit ? fmtDateTime(c.last_visit, BIZ.timezone) : '—')))))) : h('div.card.empty', 'No customers yet.'));
  };
  let t;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
  fill(main, head('Customers', search), box);
  await load();
}

// ---------------- Settings ----------------
async function settings(main) {
  const { business: b } = await bizApi('api/biz/settings');
  const err = h('div');
  const form = h('form.card', {
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        const { business } = await bizApi('api/biz/settings', { method: 'PATCH', body: formData(form) });
        BIZ = { ...BIZ, ...business }; setBrand(BIZ.brand_color); toast('Saved'); errorBox(err, null);
      } catch (x) { errorBox(err, x); }
    },
  },
  h('h2', 'Business'),
  h('div.grid2', field('Name', h('input', { name: 'name', required: true, value: b.name })), field('Industry', h('input', { name: 'industry', value: b.industry }))),
  isPlatform() ? field('Booking link', h('input', { name: 'slug', value: b.slug }), 'Changing this breaks old links.') : field('Booking link', h('input', { value: `${location.origin}${document.baseURI.replace(location.origin, '')}b/${b.slug}`, readOnly: true })),
  h('div.grid2', field('Phone', h('input', { name: 'phone', value: b.phone })), field('Email', h('input', { name: 'email', type: 'email', value: b.email }, ), 'Gets booking emails for staff without an email.')),
  field('Address', h('input', { name: 'address', value: b.address })),
  field('About (shown on booking page)', h('textarea', { name: 'about', value: b.about })),
  h('div.grid2', field('Time zone', tzSelect(b.timezone)), field('Brand color', h('input', { name: 'brand_color', type: 'color', value: b.brand_color }))),
  h('h2', { style: { marginTop: '20px' } }, 'Booking rules'),
  h('div.grid3',
    field('Time slot step (min)', h('input', { name: 'slot_interval', type: 'number', min: 5, max: 120, step: 5, value: b.slot_interval })),
    field('Minimum notice (min)', h('input', { name: 'lead_minutes', type: 'number', min: 0, value: b.lead_minutes }), 'How soon a customer can book.'),
    field('Book ahead (days)', h('input', { name: 'window_days', type: 'number', min: 1, max: 365, value: b.window_days }))),
  h('div.grid3',
    field('Online cancel cutoff (hours)', h('input', { name: 'cancel_hours', type: 'number', min: 0, value: b.cancel_hours })),
    field('Reminder (hours before)', h('input', { name: 'reminder_hours', type: 'number', min: 1, max: 168, value: b.reminder_hours }))),
  h('h2', { style: { marginTop: '20px' } }, 'Notifications'),
  h('label.check.field', h('input', { type: 'checkbox', name: 'notify_email', checked: !!b.notify_email }), 'Email confirmations, reminders and cancellations'),
  h('label.check.field', h('input', { type: 'checkbox', name: 'notify_sms', checked: !!b.notify_sms }), 'Text message confirmations and reminders'),
  !ME.integrations.email || !ME.integrations.sms ? h('p.small.muted', `Platform sending status: email ${ME.integrations.email ? 'on' : 'not set up yet'}, SMS ${ME.integrations.sms ? 'on' : 'not set up yet'}.`) : null,
  err,
  h('button.btn.primary', { type: 'submit' }, 'Save settings'));
  fill(main, head('Settings'), form);
}

async function messages(main) {
  const { notifications: list } = await bizApi('api/biz/notifications');
  fill(main, head('Message log'),
    h('p.muted.small', 'Every email and text the platform tried to send for this business. "Skipped" means that channel isn\'t set up yet.'),
    list.length ? h('div.card.table-wrap', h('table',
      h('thead', h('tr', ['When', 'Type', 'Channel', 'To', 'Status'].map((t) => h('th', t)))),
      h('tbody', list.map((n) => h('tr', h('td', fmtDateTime(n.created_at, BIZ.timezone)), h('td', n.kind.replace('_', ' ')), h('td', n.channel), h('td', n.recipient),
        h('td', h('span.pill.' + (n.status === 'sent' ? 'completed' : n.status === 'failed' ? 'cancelled' : ''), n.status), n.error ? h('div.small.muted', n.error) : null)))))) : h('div.card.empty', 'Nothing sent yet.'));
}

// ---------------- Customer ----------------
async function mine(main) {
  const { appointments: list, unverified, canVerify } = await api('api/customer/appointments');
  if (unverified) {
    const msg = h('div');
    fill(main, head('My appointments'), h('div.card.stack',
      h('h2', 'Confirm your email first'),
      h('p.muted', `To protect your privacy, bookings show up here once you confirm ${ME.user.email}. Check your inbox for the link.`),
      msg,
      canVerify ? h('button.btn', { onclick: async () => { try { await api('api/auth/verify/resend', { method: 'POST', body: {} }); msg.replaceChildren(h('div.alert.ok', 'Sent. Check your inbox.')); } catch (e) { errorBox(msg, e); } } }, 'Resend confirmation email')
        : h('p.small.muted', 'Email confirmation isn\'t available yet. Use the link in your booking confirmation to manage a booking.')));
    return;
  }
  const now = Date.now();
  const up = list.filter((a) => a.status === 'booked' && a.ends_at > now);
  const past = list.filter((a) => !(a.status === 'booked' && a.ends_at > now)).reverse();
  const card = (a) => h('div.appt',
    h('div', h('div.time', fmt(a.starts_at, a.timezone, { month: 'short', day: 'numeric' })), h('div.small.muted', fmtTime(a.starts_at, a.timezone))),
    h('div', h('b', a.business_name), ' ', h('span.pill.' + a.status, a.status.replace('_', '-')),
      h('div.small', a.services.map((s) => s.name).join(' + '), ` with ${a.staff_name}`)),
    h('div.actions', a.manage_token ? h('a.btn.small', { href: `m/${a.manage_token}` }, 'View') : null, h('a.btn.small', { href: `b/${a.slug}` }, 'Book again')));
  fill(main, head('My appointments'),
    h('h2', 'Upcoming'), up.length ? up.map(card) : h('p.muted', 'Nothing coming up.'),
    h('h2', { style: { marginTop: '24px' } }, 'Past'), past.length ? past.map(card) : h('p.muted', 'No past appointments.'));
}
const fmt = (ms, tz, o) => new Intl.DateTimeFormat('en-US', { timeZone: tz, ...o }).format(new Date(ms));

// ---------------- Account ----------------
async function account(main) {
  const err = h('div');
  const form = h('form.card.stack', {
    onsubmit: async (e) => {
      e.preventDefault();
      const d = formData(form);
      if (d.password !== d.confirm) return errorBox(err, new Error('New passwords do not match.'));
      try { await api('api/auth/password', { method: 'POST', body: d }); form.reset(); errorBox(err, null); toast('Password changed'); }
      catch (x) { errorBox(err, x); }
    },
  },
  h('h2', 'Change password'), err,
  field('Current password', h('input', { name: 'current', type: 'password', required: true, autocomplete: 'current-password' })),
  h('div.grid2',
    field('New password', h('input', { name: 'password', type: 'password', minLength: 10, required: true, autocomplete: 'new-password' })),
    field('Confirm', h('input', { name: 'confirm', type: 'password', required: true, autocomplete: 'new-password' }))),
  h('button.btn.primary', { type: 'submit' }, 'Update password'));
  fill(main, head('Account'),
    h('div.card', h('p', h('b', ME.user.name || ME.user.email)), h('p.muted', ME.user.email, ' · ', ME.user.role)),
    form);
}

main().catch((e) => app.replaceChildren(h('div.wrap', h('div.alert.error', e.message))));
