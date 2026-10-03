import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp, loadConfig } from '../src/app.js';
import { openDb } from '../src/db.js';
import { addDays, todayIn, localToUtc } from '../src/tz.js';

const quiet = { log() {}, error() {} };

async function start(extra = {}) {
  const cfg = loadConfig({
    APP_PATH: '/appointmentdock', PLATFORM_ADMIN_EMAIL: 'admin@example.com',
    PLATFORM_ADMIN_PASSWORD: 'adminpassword1', SEED_DEMO: 'true', SETUP_TOKEN: '', ...extra,
  });
  const app = createApp(cfg, { db: openDb(':memory:'), log: quiet });
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/appointmentdock`;
  return { app, server, base, close: () => new Promise((r) => server.close(r)) };
}

function client(base) {
  let cookie = '';
  return async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(base + path, {
      method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, data: ct.includes('json') ? await res.json() : await res.text() };
  };
}

// Next date (in Chicago) that falls on the given weekday, at least 2 days out.
function nextWeekday(wd) {
  let d = addDays(todayIn('America/Chicago'), 2);
  while (new Date(d + 'T12:00:00Z').getUTCDay() !== wd) d = addDays(d, 1);
  return d;
}

test('pages and health', async () => {
  const s = await start();
  const c = client(s.base);
  assert.equal((await c('/health')).status, 200);
  const page = await c('/b/demo');
  assert.equal(page.status, 200);
  assert.match(page.data, /<base href="\/appointmentdock\/">/);
  assert.equal((await c('/static/app.css')).status, 200);
  assert.equal((await c('/static/../src/app.js')).status, 404);
  assert.equal((await c('/nope')).status, 404);
  await s.close();
});

test('public booking flow, conflicts, cancel', async () => {
  const s = await start();
  const c = client(s.base);
  const { data: biz } = await c('/api/public/demo');
  assert.equal(biz.business.name, 'Fox River Barber Co.');
  const haircut = biz.services.find((x) => x.name === 'Haircut');
  const beard = biz.services.find((x) => x.name === 'Beard trim');
  const marco = biz.staff.find((x) => x.name === 'Marco');

  const date = nextWeekday(2); // Tuesday: Marco 9-12 & 1-6, Jess 10-7
  const days = await c(`/api/public/demo/days?services=${haircut.id},${beard.id}&staff=any`);
  assert.ok(days.data.days.includes(date));

  const slots = await c(`/api/public/demo/slots?services=${haircut.id},${beard.id}&staff=${marco.id}&date=${date}`);
  assert.equal(slots.status, 200);
  const first = slots.data.slots[0];
  assert.equal(first.start, localToUtc(date, 540, 'America/Chicago'));

  const bad = await c('/api/public/demo/book', { method: 'POST', body: { services: [haircut.id], staff: marco.id, start: first.start + 7 * 60000, name: 'X', email: 'x@example.com' } });
  assert.equal(bad.status, 409, 'off-grid time rejected');

  const ok = await c('/api/public/demo/book', {
    method: 'POST',
    body: { services: [haircut.id, beard.id], staff: marco.id, start: first.start, name: 'Sam Client', email: 'sam@example.com', phone: '630-555-0100' },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.staff, 'Marco');
  assert.equal(ok.data.total_cents, 5500);

  const again = await c('/api/public/demo/book', {
    method: 'POST', body: { services: [haircut.id], staff: marco.id, start: first.start, name: 'Other', email: 'o@example.com' },
  });
  assert.equal(again.status, 409, 'double booking blocked');

  // "Any" at the same time goes to someone else who is free (Jess starts at 10 though, Dee is off Tuesday)
  const slots2 = await c(`/api/public/demo/slots?services=${haircut.id}&staff=${marco.id}&date=${date}`);
  assert.ok(!slots2.data.slots.some((x) => x.start === first.start), 'slot is gone');

  const m = await c(`/api/manage/${ok.data.token}`);
  assert.equal(m.data.appointment.status, 'booked');
  assert.equal(m.data.canCancel, true);
  const cancel = await c(`/api/manage/${ok.data.token}/cancel`, { method: 'POST', body: {} });
  assert.equal(cancel.status, 200);
  const slots3 = await c(`/api/public/demo/slots?services=${haircut.id}&staff=${marco.id}&date=${date}`);
  assert.ok(slots3.data.slots.some((x) => x.start === first.start), 'slot is free again');

  // notifications recorded as skipped (no credentials)
  const n = s.app.db.prepare("SELECT channel, status FROM notifications WHERE kind = 'confirmation'").all();
  assert.ok(n.length >= 2 && n.every((x) => x.status === 'skipped'));
  await s.close();
});

test('staff without all services is excluded; validation', async () => {
  const s = await start();
  const c = client(s.base);
  const { data: biz } = await c('/api/public/demo');
  const fade = biz.services.find((x) => x.name === 'Skin fade');
  const jess = biz.staff.find((x) => x.name === 'Jess');
  const r = await c(`/api/public/demo/slots?services=${fade.id}&staff=${jess.id}&date=${nextWeekday(2)}`);
  assert.equal(r.status, 400);
  const r2 = await c('/api/public/demo/book', { method: 'POST', body: { services: [], name: '', email: 'bad' } });
  assert.equal(r2.status, 400);
  await s.close();
});

test('platform admin creates a business, owner sets password, configures it', async () => {
  const s = await start();
  const admin = client(s.base);
  assert.equal((await admin('/api/platform/businesses')).status, 401);
  assert.equal((await admin('/api/auth/login', { method: 'POST', body: { email: 'admin@example.com', password: 'wrong-password' } })).status, 401);
  assert.equal((await admin('/api/auth/login', { method: 'POST', body: { email: 'admin@example.com', password: 'adminpassword1' } })).status, 200);

  const created = await admin('/api/platform/businesses', { method: 'POST', body: { name: 'Glow Salon', slug: 'glow-salon', industry: 'Salon' } });
  assert.equal(created.status, 200);
  const dup = await admin('/api/platform/businesses', { method: 'POST', body: { name: 'Glow 2', slug: 'glow-salon' } });
  assert.equal(dup.status, 409);
  const reserved = await admin('/api/platform/businesses', { method: 'POST', body: { name: 'X', slug: 'api' } });
  assert.equal(reserved.status, 400);

  const bizId = created.data.business.id;
  const inv = await admin(`/api/platform/businesses/${bizId}/owner`, { method: 'POST', body: { email: 'owner@glow.test', name: 'Gina' } });
  const token = new URL(inv.data.link).searchParams.get('token');

  const owner = client(s.base);
  assert.equal((await owner(`/api/auth/token?token=${token}`)).data.email, 'owner@glow.test');
  assert.equal((await owner('/api/auth/token', { method: 'POST', body: { token, password: 'short' } })).status, 400);
  assert.equal((await owner('/api/auth/token', { method: 'POST', body: { token, password: 'ownerpassword1' } })).status, 200);
  assert.equal((await owner('/api/auth/token', { method: 'POST', body: { token, password: 'ownerpassword1' } })).status, 404, 'token is single use');

  const me = await owner('/api/me');
  assert.equal(me.data.user.role, 'owner');
  assert.equal((await owner('/api/platform/businesses')).status, 403);

  const svc = await owner('/api/biz/services', { method: 'POST', body: { name: 'Color', duration_min: 90, price: '120', buffer_min: 15 } });
  assert.equal(svc.data.service.price_cents, 12000);
  const st = await owner('/api/biz/staff', { method: 'POST', body: { name: 'Ana', email: 'ana@glow.test' } });
  assert.deepEqual(st.data.staff.service_ids, [svc.data.service.id]);
  assert.equal(st.data.staff.hours.length, 5);

  const hours = await owner(`/api/biz/staff/${st.data.staff.id}/hours`, { method: 'PUT', body: { hours: [{ weekday: 1, start_min: 600, end_min: 700 }, { weekday: 1, start_min: 650, end_min: 800 }] } });
  assert.equal(hours.status, 400, 'overlapping shifts rejected');

  // owner cannot touch the demo business
  const other = await owner(`/api/biz/services/1`, { method: 'PUT', body: { name: 'Hack', duration_min: 30 } });
  assert.equal(other.status, 404);

  // staff invite + staff restrictions
  const sinv = await owner(`/api/biz/staff/${st.data.staff.id}/invite`, { method: 'POST', body: {} });
  const stoken = new URL(sinv.data.link).searchParams.get('token');
  const staff = client(s.base);
  await staff('/api/auth/token', { method: 'POST', body: { token: stoken, password: 'staffpassword1' } });
  assert.equal((await staff('/api/me')).data.user.role, 'staff');
  assert.equal((await staff('/api/biz/services', { method: 'POST', body: { name: 'x', duration_min: 30 } })).status, 403);
  const own = await staff(`/api/biz/staff/${st.data.staff.id}/hours`, { method: 'PUT', body: { hours: [{ weekday: 2, start_min: 540, end_min: 1020 }] } });
  assert.equal(own.status, 200);

  // owner books manually (admin override), and the public page works
  const date = nextWeekday(2);
  const manual = await owner('/api/biz/appointments', { method: 'POST', body: { services: [svc.data.service.id], date, time: '09:00', name: 'Walk In', notify: false } });
  assert.equal(manual.status, 200, JSON.stringify(manual.data));
  const list = await staff(`/api/biz/appointments?from=${date}&to=${addDays(date, 1)}`);
  assert.equal(list.data.appointments.length, 1);
  assert.equal(list.data.appointments[0].ends_at - list.data.appointments[0].starts_at, 105 * 60000);

  const moved = await owner(`/api/biz/appointments/${manual.data.id}`, { method: 'PATCH', body: { date, time: '11:00' } });
  assert.equal(moved.status, 200);
  const done = await staff(`/api/biz/appointments/${manual.data.id}`, { method: 'PATCH', body: { status: 'completed' } });
  assert.equal(done.data.appointment.status, 'completed');

  // platform admin can act on any business with ?business=
  const asAdmin = await admin(`/api/biz/services?business=${bizId}`);
  assert.equal(asAdmin.data.services.length, 1);

  // CSRF: cross-origin POST blocked
  const csrf = await fetch(s.base + '/api/auth/logout', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(csrf.status, 403);
  await s.close();
});

test('customer account needs verified email to list bookings', async () => {
  const s = await start();
  const c = client(s.base);
  const { data: biz } = await c('/api/public/demo');
  const haircut = biz.services.find((x) => x.name === 'Haircut');
  const date = nextWeekday(3);
  const { data: sl } = await c(`/api/public/demo/slots?services=${haircut.id}&staff=any&date=${date}`);
  const b = await c('/api/public/demo/book', { method: 'POST', body: { services: [haircut.id], staff: 'any', start: sl.slots[0].start, name: 'Kim', email: 'kim@example.com', password: 'kimpassword12' } });
  assert.equal(b.data.account, 'created');
  const mine = await c('/api/customer/appointments');
  assert.equal(mine.data.unverified, true);
  assert.equal(mine.data.appointments.length, 0);
  // verify via token stored for that user
  const { createPasswordToken } = await import('../src/auth.js');
  const uid = s.app.db.prepare("SELECT id FROM users WHERE email = 'kim@example.com'").get().id;
  const tok = createPasswordToken(s.app.db, uid);
  assert.equal((await c('/api/auth/verify', { method: 'POST', body: { token: tok } })).status, 200);
  const mine2 = await c('/api/customer/appointments');
  assert.equal(mine2.data.appointments.length, 1);
  await s.close();
});

test('reminders are sent once for appointments inside the window', async () => {
  const s = await start();
  const db = s.app.db;
  const { data: biz } = await client(s.base)('/api/public/demo');
  const haircut = biz.services.find((x) => x.name === 'Haircut');
  const date = nextWeekday(2);
  const c = client(s.base);
  const { data: sl } = await c(`/api/public/demo/slots?services=${haircut.id}&staff=any&date=${date}`);
  await c('/api/public/demo/book', { method: 'POST', body: { services: [haircut.id], staff: 'any', start: sl.slots[0].start, name: 'Rae', email: 'rae@example.com' } });
  const startAt = sl.slots[0].start;
  assert.equal(await s.app.notifier.sendDueReminders(startAt - 30 * 3600000), 0);
  assert.equal(await s.app.notifier.sendDueReminders(startAt - 20 * 3600000), 1);
  assert.equal(await s.app.notifier.sendDueReminders(startAt - 19 * 3600000), 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM notifications WHERE kind = 'reminder'").get().n, 1);
  await s.close();
});
