// Booking domain logic shared by the public booking page and the admin tools.
import { computeSlots, blockMinutes, pickStaff, overlapsAny } from './availability.js';
import { localToUtc, addDays, parseDate, todayIn, utcToLocal } from './tz.js';
import { tx } from './db.js';
import { randomToken } from './auth.js';
import { bad, HttpError } from './http.js';

const DAY = 86400000;

export function loadServices(db, bizId, serviceIds) {
  if (!Array.isArray(serviceIds) || !serviceIds.length) throw bad('Pick at least one service.');
  if (serviceIds.length > 10) throw bad('Too many services.');
  const ids = serviceIds.map(Number);
  if (new Set(ids).size !== ids.length) throw bad('Each service can only be picked once.');
  const out = [];
  for (const id of ids) {
    const s = db.prepare('SELECT * FROM services WHERE id = ? AND business_id = ? AND active = 1').get(id, bizId);
    if (!s) throw bad('One of the selected services is no longer available.');
    out.push(s);
  }
  return out;
}

export function eligibleStaff(db, bizId, services, staffChoice) {
  const rows = db.prepare('SELECT id, name FROM staff WHERE business_id = ? AND active = 1 ORDER BY sort, id').all(bizId);
  const can = db.prepare('SELECT 1 FROM staff_services WHERE staff_id = ? AND service_id = ?');
  let list = rows.filter((st) => services.every((sv) => can.get(st.id, sv.id)));
  if (staffChoice && staffChoice !== 'any') {
    const id = Number(staffChoice);
    list = list.filter((st) => st.id === id);
    if (!list.length) throw bad('That staff member does not offer all of the selected services.');
  }
  return list;
}

function staffBusy(db, staffId, from, to, excludeApptId = null) {
  const appts = db.prepare(`SELECT starts_at, ends_at FROM appointments
    WHERE staff_id = ? AND status IN ('booked','completed') AND starts_at < ? AND ends_at > ? AND id IS NOT ?`)
    .all(staffId, to, from, excludeApptId);
  const off = db.prepare('SELECT starts_at, ends_at FROM time_off WHERE staff_id = ? AND starts_at < ? AND ends_at > ?')
    .all(staffId, to, from);
  return [...appts, ...off].map((r) => [r.starts_at, r.ends_at]);
}

export function slotsForDay(db, biz, services, staff, date, { now = Date.now(), admin = false, excludeApptId = null } = {}) {
  if (!parseDate(date)) throw bad('Invalid date.');
  const dayStart = localToUtc(date, 0, biz.timezone);
  const from = dayStart - DAY, to = dayStart + 2 * DAY;
  const hoursStmt = db.prepare('SELECT weekday, start_min, end_min FROM staff_hours WHERE staff_id = ?');
  return computeSlots({
    date, tz: biz.timezone,
    interval: biz.slot_interval,
    blockMin: blockMinutes(services),
    earliest: admin ? now - 30 * DAY : now + biz.lead_minutes * 60000,
    latest: admin ? null : now + biz.window_days * DAY,
    staff: staff.map((st) => ({ id: st.id, hours: hoursStmt.all(st.id), busy: staffBusy(db, st.id, from, to, excludeApptId) })),
  });
}

export function availableDays(db, biz, services, staff, fromDate, days, opts = {}) {
  const out = [];
  const today = todayIn(biz.timezone, opts.now);
  const last = addDays(today, biz.window_days);
  for (let i = 0; i < days; i++) {
    const d = addDays(fromDate, i);
    if (d < today || d > last) continue;
    if (slotsForDay(db, biz, services, staff, d, opts).length) out.push(d);
  }
  return out;
}

function findOrCreateCustomer(db, bizId, c) {
  let row = null;
  if (c.email) row = db.prepare('SELECT * FROM customers WHERE business_id = ? AND email = ? ORDER BY id LIMIT 1').get(bizId, c.email);
  if (!row && c.phone) row = db.prepare('SELECT * FROM customers WHERE business_id = ? AND phone = ? ORDER BY id LIMIT 1').get(bizId, c.phone);
  if (row) {
    db.prepare('UPDATE customers SET name = ?, email = COALESCE(NULLIF(?, \'\'), email), phone = COALESCE(NULLIF(?, \'\'), phone) WHERE id = ?')
      .run(c.name, c.email, c.phone, row.id);
    return row.id;
  }
  return Number(db.prepare('INSERT INTO customers (business_id, name, email, phone, created_at) VALUES (?,?,?,?,?)')
    .run(bizId, c.name, c.email, c.phone, Date.now()).lastInsertRowid);
}

/**
 * Create an appointment. Re-checks availability inside a write transaction so
 * two people cannot grab the same slot.
 */
export function book(db, biz, { serviceIds, staffChoice, start, customer, notes = '', source = 'online', admin = false, force = false, now = Date.now() }) {
  const services = loadServices(db, biz.id, serviceIds);
  const startMs = Number(start);
  if (!Number.isFinite(startMs)) throw bad('Pick a time.');
  const blockMs = blockMinutes(services) * 60000;
  const endMs = startMs + blockMs;
  const date = utcToLocal(startMs, biz.timezone).date;

  return tx(db, () => {
    const staff = eligibleStaff(db, biz.id, services, staffChoice);
    let candidates;
    if (force) {
      // Admin override: ignore working hours, but never double-book.
      candidates = staff.filter((st) => !overlapsAny(startMs, endMs, staffBusy(db, st.id, startMs, endMs))).map((s) => s.id);
    } else {
      const slot = slotsForDay(db, biz, services, staff, date, { now, admin }).find((s) => s.start === startMs);
      candidates = slot ? slot.staffIds : [];
    }
    if (!candidates.length) throw new HttpError(409, 'Sorry, that time was just taken. Please pick another.');

    const dayStart = localToUtc(date, 0, biz.timezone);
    const counts = new Map();
    for (const r of db.prepare(`SELECT staff_id, COUNT(*) n FROM appointments WHERE business_id = ? AND status = 'booked'
      AND starts_at >= ? AND starts_at < ? GROUP BY staff_id`).all(biz.id, dayStart, dayStart + DAY)) counts.set(r.staff_id, r.n);
    const staffId = pickStaff(candidates, counts);

    const customerId = findOrCreateCustomer(db, biz.id, customer);
    const total = services.reduce((t, s) => t + s.price_cents, 0);
    const token = randomToken(18);
    const apptId = Number(db.prepare(`INSERT INTO appointments
      (business_id, staff_id, customer_id, starts_at, ends_at, notes, total_cents, manage_token, source, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(biz.id, staffId, customerId, startMs, endMs, notes, total, token, source, now).lastInsertRowid);
    const ins = db.prepare('INSERT INTO appointment_services (appointment_id, service_id, name, duration_min, price_cents, position) VALUES (?,?,?,?,?,?)');
    services.forEach((s, i) => ins.run(apptId, s.id, s.name, s.duration_min, s.price_cents, i));
    return { id: apptId, token, staffId, start: startMs, end: endMs, total };
  });
}

export function reschedule(db, biz, apptId, { start, staffId, force = false, now = Date.now() }) {
  return tx(db, () => {
    const a = db.prepare("SELECT * FROM appointments WHERE id = ? AND business_id = ? AND status = 'booked'").get(apptId, biz.id);
    if (!a) throw bad('Only upcoming booked appointments can be moved.');
    const blockMs = a.ends_at - a.starts_at;
    const startMs = Number(start);
    const endMs = startMs + blockMs;
    const target = staffId ? Number(staffId) : a.staff_id;
    const st = db.prepare('SELECT id FROM staff WHERE id = ? AND business_id = ? AND active = 1').get(target, biz.id);
    if (!st) throw bad('Unknown staff member.');
    let ok;
    if (force) {
      ok = !overlapsAny(startMs, endMs, staffBusy(db, target, startMs, endMs, apptId));
    } else {
      const date = utcToLocal(startMs, biz.timezone).date;
      const fake = [{ duration_min: blockMs / 60000, buffer_min: 0 }];
      ok = slotsForDay(db, biz, fake, [st], date, { now, admin: true, excludeApptId: apptId }).some((s) => s.start === startMs);
    }
    if (!ok) throw new HttpError(409, 'That time is not free.');
    db.prepare('UPDATE appointments SET starts_at = ?, ends_at = ?, staff_id = ?, reminder_sent = 0 WHERE id = ?')
      .run(startMs, endMs, target, apptId);
    return { id: apptId, start: startMs, end: endMs, staffId: target };
  });
}
