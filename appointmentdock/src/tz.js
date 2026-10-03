// Time-zone helpers built on Intl (no dependencies).
// Wall-clock times are expressed as a local date string (YYYY-MM-DD) plus
// minutes after local midnight. Instants are UTC epoch milliseconds.

const fmtCache = new Map();
function formatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz) {
  try { formatter(tz); return true; } catch { return false; }
}

function parts(ms, tz) {
  const out = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) out[p.type] = p.value;
  return {
    y: +out.year, m: +out.month, d: +out.day,
    h: +out.hour % 24, min: +out.minute, s: +out.second,
  };
}

// Offset (minutes) of tz from UTC at the given instant. Chicago in winter => -360.
export function offsetMinutes(tz, ms) {
  const p = parts(ms, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

export function parseDate(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

// Local wall time -> UTC ms. For times inside a DST gap, returns the instant
// just after the gap; for repeated times, returns the first occurrence.
export function localToUtc(dateStr, minutes, tz) {
  const p = parseDate(dateStr);
  if (!p) throw new Error('Invalid date');
  const guess = Date.UTC(p.y, p.m - 1, p.d, 0, minutes);
  const o1 = offsetMinutes(tz, guess);
  let t = guess - o1 * 60000;
  const o2 = offsetMinutes(tz, t);
  if (o2 !== o1) {
    const t2 = guess - o2 * 60000;
    if (offsetMinutes(tz, t2) === o2) t = Math.min(t, t2);
  }
  return t;
}

export function utcToLocal(ms, tz) {
  const p = parts(ms, tz);
  const date = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  return { date, minutes: p.h * 60 + p.min, weekday: weekdayOf(date) };
}

export function weekdayOf(dateStr) {
  const p = parseDate(dateStr);
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
}

export function addDays(dateStr, n) {
  const p = parseDate(dateStr);
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
  return dt.toISOString().slice(0, 10);
}

export function todayIn(tz, now = Date.now()) {
  return utcToLocal(now, tz).date;
}

export function formatInstant(ms, tz, opts = {}) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', ...opts,
  }).format(new Date(ms));
}
