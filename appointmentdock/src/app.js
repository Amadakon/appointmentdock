import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, tx } from './db.js';
import {
  hashPassword, verifyPassword, createSession, sessionUser, destroySession, passwordProblem,
  createPasswordToken, consumePasswordToken, peekPasswordToken, rateLimiter, sha256,
} from './auth.js';
import { Router, HttpError, bad, notFound, forbidden, unauthorized, parseCookies, readJson, sendJson, v } from './http.js';
import { loadServices, eligibleStaff, slotsForDay, availableDays, book, reschedule } from './booking.js';
import { createNotifier, normalizePhone } from './notify.js';
import { isValidTimeZone, localToUtc, parseDate, todayIn, addDays } from './tz.js';
import { seedDemo } from './seed.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const COOKIE = 'ad_session';
const RESERVED_SLUGS = new Set(['api', 'admin', 'login', 'setup', 'dashboard', 'b', 'm', 'health', 'static', 'assets', 'app']);

export function loadConfig(env = process.env) {
  const appPath = (env.APP_PATH || '').replace(/\/+$/, '');
  return {
    PORT: Number(env.PORT || 8080),
    APP_PATH: appPath,
    APP_URL: (env.APP_URL || `http://localhost:${env.PORT || 8080}${appPath}`).replace(/\/+$/, ''),
    DATA_DIR: env.DATA_DIR || './data',
    COOKIE_SECURE: env.COOKIE_SECURE === 'true',
    SESSION_DAYS: Number(env.SESSION_DAYS || 30),
    PLATFORM_ADMIN_EMAIL: (env.PLATFORM_ADMIN_EMAIL || '').trim().toLowerCase(),
    PLATFORM_ADMIN_PASSWORD: env.PLATFORM_ADMIN_PASSWORD || '',
    SETUP_TOKEN: env.SETUP_TOKEN || '',
    SEED_DEMO: env.SEED_DEMO === 'true',
    RESEND_API_KEY: env.RESEND_API_KEY || '',
    EMAIL_FROM: env.EMAIL_FROM || '',
    TWILIO_ACCOUNT_SID: env.TWILIO_ACCOUNT_SID || '',
    TWILIO_AUTH_TOKEN: env.TWILIO_AUTH_TOKEN || '',
    TWILIO_MESSAGING_SERVICE_SID: env.TWILIO_MESSAGING_SERVICE_SID || '',
    TWILIO_FROM: env.TWILIO_FROM || '',
    TRUST_PROXY: env.TRUST_PROXY !== 'false',
  };
}

export function createApp(cfg, { db = null, log = console } = {}) {
  db = db || openDb(path.join(cfg.DATA_DIR, 'appointmentdock.db'));
  const notifier = createNotifier(db, cfg, log);
  const loginLimit = rateLimiter(10, 15 * 60000);
  const bookLimit = rateLimiter(20, 60 * 60000);
  const r = new Router();

  bootstrap(db, cfg, log);

  // ---------- helpers ----------
  const now = () => Date.now();
  const bizById = (id) => db.prepare('SELECT * FROM businesses WHERE id = ?').get(id);
  const bizBySlug = (slug) => db.prepare('SELECT * FROM businesses WHERE slug = ? AND active = 1').get(slug);
  const requireUser = (ctx) => { if (!ctx.user) throw unauthorized(); return ctx.user; };
  const requireRole = (ctx, ...roles) => {
    const u = requireUser(ctx);
    if (!roles.includes(u.role)) throw forbidden();
    return u;
  };
  // Business the signed-in user is working on. Platform admins pick one with ?business=ID.
  const workBiz = (ctx, { ownerOnly = false } = {}) => {
    const u = requireRole(ctx, 'platform', 'owner', 'staff');
    if (ownerOnly && u.role === 'staff') throw forbidden('Only the business owner can do that.');
    const id = u.role === 'platform' ? Number(ctx.query.get('business')) : u.business_id;
    const b = id && bizById(id);
    if (!b) throw notFound('Business not found');
    return b;
  };
  const staffOf = (biz, id) => {
    const s = db.prepare('SELECT * FROM staff WHERE id = ? AND business_id = ?').get(Number(id), biz.id);
    if (!s) throw notFound('Staff member not found');
    return s;
  };
  // Owners can edit anyone; staff can only edit their own schedule.
  const canEditStaff = (ctx, staffId) => {
    if (ctx.user.role === 'staff' && ctx.user.staff_id !== Number(staffId)) throw forbidden();
  };
  const sessionCookie = (token, maxAge) => [
    `${COOKIE}=${token}`, `Path=${cfg.APP_PATH || '/'}`, 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${maxAge}`, cfg.COOKIE_SECURE ? 'Secure' : '',
  ].filter(Boolean).join('; ');
  const setupLink = (token) => `${cfg.APP_URL}/setup?token=${encodeURIComponent(token)}`;

  function publicBiz(b) {
    return {
      id: b.id, slug: b.slug, name: b.name, industry: b.industry, timezone: b.timezone, phone: b.phone,
      email: b.email, address: b.address, about: b.about, brand_color: b.brand_color,
      window_days: b.window_days, cancel_hours: b.cancel_hours,
    };
  }

  function apptRows(where, params) {
    const rows = db.prepare(`
      SELECT a.id, a.business_id, a.staff_id, a.customer_id, a.starts_at, a.ends_at, a.status, a.notes, a.total_cents,
             a.source, a.created_at, a.manage_token,
             s.name AS staff_name, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
             b.name AS business_name, b.timezone, b.slug
      FROM appointments a JOIN staff s ON s.id = a.staff_id JOIN customers c ON c.id = a.customer_id
      JOIN businesses b ON b.id = a.business_id
      WHERE ${where} ORDER BY a.starts_at`).all(...params);
    const svc = db.prepare('SELECT service_id, name, duration_min, price_cents FROM appointment_services WHERE appointment_id = ? ORDER BY position');
    for (const a of rows) a.services = svc.all(a.id);
    return rows;
  }

  function rangeFromQuery(ctx, biz) {
    const from = ctx.query.get('from') || todayIn(biz.timezone);
    const to = ctx.query.get('to') || addDays(from, 7);
    if (!parseDate(from) || !parseDate(to)) throw bad('Invalid date range.');
    return [localToUtc(from, 0, biz.timezone), localToUtc(to, 0, biz.timezone)];
  }

  // ---------- auth ----------
  r.post('/api/auth/login', async (ctx) => {
    if (!loginLimit(ctx.ip)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
    const body = await readJson(ctx.req);
    const email = v.email(body.email, 'Email', { required: true });
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !verifyPassword(String(body.password || ''), user.password_hash)) throw unauthorized('Wrong email or password.');
    const token = createSession(db, user.id, cfg.SESSION_DAYS);
    ctx.setCookie(sessionCookie(token, cfg.SESSION_DAYS * 86400));
    return { ok: true, role: user.role };
  });

  r.post('/api/auth/logout', (ctx) => {
    destroySession(db, ctx.cookies[COOKIE]);
    ctx.setCookie(sessionCookie('', 0));
    return { ok: true };
  });

  r.get('/api/me', (ctx) => {
    if (!ctx.user) return { user: null };
    const u = ctx.user;
    const biz = u.business_id ? bizById(u.business_id) : null;
    return {
      user: { id: u.id, email: u.email, name: u.name, phone: u.phone, role: u.role, staff_id: u.staff_id, email_verified: !!u.email_verified },
      business: biz ? { ...publicBiz(biz) } : null,
      integrations: { email: notifier.emailOn, sms: notifier.smsOn },
    };
  });

  r.get('/api/auth/token', (ctx) => {
    const info = peekPasswordToken(db, ctx.query.get('token'));
    if (!info) throw notFound('This link has expired or was already used.');
    return info;
  });

  r.post('/api/auth/token', async (ctx) => {
    if (!loginLimit(ctx.ip)) throw new HttpError(429, 'Too many attempts. Try again later.');
    const body = await readJson(ctx.req);
    const problem = passwordProblem(body.password);
    if (problem) throw bad(problem);
    const userId = tx(db, () => {
      const id = consumePasswordToken(db, body.token);
      if (!id) throw notFound('This link has expired or was already used.');
      db.prepare('UPDATE users SET password_hash = ?, email_verified = 1 WHERE id = ?').run(hashPassword(body.password), id);
      if (body.name) db.prepare("UPDATE users SET name = ? WHERE id = ? AND name = ''").run(v.str(body.name, 'Name', { max: 100 }), id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      return id;
    });
    const token = createSession(db, userId, cfg.SESSION_DAYS);
    ctx.setCookie(sessionCookie(token, cfg.SESSION_DAYS * 86400));
    return { ok: true };
  });

  r.post('/api/auth/password', async (ctx) => {
    const u = requireUser(ctx);
    const body = await readJson(ctx.req);
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(u.id);
    if (!verifyPassword(String(body.current || ''), row.password_hash)) throw bad('Current password is wrong.');
    const problem = passwordProblem(body.password);
    if (problem) throw bad(problem);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(body.password), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(u.id, sha256(ctx.cookies[COOKIE]));
    return { ok: true };
  });

  r.post('/api/auth/signup', async (ctx) => {
    if (!loginLimit(ctx.ip)) throw new HttpError(429, 'Too many attempts. Try again later.');
    const body = await readJson(ctx.req);
    const email = v.email(body.email, 'Email', { required: true });
    const name = v.str(body.name, 'Name', { max: 100, required: true });
    const phone = v.str(body.phone, 'Phone', { max: 30 });
    const problem = passwordProblem(body.password);
    if (problem) throw bad(problem);
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'An account with that email already exists. Sign in instead.');
    const id = Number(db.prepare("INSERT INTO users (email, name, phone, password_hash, role, created_at) VALUES (?,?,?,?, 'customer', ?)")
      .run(email, name, phone, hashPassword(body.password), now()).lastInsertRowid);
    ctx.setCookie(sessionCookie(createSession(db, id, cfg.SESSION_DAYS), cfg.SESSION_DAYS * 86400));
    sendVerification(id);
    return { ok: true };
  });

  // Customer accounts must confirm their email before bookings made under it are shown.
  function sendVerification(userId) {
    const u = db.prepare('SELECT email, name FROM users WHERE id = ?').get(userId);
    const link = `${cfg.APP_URL}/verify?token=${encodeURIComponent(createPasswordToken(db, userId, 72))}`;
    notifier.verifyEmail(u.email, u.name, link).catch((e) => log.error(e));
  }
  const verifyLimit = rateLimiter(5, 60 * 60000);
  r.post('/api/auth/verify/resend', (ctx) => {
    const u = requireUser(ctx);
    if (u.email_verified) return { ok: true };
    if (!verifyLimit(String(u.id))) throw new HttpError(429, 'Please wait a bit before asking again.');
    if (!notifier.emailOn) throw bad('Email sending is not set up yet, so we cannot confirm your address right now.');
    sendVerification(u.id);
    return { ok: true };
  });
  r.post('/api/auth/verify', async (ctx) => {
    const body = await readJson(ctx.req);
    const id = consumePasswordToken(db, body.token);
    if (!id) throw notFound('This link has expired or was already used.');
    db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(id);
    return { ok: true };
  });

  // ---------- public booking ----------
  r.get('/api/public/:slug', (ctx) => {
    const b = bizBySlug(ctx.params.slug);
    if (!b) throw notFound('Business not found');
    const services = db.prepare(`SELECT id, name, description, category, duration_min, price_cents FROM services
      WHERE business_id = ? AND active = 1 ORDER BY sort, id`).all(b.id);
    const staff = db.prepare('SELECT id, name, title, bio FROM staff WHERE business_id = ? AND active = 1 ORDER BY sort, id').all(b.id);
    const ss = db.prepare('SELECT service_id FROM staff_services WHERE staff_id = ?');
    for (const s of staff) s.service_ids = ss.all(s.id).map((x) => x.service_id);
    const me = ctx.user ? { name: ctx.user.name, email: ctx.user.email, phone: ctx.user.phone } : null;
    return { business: publicBiz(b), services, staff, today: todayIn(b.timezone), me };
  });

  function publicQuery(ctx) {
    const b = bizBySlug(ctx.params.slug);
    if (!b) throw notFound('Business not found');
    const ids = (ctx.query.get('services') || '').split(',').filter(Boolean);
    const services = loadServices(db, b.id, ids);
    const staff = eligibleStaff(db, b.id, services, ctx.query.get('staff') || 'any');
    return { b, services, staff };
  }

  r.get('/api/public/:slug/days', (ctx) => {
    const { b, services, staff } = publicQuery(ctx);
    const from = ctx.query.get('from') || todayIn(b.timezone);
    if (!parseDate(from)) throw bad('Invalid date.');
    const days = Math.min(Number(ctx.query.get('days') || 42), 62);
    return { days: availableDays(db, b, services, staff, from, days) };
  });

  r.get('/api/public/:slug/slots', (ctx) => {
    const { b, services, staff } = publicQuery(ctx);
    const date = ctx.query.get('date');
    const slots = slotsForDay(db, b, services, staff, date);
    return { date, slots: slots.map((s) => ({ start: s.start, staffIds: s.staffIds })) };
  });

  r.post('/api/public/:slug/book', async (ctx) => {
    if (!bookLimit(ctx.ip)) throw new HttpError(429, 'Too many bookings from this connection. Please call the business.');
    const b = bizBySlug(ctx.params.slug);
    if (!b) throw notFound('Business not found');
    const body = await readJson(ctx.req);
    const customer = {
      name: v.str(body.name, 'Name', { max: 100, required: true }),
      email: v.email(body.email, 'Email', { required: true }),
      phone: v.str(body.phone, 'Phone', { max: 30 }),
    };
    if (customer.phone && !normalizePhone(customer.phone)) throw bad('Phone number doesn\'t look right.');
    const notes = v.str(body.notes, 'Notes', { max: 1000 });
    const res = book(db, b, {
      serviceIds: body.services, staffChoice: body.staff || 'any', start: body.start, customer, notes, source: 'online',
    });

    // Optional account creation so the customer can see bookings later.
    let account = null;
    if (body.password && !ctx.user) {
      const problem = passwordProblem(body.password);
      if (!problem && !db.prepare('SELECT 1 FROM users WHERE email = ?').get(customer.email)) {
        const id = Number(db.prepare("INSERT INTO users (email, name, phone, password_hash, role, created_at) VALUES (?,?,?,?, 'customer', ?)")
          .run(customer.email, customer.name, customer.phone, hashPassword(body.password), now()).lastInsertRowid);
        ctx.setCookie(sessionCookie(createSession(db, id, cfg.SESSION_DAYS), cfg.SESSION_DAYS * 86400));
        sendVerification(id);
        account = 'created';
      } else account = problem ? 'weak_password' : 'exists';
    }
    notifier.bookingConfirmed(res.id).catch((e) => log.error(e));
    const staff = db.prepare('SELECT name FROM staff WHERE id = ?').get(res.staffId);
    return { ok: true, token: res.token, start: res.start, end: res.end, staff: staff.name, total_cents: res.total, account };
  });

  // ---------- manage link (no login) ----------
  function apptByToken(token) {
    const rows = apptRows('a.manage_token = ?', [token]);
    if (!rows.length) throw notFound('Appointment not found');
    return rows[0];
  }
  r.get('/api/manage/:token', (ctx) => {
    const a = apptByToken(ctx.params.token);
    const b = bizById(a.business_id);
    const canCancel = a.status === 'booked' && a.starts_at - now() >= b.cancel_hours * 3600000;
    return {
      appointment: {
        id: a.id, starts_at: a.starts_at, ends_at: a.ends_at, status: a.status, staff_name: a.staff_name,
        customer_name: a.customer_name, services: a.services.map((s) => ({ name: s.name, duration_min: s.duration_min, price_cents: s.price_cents })),
        total_cents: a.total_cents,
      },
      business: publicBiz(b), canCancel,
    };
  });
  r.post('/api/manage/:token/cancel', (ctx) => {
    const a = apptByToken(ctx.params.token);
    const b = bizById(a.business_id);
    if (a.status !== 'booked') throw bad('This appointment is not active.');
    if (a.starts_at - now() < b.cancel_hours * 3600000) throw bad(`Online cancellation closes ${b.cancel_hours} hours before the appointment. Please call ${b.name}${b.phone ? ' at ' + b.phone : ''}.`);
    db.prepare("UPDATE appointments SET status = 'cancelled', cancelled_at = ? WHERE id = ?").run(now(), a.id);
    notifier.bookingCancelled(a.id, 'customer').catch((e) => log.error(e));
    return { ok: true };
  });

  // ---------- customer portal ----------
  r.get('/api/customer/appointments', (ctx) => {
    const u = requireUser(ctx);
    if (!u.email_verified) return { appointments: [], unverified: true, canVerify: notifier.emailOn };
    return { appointments: apptRows('c.email = ? COLLATE NOCASE', [u.email]).map((a) => ({ ...a, customer_email: undefined, customer_phone: undefined })) };
  });

  // ---------- platform admin ----------
  r.get('/api/platform/businesses', (ctx) => {
    requireRole(ctx, 'platform');
    const rows = db.prepare(`SELECT b.*,
        (SELECT COUNT(*) FROM staff s WHERE s.business_id = b.id AND s.active = 1) AS staff_count,
        (SELECT COUNT(*) FROM appointments a WHERE a.business_id = b.id AND a.status = 'booked' AND a.starts_at > ?) AS upcoming,
        (SELECT email FROM users u WHERE u.business_id = b.id AND u.role = 'owner' ORDER BY u.id LIMIT 1) AS owner_email
      FROM businesses b ORDER BY b.name`).all(now());
    return { businesses: rows };
  });

  function bizFields(body, partial) {
    const out = {};
    const has = (k) => !partial || k in body;
    if (has('name')) out.name = v.str(body.name, 'Name', { max: 120, required: true });
    if (has('slug')) {
      const slug = v.str(body.slug, 'Booking link', { max: 60, required: true }).toLowerCase();
      if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) throw bad('Booking link can only use lowercase letters, numbers and dashes.');
      if (RESERVED_SLUGS.has(slug)) throw bad('That booking link is reserved.');
      out.slug = slug;
    }
    if (has('industry')) out.industry = v.str(body.industry, 'Industry', { max: 60 });
    if (has('timezone')) {
      const tz = v.str(body.timezone, 'Time zone', { max: 60 }) || 'America/Chicago';
      if (!isValidTimeZone(tz)) throw bad('Unknown time zone.');
      out.timezone = tz;
    }
    if (has('email')) out.email = v.email(body.email, 'Business email');
    if (has('phone')) out.phone = v.str(body.phone, 'Phone', { max: 30 });
    if (has('address')) out.address = v.str(body.address, 'Address', { max: 300 });
    if (has('about')) out.about = v.str(body.about, 'About', { max: 2000 });
    if (has('brand_color')) {
      const c = v.str(body.brand_color, 'Brand color', { max: 7 }) || '#2563eb';
      if (!/^#[0-9a-fA-F]{6}$/.test(c)) throw bad('Brand color must look like #2563eb.');
      out.brand_color = c;
    }
    if (has('slot_interval')) out.slot_interval = v.int(body.slot_interval, 'Slot interval', { min: 5, max: 120 });
    if (has('lead_minutes')) out.lead_minutes = v.int(body.lead_minutes, 'Minimum notice', { min: 0, max: 20160 });
    if (has('window_days')) out.window_days = v.int(body.window_days, 'Booking window', { min: 1, max: 365 });
    if (has('cancel_hours')) out.cancel_hours = v.int(body.cancel_hours, 'Cancellation cutoff', { min: 0, max: 336 });
    if (has('reminder_hours')) out.reminder_hours = v.int(body.reminder_hours, 'Reminder lead', { min: 1, max: 168 });
    if (has('notify_email')) out.notify_email = v.bool(body.notify_email);
    if (has('notify_sms')) out.notify_sms = v.bool(body.notify_sms);
    return out;
  }

  function updateBiz(id, fields) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    try {
      db.prepare(`UPDATE businesses SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'That booking link is already taken.');
      throw e;
    }
  }

  r.post('/api/platform/businesses', async (ctx) => {
    requireRole(ctx, 'platform');
    const body = await readJson(ctx.req);
    const f = bizFields({ timezone: 'America/Chicago', ...body }, true);
    if (!f.name || !f.slug) throw bad('Name and booking link are required.');
    let id;
    try {
      id = Number(db.prepare('INSERT INTO businesses (name, slug, created_at) VALUES (?,?,?)').run(f.name, f.slug, now()).lastInsertRowid);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'That booking link is already taken.');
      throw e;
    }
    updateBiz(id, f);
    return { business: bizById(id) };
  });

  r.patch('/api/platform/businesses/:id', async (ctx) => {
    requireRole(ctx, 'platform');
    const b = bizById(Number(ctx.params.id));
    if (!b) throw notFound();
    const body = await readJson(ctx.req);
    const f = bizFields(body, true);
    if ('active' in body) f.active = v.bool(body.active);
    updateBiz(b.id, f);
    return { business: bizById(b.id) };
  });

  // Create (or re-invite) the owner login for a business; returns a set-password link.
  r.post('/api/platform/businesses/:id/owner', async (ctx) => {
    requireRole(ctx, 'platform');
    const b = bizById(Number(ctx.params.id));
    if (!b) throw notFound();
    const body = await readJson(ctx.req);
    const email = v.email(body.email, 'Owner email', { required: true });
    const name = v.str(body.name, 'Owner name', { max: 100 });
    const userId = inviteUser(email, name, 'owner', b.id, null);
    return { link: setupLink(createPasswordToken(db, userId, 24 * 7)) };
  });

  function inviteUser(email, name, role, bizId, staffId) {
    const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (existing) {
      if (existing.role === 'platform') throw bad('That email belongs to the platform admin.');
      if (existing.role !== 'customer' && existing.business_id !== bizId) throw new HttpError(409, 'That email already has a login for another business.');
      db.prepare('UPDATE users SET role = ?, business_id = ?, staff_id = ?, name = COALESCE(NULLIF(?, \'\'), name) WHERE id = ?')
        .run(role, bizId, staffId, name, existing.id);
      return existing.id;
    }
    return Number(db.prepare('INSERT INTO users (email, name, role, business_id, staff_id, created_at) VALUES (?,?,?,?,?,?)')
      .run(email, name, role, bizId, staffId, now()).lastInsertRowid);
  }

  r.get('/api/platform/stats', (ctx) => {
    requireRole(ctx, 'platform');
    const one = (sql, ...p) => Object.values(db.prepare(sql).get(...p))[0];
    return {
      businesses: one('SELECT COUNT(*) FROM businesses WHERE active = 1'),
      upcoming: one("SELECT COUNT(*) FROM appointments WHERE status = 'booked' AND starts_at > ?", now()),
      last30: one('SELECT COUNT(*) FROM appointments WHERE created_at > ?', now() - 30 * 86400000),
      integrations: { email: notifier.emailOn, sms: notifier.smsOn },
    };
  });

  // ---------- business: settings ----------
  r.get('/api/biz/settings', (ctx) => ({ business: workBiz(ctx) }));
  r.patch('/api/biz/settings', async (ctx) => {
    const b = workBiz(ctx, { ownerOnly: true });
    const body = await readJson(ctx.req);
    const f = bizFields(body, true);
    if (ctx.user.role !== 'platform') delete f.slug; // booking link is set by the platform admin
    updateBiz(b.id, f);
    return { business: bizById(b.id) };
  });

  // ---------- business: services ----------
  r.get('/api/biz/services', (ctx) => {
    const b = workBiz(ctx);
    return { services: db.prepare('SELECT * FROM services WHERE business_id = ? ORDER BY active DESC, sort, id').all(b.id) };
  });
  function serviceFields(body) {
    return {
      name: v.str(body.name, 'Service name', { max: 120, required: true }),
      description: v.str(body.description, 'Description', { max: 1000 }),
      category: v.str(body.category, 'Category', { max: 60 }),
      duration_min: v.int(body.duration_min, 'Duration', { min: 5, max: 720 }),
      buffer_min: v.int(body.buffer_min ?? 0, 'Buffer', { min: 0, max: 240 }),
      price_cents: Math.round(Number(body.price ?? 0) * 100),
      active: 'active' in body ? v.bool(body.active) : 1,
      sort: v.int(body.sort ?? 0, 'Order', { min: 0, max: 10000 }),
    };
  }
  r.post('/api/biz/services', async (ctx) => {
    const b = workBiz(ctx, { ownerOnly: true });
    const f = serviceFields(await readJson(ctx.req));
    if (!Number.isFinite(f.price_cents) || f.price_cents < 0) throw bad('Price must be a positive number.');
    const id = Number(db.prepare(`INSERT INTO services (business_id, name, description, category, duration_min, buffer_min, price_cents, active, sort)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(b.id, f.name, f.description, f.category, f.duration_min, f.buffer_min, f.price_cents, f.active, f.sort).lastInsertRowid);
    // New services are offered by every active staff member by default.
    const ins = db.prepare('INSERT OR IGNORE INTO staff_services (staff_id, service_id) VALUES (?,?)');
    for (const s of db.prepare('SELECT id FROM staff WHERE business_id = ? AND active = 1').all(b.id)) ins.run(s.id, id);
    return { service: db.prepare('SELECT * FROM services WHERE id = ?').get(id) };
  });
  r.put('/api/biz/services/:id', async (ctx) => {
    const b = workBiz(ctx, { ownerOnly: true });
    const s = db.prepare('SELECT * FROM services WHERE id = ? AND business_id = ?').get(Number(ctx.params.id), b.id);
    if (!s) throw notFound();
    const f = serviceFields(await readJson(ctx.req));
    if (!Number.isFinite(f.price_cents) || f.price_cents < 0) throw bad('Price must be a positive number.');
    db.prepare(`UPDATE services SET name=?, description=?, category=?, duration_min=?, buffer_min=?, price_cents=?, active=?, sort=? WHERE id=?`)
      .run(f.name, f.description, f.category, f.duration_min, f.buffer_min, f.price_cents, f.active, f.sort, s.id);
    return { service: db.prepare('SELECT * FROM services WHERE id = ?').get(s.id) };
  });
  r.delete('/api/biz/services/:id', (ctx) => {
    const b = workBiz(ctx, { ownerOnly: true });
    // Soft delete keeps history intact.
    db.prepare('UPDATE services SET active = 0 WHERE id = ? AND business_id = ?').run(Number(ctx.params.id), b.id);
    return { ok: true };
  });

  // ---------- business: staff ----------
  function staffDetail(s) {
    return {
      ...s,
      service_ids: db.prepare('SELECT service_id FROM staff_services WHERE staff_id = ?').all(s.id).map((x) => x.service_id),
      hours: db.prepare('SELECT weekday, start_min, end_min FROM staff_hours WHERE staff_id = ? ORDER BY weekday, start_min').all(s.id),
      time_off: db.prepare('SELECT id, starts_at, ends_at, reason FROM time_off WHERE staff_id = ? AND ends_at > ? ORDER BY starts_at').all(s.id, now() - 86400000),
      login: db.prepare('SELECT email, password_hash IS NOT NULL AS active FROM users WHERE staff_id = ?').get(s.id) || null,
    };
  }
  r.get('/api/biz/staff', (ctx) => {
    const b = workBiz(ctx);
    const rows = db.prepare('SELECT * FROM staff WHERE business_id = ? ORDER BY active DESC, sort, id').all(b.id);
    return { staff: rows.map(staffDetail) };
  });
  function staffFields(body) {
    return {
      name: v.str(body.name, 'Name', { max: 100, required: true }),
      title: v.str(body.title, 'Title', { max: 100 }),
      email: v.email(body.email, 'Email'),
      phone: v.str(body.phone, 'Phone', { max: 30 }),
      bio: v.str(body.bio, 'Bio', { max: 1000 }),
      active: 'active' in body ? v.bool(body.active) : 1,
      sort: v.int(body.sort ?? 0, 'Order', { min: 0, max: 10000 }),
    };
  }
  function setStaffServices(b, staffId, ids) {
    if (!Array.isArray(ids)) return;
    db.prepare('DELETE FROM staff_services WHERE staff_id = ?').run(staffId);
    const ok = db.prepare('SELECT 1 FROM services WHERE id = ? AND business_id = ?');
    const ins = db.prepare('INSERT OR IGNORE INTO staff_services (staff_id, service_id) VALUES (?,?)');
    for (const id of ids) if (ok.get(Number(id), b.id)) ins.run(staffId, Number(id));
  }
  r.post('/api/biz/staff', async (ctx) => {
    const b = workBiz(ctx, { ownerOnly: true });
    const body = await readJson(ctx.req);
    const f = staffFields(body);
    const id = tx(db, () => {
      const id = Number(db.prepare('INSERT INTO staff (business_id, name, title, email, phone, bio, active, sort) VALUES (?,?,?,?,?,?,?,?)')
        .run(b.id, f.name, f.title, f.email, f.phone, f.bio, f.active, f.sort).lastInsertRowid);
      setStaffServices(b, id, body.service_ids ?? db.prepare('SELECT id FROM services WHERE business_id = ? AND active = 1').all(b.id).map((s) => s.id));
      // Sensible default hours: Tue-Sat 9-5 can be edited right away.
      if (!Array.isArray(body.hours)) {
        const ins = db.prepare('INSERT INTO staff_hours (staff_id, weekday, start_min, end_min) VALUES (?,?,?,?)');
        for (const d of [2, 3, 4, 5, 6]) ins.run(id, d, 540, 1020);
      } else setHours(id, body.hours);
      return id;
    });
    return { staff: staffDetail(staffOf(b, id)) };
  });
  r.put('/api/biz/staff/:id', async (ctx) => {
    const b = workBiz(ctx, { ownerOnly: true });
    const s = staffOf(b, ctx.params.id);
    const body = await readJson(ctx.req);
    const f = staffFields(body);
    tx(db, () => {
      db.prepare('UPDATE staff SET name=?, title=?, email=?, phone=?, bio=?, active=?, sort=? WHERE id=?')
        .run(f.name, f.title, f.email, f.phone, f.bio, f.active, f.sort, s.id);
      setStaffServices(b, s.id, body.service_ids);
    });
    return { staff: staffDetail(staffOf(b, s.id)) };
  });

  function setHours(staffId, hours) {
    if (!Array.isArray(hours) || hours.length > 50) throw bad('Invalid hours.');
    const clean = hours.map((h) => ({
      weekday: v.int(h.weekday, 'Day', { min: 0, max: 6 }),
      start_min: v.int(h.start_min, 'Start', { min: 0, max: 1440 }),
      end_min: v.int(h.end_min, 'End', { min: 0, max: 1440 }),
    }));
    for (const h of clean) if (h.end_min <= h.start_min) throw bad('Each shift must end after it starts.');
    for (const a of clean) for (const c of clean) {
      if (a !== c && a.weekday === c.weekday && a.start_min < c.end_min && c.start_min < a.end_min) throw bad('Shifts on the same day overlap.');
    }
    db.prepare('DELETE FROM staff_hours WHERE staff_id = ?').run(staffId);
    const ins = db.prepare('INSERT INTO staff_hours (staff_id, weekday, start_min, end_min) VALUES (?,?,?,?)');
    for (const h of clean) ins.run(staffId, h.weekday, h.start_min, h.end_min);
  }
  r.put('/api/biz/staff/:id/hours', async (ctx) => {
    const b = workBiz(ctx);
    const s = staffOf(b, ctx.params.id);
    canEditStaff(ctx, s.id);
    const body = await readJson(ctx.req);
    tx(db, () => setHours(s.id, body.hours));
    return { staff: staffDetail(s) };
  });
  r.post('/api/biz/staff/:id/time-off', async (ctx) => {
    const b = workBiz(ctx);
    const s = staffOf(b, ctx.params.id);
    canEditStaff(ctx, s.id);
    const body = await readJson(ctx.req);
    // Either whole days (from/to dates) or exact times (date + start/end minutes).
    let start, end;
    if (!parseDate(body.from)) throw bad('Pick a start date.');
    if (body.start_min != null && body.end_min != null && body.start_min !== '' && body.end_min !== '') {
      start = localToUtc(body.from, v.int(body.start_min, 'Start', { min: 0, max: 1440 }), b.timezone);
      end = localToUtc(body.from, v.int(body.end_min, 'End', { min: 0, max: 1440 }), b.timezone);
    } else {
      const to = body.to && parseDate(body.to) ? body.to : body.from;
      start = localToUtc(body.from, 0, b.timezone);
      end = localToUtc(addDays(to, 1), 0, b.timezone);
    }
    if (end <= start) throw bad('Time off must end after it starts.');
    db.prepare('INSERT INTO time_off (staff_id, starts_at, ends_at, reason) VALUES (?,?,?,?)').run(s.id, start, end, v.str(body.reason, 'Reason', { max: 200 }));
    return { staff: staffDetail(s) };
  });
  r.delete('/api/biz/staff/:id/time-off/:offId', (ctx) => {
    const b = workBiz(ctx);
    const s = staffOf(b, ctx.params.id);
    canEditStaff(ctx, s.id);
    db.prepare('DELETE FROM time_off WHERE id = ? AND staff_id = ?').run(Number(ctx.params.offId), s.id);
    return { staff: staffDetail(s) };
  });
  r.post('/api/biz/staff/:id/invite', async (ctx) => {
    const b = workBiz(ctx, { ownerOnly: true });
    const s = staffOf(b, ctx.params.id);
    const body = await readJson(ctx.req);
    const email = v.email(body.email || s.email, 'Email', { required: true });
    if (!s.email) db.prepare('UPDATE staff SET email = ? WHERE id = ?').run(email, s.id);
    const userId = inviteUser(email, s.name, 'staff', b.id, s.id);
    return { link: setupLink(createPasswordToken(db, userId, 24 * 7)) };
  });

  // ---------- business: appointments ----------
  r.get('/api/biz/appointments', (ctx) => {
    const b = workBiz(ctx);
    const [from, to] = rangeFromQuery(ctx, b);
    let where = 'a.business_id = ? AND a.starts_at >= ? AND a.starts_at < ?';
    const params = [b.id, from, to];
    if (ctx.user.role === 'staff') { where += ' AND a.staff_id = ?'; params.push(ctx.user.staff_id); }
    else if (ctx.query.get('staff')) { where += ' AND a.staff_id = ?'; params.push(Number(ctx.query.get('staff'))); }
    if (ctx.query.get('status') !== 'all') where += " AND a.status != 'cancelled'";
    return { appointments: apptRows(where, params).map(({ manage_token, ...a }) => a), timezone: b.timezone };
  });

  r.get('/api/biz/slots', (ctx) => {
    const b = workBiz(ctx);
    const ids = (ctx.query.get('services') || '').split(',').filter(Boolean);
    const services = loadServices(db, b.id, ids);
    const staff = eligibleStaff(db, b.id, services, ctx.query.get('staff') || 'any');
    return { slots: slotsForDay(db, b, services, staff, ctx.query.get('date'), { admin: true }) };
  });

  r.post('/api/biz/appointments', async (ctx) => {
    const b = workBiz(ctx);
    const body = await readJson(ctx.req);
    let staffChoice = body.staff || 'any';
    if (ctx.user.role === 'staff') staffChoice = ctx.user.staff_id;
    const customer = {
      name: v.str(body.name, 'Customer name', { max: 100, required: true }),
      email: v.email(body.email, 'Email'),
      phone: v.str(body.phone, 'Phone', { max: 30 }),
    };
    let start = body.start;
    if (body.date && body.time != null) {
      const [hh, mm] = String(body.time).split(':').map(Number);
      start = localToUtc(body.date, hh * 60 + mm, b.timezone);
    }
    const res = book(db, b, {
      serviceIds: body.services, staffChoice, start, customer, notes: v.str(body.notes, 'Notes', { max: 1000 }),
      source: 'admin', admin: true, force: !!body.force,
    });
    if (body.notify !== false) notifier.bookingConfirmed(res.id).catch((e) => log.error(e));
    return { ok: true, id: res.id };
  });

  r.patch('/api/biz/appointments/:id', async (ctx) => {
    const b = workBiz(ctx);
    const id = Number(ctx.params.id);
    const a = db.prepare('SELECT * FROM appointments WHERE id = ? AND business_id = ?').get(id, b.id);
    if (!a) throw notFound();
    if (ctx.user.role === 'staff' && a.staff_id !== ctx.user.staff_id) throw forbidden();
    const body = await readJson(ctx.req);
    if (body.status) {
      if (!['booked', 'cancelled', 'completed', 'no_show'].includes(body.status)) throw bad('Unknown status.');
      if (body.status === 'booked' && a.status === 'cancelled') throw bad('Book a new appointment instead of restoring a cancelled one.');
      db.prepare('UPDATE appointments SET status = ?, cancelled_at = ? WHERE id = ?')
        .run(body.status, body.status === 'cancelled' ? now() : null, id);
      if (body.status === 'cancelled' && a.status === 'booked' && body.notify !== false) notifier.bookingCancelled(id, 'business').catch((e) => log.error(e));
    }
    if ('notes' in body) db.prepare('UPDATE appointments SET notes = ? WHERE id = ?').run(v.str(body.notes, 'Notes', { max: 1000 }), id);
    if (body.date && body.time != null) {
      const [hh, mm] = String(body.time).split(':').map(Number);
      const start = localToUtc(body.date, hh * 60 + mm, b.timezone);
      const staffId = ctx.user.role === 'staff' ? ctx.user.staff_id : body.staff_id;
      reschedule(db, b, id, { start, staffId, force: !!body.force });
    }
    return { appointment: apptRows('a.id = ?', [id]).map(({ manage_token, ...x }) => x)[0] };
  });

  r.get('/api/biz/customers', (ctx) => {
    const b = workBiz(ctx, { ownerOnly: true });
    const q = `%${(ctx.query.get('q') || '').trim()}%`;
    return {
      customers: db.prepare(`SELECT c.*, COUNT(a.id) AS visits, MAX(a.starts_at) AS last_visit FROM customers c
        LEFT JOIN appointments a ON a.customer_id = c.id AND a.status != 'cancelled'
        WHERE c.business_id = ? AND (c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ?)
        GROUP BY c.id ORDER BY last_visit DESC NULLS LAST, c.name LIMIT 200`).all(b.id, q, q, q),
    };
  });

  r.get('/api/biz/notifications', (ctx) => {
    const b = workBiz(ctx, { ownerOnly: true });
    return {
      notifications: db.prepare(`SELECT n.* FROM notifications n JOIN appointments a ON a.id = n.appointment_id
        WHERE a.business_id = ? ORDER BY n.id DESC LIMIT 100`).all(b.id),
    };
  });

  // ---------- pages ----------
  const pages = {
    '/': 'index.html', '/login': 'login.html', '/setup': 'setup.html', '/dashboard': 'dashboard.html', '/signup': 'login.html', '/verify': 'setup.html',
  };
  const htmlCache = new Map();
  function renderPage(file) {
    if (htmlCache.has(file)) return htmlCache.get(file);
    const html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8')
      .replace('<head>', `<head>\n<base href="${cfg.APP_PATH}/">`);
    htmlCache.set(file, html);
    return html;
  }
  const MIME = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

  function servePage(res, file, status = 200) {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'",
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
    });
    res.end(renderPage(file));
  }

  function serveStatic(res, pathname) {
    const rel = pathname.replace(/^\/static\//, '');
    if (rel.includes('..')) return false;
    const file = path.join(PUBLIC_DIR, 'static', rel);
    if (!file.startsWith(path.join(PUBLIC_DIR, 'static'))) return false;
    let data;
    try { data = fs.readFileSync(file); } catch { return false; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
    return true;
  }

  // ---------- request handler ----------
  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    let pathname = url.pathname;
    // Works whether or not the proxy strips the base path.
    if (cfg.APP_PATH && (pathname === cfg.APP_PATH || pathname.startsWith(cfg.APP_PATH + '/'))) pathname = pathname.slice(cfg.APP_PATH.length) || '/';

    try {
      if (pathname === '/health') return sendJson(res, 200, { ok: true });
      if (pathname.startsWith('/static/') && req.method === 'GET') {
        if (serveStatic(res, pathname)) return;
        throw notFound();
      }
      if (!pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
        if (pages[pathname]) return servePage(res, pages[pathname]);
        if (/^\/b\/[a-z0-9-]+\/?$/.test(pathname)) return servePage(res, 'book.html');
        if (/^\/m\/[\w-]+\/?$/.test(pathname)) return servePage(res, 'manage.html');
        return servePage(res, 'notfound.html', 404);
      }

      // CSRF defence: mutating API calls must be same-origin JSON.
      if (req.method !== 'GET') {
        const origin = req.headers.origin;
        if (origin) {
          const host = req.headers['x-forwarded-host'] || req.headers.host;
          if (new URL(origin).host !== host) throw forbidden('Cross-site request blocked');
        }
      }

      const m = r.match(req.method, pathname);
      if (!m) throw notFound();
      if (m.methodNotAllowed) throw new HttpError(405, 'Method not allowed');
      const cookies = parseCookies(req.headers.cookie);
      const extraHeaders = {};
      const ctx = {
        req, res, params: m.params, query: url.searchParams, cookies,
        user: sessionUser(db, cookies[COOKIE]),
        ip: (cfg.TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress,
        setCookie: (c) => { extraHeaders['Set-Cookie'] = c; },
      };
      const data = await m.handler(ctx);
      if (!res.headersSent) sendJson(res, 200, data ?? { ok: true }, extraHeaders);
    } catch (e) {
      if (res.headersSent) return;
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
      log.error(e);
      sendJson(res, 500, { error: 'Something went wrong on our side.' });
    }
  }

  let reminderTimer = null;
  function startJobs() {
    const tick = () => {
      notifier.sendDueReminders().catch((e) => log.error('reminders', e));
      db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
    };
    reminderTimer = setInterval(tick, 5 * 60000);
    setTimeout(tick, 10000);
  }
  function close() { if (reminderTimer) clearInterval(reminderTimer); db.close(); }

  return { handle, db, notifier, startJobs, close };
}

function bootstrap(db, cfg, log) {
  if (cfg.PLATFORM_ADMIN_EMAIL) {
    let admin = db.prepare('SELECT * FROM users WHERE email = ?').get(cfg.PLATFORM_ADMIN_EMAIL);
    if (!admin) {
      db.prepare("INSERT INTO users (email, name, role, email_verified, created_at) VALUES (?, 'Platform admin', 'platform', 1, ?)").run(cfg.PLATFORM_ADMIN_EMAIL, Date.now());
      admin = db.prepare('SELECT * FROM users WHERE email = ?').get(cfg.PLATFORM_ADMIN_EMAIL);
    } else if (admin.role !== 'platform') {
      db.prepare("UPDATE users SET role = 'platform', business_id = NULL, staff_id = NULL WHERE id = ?").run(admin.id);
    }
    if (cfg.PLATFORM_ADMIN_PASSWORD && !admin.password_hash) {
      db.prepare('UPDATE users SET password_hash = ?, email_verified = 1 WHERE id = ?').run(hashPassword(cfg.PLATFORM_ADMIN_PASSWORD), admin.id);
    } else if (!admin.password_hash && cfg.SETUP_TOKEN) {
      db.prepare('INSERT OR IGNORE INTO password_tokens (token_hash, user_id, expires_at) VALUES (?,?,?)')
        .run(sha256(cfg.SETUP_TOKEN), admin.id, Date.now() + 14 * 86400000);
      log.log(`Platform admin setup pending: ${cfg.APP_URL}/setup?token=<SETUP_TOKEN>`);
    }
  }
  if (cfg.SEED_DEMO && !db.prepare("SELECT 1 FROM businesses WHERE slug = 'demo'").get()) seedDemo(db);
}

