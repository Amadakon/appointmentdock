// Pure slot computation. No database access here so it is easy to test.
import { localToUtc, weekdayOf } from './tz.js';

/**
 * @param {object} o
 * @param {string} o.date        Local date YYYY-MM-DD in the business time zone
 * @param {string} o.tz          IANA time zone
 * @param {number} o.interval    Slot step in minutes (e.g. 15)
 * @param {number} o.blockMin    Minutes the appointment occupies (services + buffers)
 * @param {number} o.earliest    Earliest allowed start, UTC ms (now + lead time)
 * @param {number} [o.latest]    Latest allowed start, UTC ms (booking window)
 * @param {Array}  o.staff       [{ id, hours: [{weekday,start_min,end_min}], busy: [[startMs,endMs]] }]
 * @returns {Array<{start:number,end:number,staffIds:number[]}>} sorted by start
 */
export function computeSlots(o) {
  const weekday = weekdayOf(o.date);
  const blockMs = o.blockMin * 60000;
  const byStart = new Map();

  for (const s of o.staff) {
    const windows = s.hours
      .filter((h) => h.weekday === weekday && h.end_min > h.start_min)
      .sort((a, b) => a.start_min - b.start_min);
    for (const w of windows) {
      for (let m = w.start_min; m + o.blockMin <= w.end_min; m += o.interval) {
        const start = localToUtc(o.date, m, o.tz);
        const windowEnd = localToUtc(o.date, w.end_min, o.tz);
        const end = start + blockMs;
        if (end > windowEnd) continue; // DST edge
        if (start < o.earliest) continue;
        if (o.latest != null && start > o.latest) continue;
        if (overlapsAny(start, end, s.busy)) continue;
        const list = byStart.get(start) || [];
        if (!list.includes(s.id)) list.push(s.id);
        byStart.set(start, list);
      }
    }
  }
  return [...byStart.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, staffIds]) => ({ start, end: start + blockMs, staffIds }));
}

export function overlapsAny(start, end, busy) {
  for (const [bs, be] of busy) if (start < be && bs < end) return true;
  return false;
}

// Total minutes an appointment blocks on the calendar.
export function blockMinutes(services) {
  let total = 0;
  for (const s of services) total += (s.duration_min || 0) + (s.buffer_min || 0);
  return total;
}

// Pick a staff member for an "any" booking: whoever has the fewest
// appointments that day, ties broken by id for determinism.
export function pickStaff(candidateIds, dayCounts) {
  return [...candidateIds].sort((a, b) => (dayCounts.get(a) || 0) - (dayCounts.get(b) || 0) || a - b)[0];
}
