import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { db } from '../src/db.js';
import { LIMITS, lagosDay, weekId } from '../src/rules.js';

const PROJECT = 'demo-firefight';
const FUNCTIONS = `http://127.0.0.1:5001/${PROJECT}/europe-west1`;
const SECRET = 'sk_test_emulator';

async function signUp() {
    const res = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }),
    });
    const { idToken, localId } = await res.json();
    return { token: idToken as string, uid: localId as string };
}

async function call(name: string, data: unknown, token?: string) {
    const res = await fetch(`${FUNCTIONS}/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
        body: JSON.stringify({ data }),
    });
    const body = await res.json();
    return body.error ? { error: body.error.status as string, message: body.error.message as string } : body.result;
}

async function newPlayer(name = 'Tester') {
    const p = await signUp();
    await call('setProfile', { name }, p.token);
    return p;
}

async function startedAgo(token: string, seconds: number) {
    const { sessionId } = await call('startSession', { mission: 'savanna' }, token);
    await db.doc(`sessions/${sessionId}`).update({ startedAt: Timestamp.fromMillis(Date.now() - seconds * 1000) });
    return sessionId as string;
}

const audits = async (uid: string, type: string) => (await db.collection('audit').where('uid', '==', uid).where('type', '==', type).get()).size;

const webhook = (body: unknown, secret = SECRET) => {
    const raw = JSON.stringify(body);
    return fetch(`${FUNCTIONS}/paystackWebhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-paystack-signature': createHmac('sha512', secret).update(raw).digest('hex') },
        body: raw,
    });
};

test('sessions need a signed-in player', async () => {
    assert.equal((await call('startSession', { mission: 'savanna' })).error, 'UNAUTHENTICATED');
});

test('a plausible session is credited, scored on the weekly board and audited', async () => {
    const p = await newPlayer('Okon');
    const sessionId = await startedAgo(p.token, 620);
    const r = await call('submitSession', { sessionId, score: 300, won: true, time: 600, lost: 0, units: 4 }, p.token);
    assert.equal(r.accepted, true);
    assert.equal(r.credited, 300);
    assert.equal(r.coins, 300);
    assert.deepEqual(r.unlocked.map((a: { key: string }) => a.key).sort(), ['first_win', 'flawless']);
    assert.equal((await db.doc(`weeks/${weekId()}/scores/${p.uid}`).get()).get('score'), 300);
    assert.equal(await audits(p.uid, 'session.accepted'), 1);

    const board = await call('getLeaderboard', {}, p.token);
    assert.equal(board.me.score, 300);
    assert.ok(board.top.some((e: { name: string }) => e.name === 'Okon'));
});

test('the same session cannot be submitted twice', async () => {
    const p = await newPlayer();
    const sessionId = await startedAgo(p.token, 620);
    const run = { sessionId, score: 300, won: true, time: 600, lost: 0, units: 4 };
    await call('submitSession', run, p.token);
    assert.equal((await call('submitSession', run, p.token)).error, 'FAILED_PRECONDITION');
    assert.equal((await db.doc(`players/${p.uid}`).get()).get('coins'), 300);
});

test('impossible gains are rejected, audited and flag the player after repeated attempts', async () => {
    const p = await newPlayer();
    for (let i = 1; i <= LIMITS.strikesToFlag; i++) {
        const sessionId = await startedAgo(p.token, 120);
        const r = await call('submitSession', { sessionId, score: 5000, won: true, time: 110, lost: 0, units: 4 }, p.token);
        assert.equal(r.accepted, false);
        assert.match(r.reason, /too high/);
        assert.equal(r.flagged, i === LIMITS.strikesToFlag);
    }
    const player = await db.doc(`players/${p.uid}`).get();
    assert.equal(player.get('coins'), 0);
    assert.equal(player.get('flagged'), true);
    assert.equal(await audits(p.uid, 'session.rejected'), LIMITS.strikesToFlag);
    assert.equal((await call('startSession', { mission: 'savanna' }, p.token)).error, 'PERMISSION_DENIED');
});

test('a run claiming more time than has passed is rejected', async () => {
    const p = await newPlayer();
    const sessionId = await startedAgo(p.token, 60);
    const r = await call('submitSession', { sessionId, score: 100, won: true, time: 900, lost: 0, units: 4 }, p.token);
    assert.equal(r.accepted, false);
    assert.match(r.reason, /more play time/);
});

test('earnings stop at the daily cap', async () => {
    const p = await newPlayer();
    await db.doc(`players/${p.uid}/days/${lagosDay()}`).set({ earned: LIMITS.dailyCap - 100 }, { merge: true });
    const sessionId = await startedAgo(p.token, 1300);
    const r = await call('submitSession', { sessionId, score: 700, won: true, time: 1200, lost: 1, units: 4 }, p.token);
    assert.equal(r.accepted, true);
    assert.equal(r.credited, 100);
    assert.equal(r.capped, true);
    assert.equal(r.earnedToday, LIMITS.dailyCap);
});

test('one player cannot submit another player\'s session', async () => {
    const a = await newPlayer(), b = await newPlayer();
    const sessionId = await startedAgo(a.token, 620);
    const r = await call('submitSession', { sessionId, score: 300, won: true, time: 600, lost: 0, units: 4 }, b.token);
    assert.equal(r.error, 'NOT_FOUND');
});

test('a payment sent three times is credited exactly once', async () => {
    const p = await newPlayer();
    const reference = `ffng_${randomUUID()}`;
    await db.doc(`purchases/${reference}`).set({ uid: p.uid, pack: 'coins-1000', kobo: 50_000, coins: 1000, status: 'pending' });
    const event = { event: 'charge.success', data: { id: 99, reference, amount: 50_000, currency: 'NGN' } };

    const outcomes = await Promise.all([webhook(event), webhook(event), webhook(event)].map(async (r) => (await (await r).json()).outcome));
    assert.deepEqual(outcomes.sort(), ['credited', 'duplicate', 'duplicate']);
    const late = await (await webhook(event)).json();
    assert.equal(late.outcome, 'duplicate');

    assert.equal((await db.doc(`players/${p.uid}`).get()).get('coins'), 1000);
    assert.equal((await db.collection(`players/${p.uid}/ledger`).where('ref', '==', reference).get()).size, 1);
    assert.equal(await audits(p.uid, 'payment.credited'), 1);
});

test('webhooks with a bad signature are refused', async () => {
    const res = await webhook({ event: 'charge.success', data: {} }, 'sk_wrong');
    assert.equal(res.status, 401);
});

test('a payment for the wrong amount is not credited', async () => {
    const p = await newPlayer();
    const reference = `ffng_${randomUUID()}`;
    await db.doc(`purchases/${reference}`).set({ uid: p.uid, pack: 'coins-6000', kobo: 200_000, coins: 6000, status: 'pending' });
    const r = await (await webhook({ event: 'charge.success', data: { reference, amount: 100, currency: 'NGN' } })).json();
    assert.equal(r.outcome, 'mismatch');
    assert.equal((await db.doc(`players/${p.uid}`).get()).get('coins'), 0);
});

test('the shop spends coins once per item', async () => {
    const p = await newPlayer();
    await db.doc(`players/${p.uid}`).update({ coins: 700 });
    const r = await call('buyItem', { item: 'camo-desert' }, p.token);
    assert.equal(r.coins, 100);
    assert.equal((await call('buyItem', { item: 'camo-desert' }, p.token)).error, 'ALREADY_EXISTS');
    assert.equal((await call('buyItem', { item: 'camo-night' }, p.token)).error, 'FAILED_PRECONDITION');
});

test('weekly prizes go only to verified, unflagged players, once', async () => {
    const { awardWeek } = await import('../src/prizes.js');
    const week = '2000-W01';
    const seed = [['cheat', 9000, true, true], ['unverified', 8000, false, false], ['first', 7000, true, false], ['second', 6000, true, false]] as const;
    for (const [uid, score, verified, flagged] of seed) {
        await db.doc(`players/${uid}`).set({ name: uid, verified, flagged });
        await db.doc(`weeks/${week}/scores/${uid}`).set({ name: uid, score });
    }
    const winners = await awardWeek(week);
    assert.deepEqual(winners.map((w) => w.uid), ['first', 'second']);
    assert.equal(winners[0].naira, 50_000);
    assert.deepEqual(await awardWeek(week), []);
    assert.equal((await db.collection('payouts').where('week', '==', week).get()).size, 2);
});
