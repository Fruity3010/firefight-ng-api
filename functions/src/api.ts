import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { db, uidOf, audit, ledger, checked } from './db.js';
import { ACHIEVEMENTS, LIMITS, MISSIONS, SHOP, callsign, credit, daily, judge, lagosDay, parseRun, weekId } from './rules.js';

const player = (uid: string) => db.doc(`players/${uid}`);

export const setProfile = onCall(async (req) => {
    const uid = uidOf(req);
    const name = checked(() => callsign(req.data?.name));
    await db.runTransaction(async (tx) => {
        const p = await tx.get(player(uid));
        if (p.exists) return tx.update(player(uid), { name });
        tx.set(player(uid), {
            name, coins: 0, strikes: 0, flagged: false, verified: false,
            wins: 0, missionsWon: [], achievements: [], inventory: [], openSession: null,
            createdAt: FieldValue.serverTimestamp(),
        });
        audit(tx, uid, 'player.created', { name });
    });
    return { name };
});

export const putSave = onCall(async (req) => {
    const uid = uidOf(req);
    const data = req.data?.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpsError('invalid-argument', 'data must be an object');
    if (JSON.stringify(data).length > LIMITS.saveBytes) throw new HttpsError('invalid-argument', 'Save is too big');
    await db.doc(`saves/${uid}`).set({ data, updatedAt: FieldValue.serverTimestamp() });
    return { ok: true };
});

export const getDaily = onCall(() => daily());

export const startSession = onCall(async (req) => {
    const uid = uidOf(req);
    const mission = req.data?.mission;
    if (!MISSIONS.includes(mission)) throw new HttpsError('invalid-argument', 'Unknown mission');
    const today = daily();
    const isDaily = req.data?.daily === true;
    if (isDaily && today.mission !== mission) throw new HttpsError('invalid-argument', "That isn't today's daily mission");

    const session = db.collection('sessions').doc();
    const startedAt = Timestamp.now();
    await db.runTransaction(async (tx) => {
        const day = db.doc(`players/${uid}/days/${lagosDay()}`);
        const [p, d] = await Promise.all([tx.get(player(uid)), tx.get(day)]);
        if (!p.exists) throw new HttpsError('failed-precondition', 'Set a callsign first');
        if (p.get('flagged')) throw new HttpsError('permission-denied', 'This account is under review');
        if ((d.get('sessions') ?? 0) >= LIMITS.sessionsPerDay) throw new HttpsError('resource-exhausted', 'Daily session limit reached');
        const open = p.get('openSession');
        if (open) tx.update(db.doc(`sessions/${open}`), { status: 'abandoned' });
        tx.set(session, { uid, mission, daily: isDaily ? today.date : null, startedAt, status: 'open' });
        tx.set(day, { sessions: FieldValue.increment(1) }, { merge: true });
        tx.update(player(uid), { openSession: session.id });
    });
    return { sessionId: session.id, startedAt: startedAt.toMillis(), seed: isDaily ? today.seed : null };
});

export const submitSession = onCall(async (req) => {
    const uid = uidOf(req);
    const sessionId = req.data?.sessionId;
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9]{20}$/.test(sessionId)) throw new HttpsError('invalid-argument', 'sessionId is missing');
    const run = checked(() => parseRun(req.data));

    return db.runTransaction(async (tx) => {
        const sRef = db.doc(`sessions/${sessionId}`);
        const pRef = player(uid);
        const dayRef = db.doc(`players/${uid}/days/${lagosDay()}`);
        const weekRef = db.doc(`weeks/${weekId()}/scores/${uid}`);
        const [s, p, d] = await Promise.all([tx.get(sRef), tx.get(pRef), tx.get(dayRef)]);
        if (!s.exists || s.get('uid') !== uid) throw new HttpsError('not-found', 'No such session');
        if (s.get('status') !== 'open') throw new HttpsError('failed-precondition', `Session is already ${s.get('status')}`);

        const elapsed = (Date.now() - s.get('startedAt').toMillis()) / 1000;
        const closed = { run, submittedAt: FieldValue.serverTimestamp() };
        tx.update(pRef, { openSession: null });

        if (elapsed > LIMITS.maxSessionSeconds) {
            tx.update(sRef, { ...closed, status: 'expired' });
            return { accepted: false, reason: 'Session expired' };
        }

        const why = judge(run, elapsed);
        if (why) {
            const strikes = (p.get('strikes') ?? 0) + 1;
            const flagged = strikes >= LIMITS.strikesToFlag;
            tx.update(sRef, { ...closed, status: 'rejected', reason: why, elapsed });
            tx.update(pRef, { strikes, flagged });
            if (flagged) tx.delete(weekRef);
            audit(tx, uid, 'session.rejected', { sessionId, reason: why, score: run.score, time: run.time, elapsed, strikes });
            if (flagged) audit(tx, uid, 'player.flagged', { strikes });
            return { accepted: false, reason: why, flagged };
        }

        const earned = d.get('earned') ?? 0;
        const credited = credit(run.score, earned);
        const mission = s.get('mission');
        const missionsWon = new Set<string>(p.get('missionsWon'));
        if (run.won) missionsWon.add(mission);
        const history = { wins: p.get('wins') + (run.won ? 1 : 0), missionsWon };
        const owned = new Set<string>(p.get('achievements'));
        const unlocked = ACHIEVEMENTS.filter((a) => !owned.has(a.key) && a.test({ ...run, mission, daily: !!s.get('daily') }, history));

        tx.update(sRef, { ...closed, status: 'done', credited, elapsed });
        tx.set(dayRef, { earned: earned + credited }, { merge: true });
        tx.update(pRef, {
            coins: FieldValue.increment(credited),
            wins: history.wins,
            missionsWon: [...missionsWon],
            ...(unlocked.length && { achievements: FieldValue.arrayUnion(...unlocked.map((a) => a.key)) }),
        });
        if (credited > 0) {
            ledger(tx, uid, credited, 'session', sessionId);
            tx.set(weekRef, { name: p.get('name'), score: FieldValue.increment(credited), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        }
        audit(tx, uid, 'session.accepted', { sessionId, score: run.score, credited, capped: credited < run.score });
        return {
            accepted: true,
            credited,
            capped: credited < run.score,
            coins: p.get('coins') + credited,
            earnedToday: earned + credited,
            unlocked: unlocked.map(({ key, name }) => ({ key, name })),
        };
    });
});

export const getLeaderboard = onCall(async (req) => {
    const week = req.data?.week ?? weekId();
    if (typeof week !== 'string' || !/^\d{4}-W\d{2}$/.test(week)) throw new HttpsError('invalid-argument', 'week must look like 2026-W43');
    const limit = Math.min(LIMITS.boardMax, Math.max(1, Number.parseInt(req.data?.limit, 10) || 20));
    const scores = db.collection(`weeks/${week}/scores`);
    const top = await scores.orderBy('score', 'desc').limit(limit).get();
    let me = null;
    if (req.auth) {
        const mine = await scores.doc(req.auth.uid).get();
        if (mine.exists) {
            const ahead = await scores.where('score', '>', mine.get('score')).count().get();
            me = { rank: ahead.data().count + 1, score: mine.get('score') };
        }
    }
    return {
        week,
        top: top.docs.map((d, i) => ({ rank: i + 1, name: d.get('name'), score: d.get('score') })),
        me,
    };
});

export const buyItem = onCall(async (req) => {
    const uid = uidOf(req);
    const item = SHOP[req.data?.item];
    if (!item) throw new HttpsError('invalid-argument', 'Unknown item');
    return db.runTransaction(async (tx) => {
        const p = await tx.get(player(uid));
        if (!p.exists) throw new HttpsError('failed-precondition', 'Set a callsign first');
        if ((p.get('inventory') as string[]).includes(req.data.item)) throw new HttpsError('already-exists', 'You already own this');
        if (p.get('coins') < item.price) throw new HttpsError('failed-precondition', 'Not enough coins');
        tx.update(player(uid), { coins: FieldValue.increment(-item.price), inventory: FieldValue.arrayUnion(req.data.item) });
        ledger(tx, uid, -item.price, 'shop', req.data.item);
        audit(tx, uid, 'shop.bought', { item: req.data.item, price: item.price });
        return { coins: p.get('coins') - item.price, item: req.data.item };
    });
});
