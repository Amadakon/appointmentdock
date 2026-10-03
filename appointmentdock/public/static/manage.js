import { api, h, money, fmtDay, fmtTime, setBrand, errorBox } from './common.js';

const app = document.getElementById('app');
const token = location.pathname.split('/').filter(Boolean).pop();

async function main() {
  let data;
  try { data = await api('api/manage/' + encodeURIComponent(token)); }
  catch (e) {
    app.replaceChildren(h('main.narrow', h('div.card', { style: { marginTop: '48px' } }, h('h1', 'Appointment not found'), h('p.muted', e.message))));
    return;
  }
  const { appointment: a, business: b, canCancel } = data;
  setBrand(b.brand_color);
  document.title = `Your appointment · ${b.name}`;
  const err = h('div');
  const statusText = { booked: 'Confirmed', cancelled: 'Cancelled', completed: 'Completed', no_show: 'Missed' }[a.status];
  app.replaceChildren(
    h('div.hero', h('div.narrow', h('h1', b.name), h('p', b.address || ''))),
    h('main.narrow.book-main',
      h('div.card.stack',
        h('div.row', h('h2', { style: { margin: 0 } }, 'Your appointment'), h('span.spacer'), h('span.pill.' + a.status, statusText)),
        h('div.summary.stack',
          h('div', h('span.muted', 'Date'), h('b', fmtDay(a.starts_at, b.timezone))),
          h('div', h('span.muted', 'Time'), h('b', `${fmtTime(a.starts_at, b.timezone)}`)),
          h('div', h('span.muted', 'With'), h('b', a.staff_name)),
          ...a.services.map((s) => h('div', h('span', s.name), h('span', money(s.price_cents)))),
          h('div', h('b', 'Total'), h('b', money(a.total_cents)))),
        err,
        a.status === 'booked' && canCancel ? h('div.row',
          h('a.btn', { href: `b/${b.slug}` }, 'Book another'),
          h('button.btn.danger', {
            onclick: async (e) => {
              if (!confirm('Cancel this appointment?')) return;
              e.target.disabled = true;
              try { await api(`api/manage/${encodeURIComponent(token)}/cancel`, { method: 'POST', body: {} }); main(); }
              catch (x) { errorBox(err, x); e.target.disabled = false; }
            },
          }, 'Cancel appointment')) : null,
        a.status === 'booked' && !canCancel ? h('p.muted.small', `Online changes close ${b.cancel_hours} hours before your appointment. Need to change it? Call ${b.name}${b.phone ? ' at ' + b.phone : ''}.`) : null,
        a.status === 'cancelled' ? h('a.btn.primary', { href: `b/${b.slug}` }, 'Book a new time') : null,
        b.phone ? h('p.small.muted', `Questions? Call ${b.phone}.`) : null)));
}
main();
