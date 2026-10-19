import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, credit, daily, judge, lagosDay, maxGain, parseRun, weekId, Bad } from '../src/rules.js';

const run = (o = {}) => parseRun({ score: 300, won: true, time: 600, lost: 0, units: 4, ...o });

test('weekId follows ISO weeks in Lagos time', () => {
    assert.equal(weekId(new Date('2026-10-19T08:00:00Z')), '2026-W43');
    assert.equal(weekId(new Date('2026-10-18T22:59:00Z')), '2026-W42');
    assert.equal(weekId(new Date('2026-10-18T23:00:00Z')), '2026-W43');
    assert.equal(weekId(new Date('2021-01-01T12:00:00Z')), '2020-W53');
    assert.equal(weekId(new Date('2024-12-30T12:00:00Z')), '2025-W01');
});

test('lagosDay rolls over at midnight in Lagos, not UTC', () => {
    assert.equal(lagosDay(new Date('2026-10-19T22:59:00Z')), '2026-10-19');
    assert.equal(lagosDay(new Date('2026-10-19T23:00:00Z')), '2026-10-20');
});

test('judge accepts a plausible run', () => {
    assert.equal(judge(run(), 620), null);
});

test('judge rejects impossible gains', () => {
    assert.match(judge(run({ time: 900 }), 300)!, /more play time/);
    assert.match(judge(run({ time: 30, score: 10 }), 40)!, /faster/);
    assert.match(judge(run({ score: maxGain(true, 600) + 1 }), 620)!, /too high/);
    assert.match(judge(run({ score: LIMITS.missionMax + 1, time: 7200 }), 7200)!, /too high/);
    assert.match(judge(run({ won: false, score: 200 }), 620)!, /too high/);
});

test('credit stops at the daily cap', () => {
    assert.equal(credit(500, 0), 500);
    assert.equal(credit(500, LIMITS.dailyCap - 200), 200);
    assert.equal(credit(500, LIMITS.dailyCap), 0);
    assert.equal(credit(500, LIMITS.dailyCap + 10), 0);
});

test('parseRun rejects bad input', () => {
    assert.throws(() => parseRun({ score: -1, won: true, time: 60, lost: 0, units: 1 }), Bad);
    assert.throws(() => parseRun({ score: 1.5, won: true, time: 60, lost: 0, units: 1 }), Bad);
    assert.throws(() => parseRun({ score: 1, won: 'yes', time: 60, lost: 0, units: 1 }), Bad);
    assert.throws(() => parseRun({ score: 1, won: true, time: 60, lost: 5, units: 4 }), Bad);
    assert.deepEqual(run({ flags: ['captured', 'hacked'] }).flags, ['captured']);
});

test('daily is the same for everyone on a day', () => {
    assert.deepEqual(daily('2026-10-19'), daily('2026-10-19'));
    assert.notDeepEqual(daily('2026-10-19'), daily('2026-10-20'));
});
