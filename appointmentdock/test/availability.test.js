import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSlots, blockMinutes, pickStaff } from '../src/availability.js';
import { localToUtc } from '../src/tz.js';

const tz = 'America/Chicago';
const date = '2026-10-06'; // Tuesday
const at = (min) => localToUtc(date, min, tz);

test('slots respect hours, busy time and lead time', () => {
  const slots = computeSlots({
    date, tz, interval: 30, blockMin: 60, earliest: at(0),
    staff: [{ id: 1, hours: [{ weekday: 2, start_min: 540, end_min: 720 }], busy: [[at(600), at(630)]] }],
  });
  // 9:00 ok (ends 10:00), 9:30 overlaps 10:00-10:30, 10:00 overlaps, 10:30 ok, 11:00 ok (ends 12:00)
  assert.deepEqual(slots.map((s) => (s.start - at(0)) / 60000), [540, 630, 660]);
});

test('lead time and split shifts', () => {
  const slots = computeSlots({
    date, tz, interval: 60, blockMin: 60, earliest: at(600),
    staff: [{ id: 1, hours: [{ weekday: 2, start_min: 540, end_min: 720 }, { weekday: 2, start_min: 780, end_min: 900 }], busy: [] }],
  });
  assert.deepEqual(slots.map((s) => (s.start - at(0)) / 60000), [600, 660, 780, 840]);
});

test('any-staff merges and reports who is free', () => {
  const slots = computeSlots({
    date, tz, interval: 60, blockMin: 60, earliest: 0,
    staff: [
      { id: 1, hours: [{ weekday: 2, start_min: 540, end_min: 660 }], busy: [[at(540), at(600)]] },
      { id: 2, hours: [{ weekday: 2, start_min: 540, end_min: 600 }], busy: [] },
    ],
  });
  assert.deepEqual(slots.map((s) => [(s.start - at(0)) / 60000, s.staffIds]), [[540, [2]], [600, [1]]]);
});

test('wrong weekday gives nothing', () => {
  assert.equal(computeSlots({ date, tz, interval: 15, blockMin: 30, earliest: 0, staff: [{ id: 1, hours: [{ weekday: 3, start_min: 0, end_min: 1440 }], busy: [] }] }).length, 0);
});

test('helpers', () => {
  assert.equal(blockMinutes([{ duration_min: 30, buffer_min: 5 }, { duration_min: 20, buffer_min: 0 }]), 55);
  assert.equal(pickStaff([3, 1, 2], new Map([[1, 4], [2, 1], [3, 1]])), 2);
});
