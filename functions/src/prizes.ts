import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions';
import { FieldValue } from 'firebase-admin/firestore';
import { db, audit } from './db.js';
import { PRIZES_NGN, weekId } from './rules.js';

export async function awardWeek(week: string) {
    const top = await db.collection(`weeks/${week}/scores`).orderBy('score', 'desc').limit(25).get();
    const players = await Promise.all(top.docs.map((d) => db.doc(`players/${d.id}`).get()));
    const eligible = top.docs.filter((d, i) => players[i].get('verified') === true && players[i].get('flagged') !== true);
    const winners = eligible.slice(0, PRIZES_NGN.length);

    return db.runTransaction(async (tx) => {
        const marker = db.doc(`prizeWeeks/${week}`);
        if ((await tx.get(marker)).exists) return [];
        winners.forEach((d, i) => {
            tx.create(db.doc(`payouts/${week}_${d.id}`), {
                week, uid: d.id, name: d.get('name'), place: i + 1, score: d.get('score'), naira: PRIZES_NGN[i],
                status: 'awaiting_approval', createdAt: FieldValue.serverTimestamp(),
            });
            audit(tx, d.id, 'prize.awarded', { week, place: i + 1, naira: PRIZES_NGN[i] });
        });
        tx.create(marker, { winners: winners.map((d) => d.id), skipped: top.size - eligible.length, at: FieldValue.serverTimestamp() });
        return winners.map((d, i) => ({ uid: d.id, place: i + 1, naira: PRIZES_NGN[i] }));
    });
}

export const closeWeek = onSchedule({ schedule: '5 0 * * 1', timeZone: 'Africa/Lagos' }, async () => {
    const week = weekId(new Date(Date.now() - 864e5));
    const winners = await awardWeek(week);
    logger.info('week closed', { week, winners });
});
