import test from 'node:test';
import assert from 'node:assert/strict';
import { localToUtc, utcToLocal, offsetMinutes, addDays, weekdayOf } from '../src/tz.js';

test('Chicago offsets across DST', () => {
  assert.equal(offsetMinutes('America/Chicago', Date.UTC(2026, 0, 15, 12)), -360);
  assert.equal(offsetMinutes('America/Chicago', Date.UTC(2026, 6, 15, 12)), -300);
});

test('localToUtc round-trips', () => {
  const t = localToUtc('2026-10-05', 9 * 60 + 30, 'America/Chicago');
  assert.equal(new Date(t).toISOString(), '2026-10-05T14:30:00.000Z');
  assert.deepEqual(utcToLocal(t, 'America/Chicago'), { date: '2026-10-05', minutes: 570, weekday: 1 });
});

test('spring-forward gap and fall-back overlap', () => {
  // 2026-03-08 02:30 does not exist in Chicago
  const gap = localToUtc('2026-03-08', 150, 'America/Chicago');
  assert.equal(utcToLocal(gap, 'America/Chicago').minutes, 210);
  // 2026-11-01 01:30 happens twice; we use the first (CDT)
  const dup = localToUtc('2026-11-01', 90, 'America/Chicago');
  assert.equal(new Date(dup).toISOString(), '2026-11-01T06:30:00.000Z');
});

test('date helpers', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(weekdayOf('2026-10-03'), 6);
});
