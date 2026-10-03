// Email (Resend) and SMS (Twilio) notifications. When credentials are not
// configured, messages are recorded as "skipped" so the app works without them.
import { formatInstant } from './tz.js';

export function createNotifier(db, cfg, log = console) {
  const emailOn = !!(cfg.RESEND_API_KEY && cfg.EMAIL_FROM);
  const smsOn = !!(cfg.TWILIO_ACCOUNT_SID && cfg.TWILIO_AUTH_TOKEN && (cfg.TWILIO_MESSAGING_SERVICE_SID || cfg.TWILIO_FROM));

  function record(apptId, channel, kind, recipient, status, error = '') {
    db.prepare(`INSERT INTO notifications (appointment_id, channel, kind, recipient, status, error, created_at)
      VALUES (?,?,?,?,?,?,?)`).run(apptId, channel, kind, recipient, status, String(error).slice(0, 500), Date.now());
  }

  async function sendEmail(apptId, kind, to, subject, text, html) {
    if (!to) return;
    if (!emailOn) return record(apptId, 'email', kind, to, 'skipped', 'Email not configured');
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: cfg.EMAIL_FROM, to: [to], subject, text, html }),
      });
      if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
      record(apptId, 'email', kind, to, 'sent');
    } catch (e) {
      log.error('email failed', e.message);
      record(apptId, 'email', kind, to, 'failed', e.message);
    }
  }

  async function sendSms(apptId, kind, to, body) {
    const phone = normalizePhone(to);
    if (!phone) return;
    if (!smsOn) return record(apptId, 'sms', kind, phone, 'skipped', 'SMS not configured');
    try {
      const form = new URLSearchParams({ To: phone, Body: body });
      if (cfg.TWILIO_MESSAGING_SERVICE_SID) form.set('MessagingServiceSid', cfg.TWILIO_MESSAGING_SERVICE_SID);
      else form.set('From', cfg.TWILIO_FROM);
      const auth = Buffer.from(`${cfg.TWILIO_ACCOUNT_SID}:${cfg.TWILIO_AUTH_TOKEN}`).toString('base64');
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.TWILIO_ACCOUNT_SID}/Messages.json`, {
        method: 'POST', headers: { Authorization: `Basic ${auth}` }, body: form,
      });
      if (!r.ok) throw new Error(`Twilio ${r.status}: ${await r.text()}`);
      record(apptId, 'sms', kind, phone, 'sent');
    } catch (e) {
      log.error('sms failed', e.message);
      record(apptId, 'sms', kind, phone, 'failed', e.message);
    }
  }

  function details(apptId) {
    const a = db.prepare(`
      SELECT a.*, b.name AS biz_name, b.timezone, b.address, b.phone AS biz_phone, b.email AS biz_email,
             b.notify_email, b.notify_sms, b.slug,
             c.name AS cust_name, c.email AS cust_email, c.phone AS cust_phone,
             s.name AS staff_name, s.email AS staff_email
      FROM appointments a
      JOIN businesses b ON b.id = a.business_id
      JOIN customers c ON c.id = a.customer_id
      JOIN staff s ON s.id = a.staff_id
      WHERE a.id = ?`).get(apptId);
    if (!a) return null;
    a.services = db.prepare('SELECT name FROM appointment_services WHERE appointment_id = ? ORDER BY position')
      .all(apptId).map((r) => r.name);
    a.when = formatInstant(a.starts_at, a.timezone, { year: 'numeric' });
    a.manageUrl = `${cfg.APP_URL}/m/${a.manage_token}`;
    return a;
  }

  function emailHtml(a, heading, intro) {
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px;margin:auto;color:#111">
      <h2 style="margin:0 0 8px">${esc(heading)}</h2><p>${esc(intro)}</p>
      <table style="border-collapse:collapse;width:100%;margin:16px 0">
        <tr><td style="padding:6px 0;color:#666">When</td><td style="padding:6px 0"><b>${esc(a.when)}</b></td></tr>
        <tr><td style="padding:6px 0;color:#666">What</td><td style="padding:6px 0">${esc(a.services.join(', '))}</td></tr>
        <tr><td style="padding:6px 0;color:#666">With</td><td style="padding:6px 0">${esc(a.staff_name)}</td></tr>
        ${a.address ? `<tr><td style="padding:6px 0;color:#666">Where</td><td style="padding:6px 0">${esc(a.address)}</td></tr>` : ''}
      </table>
      <p><a href="${esc(a.manageUrl)}" style="display:inline-block;background:#111;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">View or cancel</a></p>
      <p style="color:#888;font-size:12px">${esc(a.biz_name)}${a.biz_phone ? ' · ' + esc(a.biz_phone) : ''}</p></div>`;
  }

  async function bookingConfirmed(apptId) {
    const a = details(apptId);
    if (!a) return;
    const summary = `${a.services.join(', ')} with ${a.staff_name} on ${a.when}`;
    const jobs = [];
    if (a.notify_email) {
      jobs.push(sendEmail(apptId, 'confirmation', a.cust_email, `Booked: ${a.biz_name}, ${a.when}`,
        `Hi ${a.cust_name}, you're booked at ${a.biz_name}: ${summary}.\nView or cancel: ${a.manageUrl}`,
        emailHtml(a, "You're booked", `Hi ${a.cust_name}, here are your appointment details.`)));
      const staffTo = a.staff_email || a.biz_email;
      jobs.push(sendEmail(apptId, 'staff_new', staffTo, `New booking: ${a.cust_name}, ${a.when}`,
        `New booking from ${a.cust_name} (${a.cust_phone || a.cust_email}): ${summary}.`,
        emailHtml(a, 'New booking', `${a.cust_name} (${a.cust_phone || a.cust_email}) booked an appointment.`)));
    }
    if (a.notify_sms) {
      jobs.push(sendSms(apptId, 'confirmation', a.cust_phone,
        `${a.biz_name}: you're booked for ${summary}. Manage: ${a.manageUrl}`));
    }
    await Promise.all(jobs);
  }

  async function bookingCancelled(apptId, by) {
    const a = details(apptId);
    if (!a) return;
    const jobs = [];
    if (a.notify_email) {
      jobs.push(sendEmail(apptId, 'cancellation', a.cust_email, `Cancelled: ${a.biz_name}, ${a.when}`,
        `Your appointment at ${a.biz_name} on ${a.when} was cancelled.`,
        emailHtml(a, 'Appointment cancelled', `Your appointment at ${a.biz_name} was cancelled.`)));
      if (by === 'customer') {
        jobs.push(sendEmail(apptId, 'staff_cancel', a.staff_email || a.biz_email, `Cancelled: ${a.cust_name}, ${a.when}`,
          `${a.cust_name} cancelled their ${a.when} appointment.`,
          emailHtml(a, 'Booking cancelled', `${a.cust_name} cancelled this appointment.`)));
      }
    }
    if (a.notify_sms) jobs.push(sendSms(apptId, 'cancellation', a.cust_phone, `${a.biz_name}: your ${a.when} appointment was cancelled.`));
    await Promise.all(jobs);
  }

  async function sendDueReminders(now = Date.now()) {
    const due = db.prepare(`
      SELECT a.id FROM appointments a JOIN businesses b ON b.id = a.business_id
      WHERE a.status = 'booked' AND a.reminder_sent = 0 AND a.starts_at > ?
        AND a.starts_at <= ? + b.reminder_hours * 3600000
        AND a.created_at < a.starts_at - b.reminder_hours * 1800000`).all(now, now);
    for (const { id } of due) {
      db.prepare('UPDATE appointments SET reminder_sent = 1 WHERE id = ?').run(id);
      const a = details(id);
      const jobs = [];
      if (a.notify_email) {
        jobs.push(sendEmail(id, 'reminder', a.cust_email, `Reminder: ${a.biz_name}, ${a.when}`,
          `Reminder: ${a.services.join(', ')} with ${a.staff_name} on ${a.when}.\nView or cancel: ${a.manageUrl}`,
          emailHtml(a, 'Appointment reminder', `Hi ${a.cust_name}, this is a reminder of your upcoming appointment.`)));
      }
      if (a.notify_sms) jobs.push(sendSms(id, 'reminder', a.cust_phone,
        `Reminder from ${a.biz_name}: ${a.when} with ${a.staff_name}. Manage: ${a.manageUrl}`));
      await Promise.all(jobs);
    }
    return due.length;
  }

  async function verifyEmail(to, name, link) {
    const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    await sendEmail(null, 'verify', to, 'Confirm your email for AppointmentDock',
      `Hi ${name || 'there'}, confirm your email to see your bookings: ${link}`,
      `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto"><p>Hi ${esc(name || 'there')},</p>
      <p>Confirm your email address to see and manage your bookings.</p>
      <p><a href="${esc(link)}" style="display:inline-block;background:#111;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Confirm email</a></p></div>`);
  }

  return { emailOn, smsOn, bookingConfirmed, bookingCancelled, sendDueReminders, verifyEmail };
}

export function normalizePhone(p) {
  if (!p) return '';
  const digits = String(p).replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits.length >= 8 ? digits : '';
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return '';
}
