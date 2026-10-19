import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions';
import { FieldValue } from 'firebase-admin/firestore';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { db, uidOf, audit, ledger } from './db.js';
import { COIN_PACKS } from './rules.js';

const PAYSTACK_SECRET_KEY = defineSecret('PAYSTACK_SECRET_KEY');

export const startPurchase = onCall({ secrets: [PAYSTACK_SECRET_KEY] }, async (req) => {
    const uid = uidOf(req);
    const pack = COIN_PACKS[req.data?.pack];
    const email = req.data?.email;
    if (!pack) throw new HttpsError('invalid-argument', 'Unknown coin pack');
    if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpsError('invalid-argument', 'A valid email is needed for the receipt');
    if (!(await db.doc(`players/${uid}`).get()).exists) throw new HttpsError('failed-precondition', 'Set a callsign first');

    const reference = `ffng_${randomUUID()}`;
    await db.doc(`purchases/${reference}`).set({
        uid, pack: req.data.pack, kobo: pack.kobo, coins: pack.coins, status: 'pending', createdAt: FieldValue.serverTimestamp(),
    });
    const res = await fetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: { authorization: `Bearer ${PAYSTACK_SECRET_KEY.value()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ email, amount: pack.kobo, currency: 'NGN', reference, metadata: { uid, pack: req.data.pack } }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.status) {
        logger.error('paystack initialize failed', { status: res.status, message: body.message });
        await db.doc(`purchases/${reference}`).update({ status: 'failed' });
        throw new HttpsError('unavailable', 'Payment could not be started, try again');
    }
    return { reference, authorizationUrl: body.data.authorization_url };
});

const signed = (raw: Buffer, signature: string, secret: string) => {
    const expected = Buffer.from(createHmac('sha512', secret).update(raw).digest('hex'));
    const given = Buffer.from(signature);
    return given.length === expected.length && timingSafeEqual(given, expected);
};

type Charge = { reference?: unknown; amount?: unknown; currency?: unknown; id?: unknown };

export async function creditPurchase(charge: Charge) {
    const reference = String(charge.reference ?? '');
    if (!/^ffng_[0-9a-f-]{36}$/.test(reference)) return 'unknown';
    return db.runTransaction(async (tx) => {
        const ref = db.doc(`purchases/${reference}`);
        const purchase = await tx.get(ref);
        if (!purchase.exists) {
            audit(tx, null, 'payment.unknown', { reference });
            return 'unknown';
        }
        const uid = purchase.get('uid');
        if (purchase.get('status') === 'paid') {
            tx.update(ref, { duplicates: FieldValue.increment(1) });
            audit(tx, uid, 'payment.duplicate', { reference });
            return 'duplicate';
        }
        if (charge.amount !== purchase.get('kobo') || charge.currency !== 'NGN') {
            tx.update(ref, { status: 'mismatch', paid: { amount: charge.amount ?? null, currency: charge.currency ?? null } });
            audit(tx, uid, 'payment.mismatch', { reference, amount: charge.amount ?? null, expected: purchase.get('kobo') });
            return 'mismatch';
        }
        const coins = purchase.get('coins');
        tx.update(ref, { status: 'paid', paystackId: charge.id ?? null, paidAt: FieldValue.serverTimestamp() });
        tx.update(db.doc(`players/${uid}`), { coins: FieldValue.increment(coins) });
        ledger(tx, uid, coins, 'purchase', reference);
        audit(tx, uid, 'payment.credited', { reference, coins, kobo: purchase.get('kobo') });
        return 'credited';
    });
}

export const paystackWebhook = onRequest({ secrets: [PAYSTACK_SECRET_KEY] }, async (req, res) => {
    if (req.method !== 'POST') {
        res.status(405).end();
        return;
    }
    if (!signed(req.rawBody, req.get('x-paystack-signature') ?? '', PAYSTACK_SECRET_KEY.value())) {
        logger.warn('paystack webhook with a bad signature', { ip: req.ip });
        res.status(401).end();
        return;
    }
    const event = req.body ?? {};
    if (event.event !== 'charge.success') {
        res.status(200).end();
        return;
    }
    try {
        const outcome = await creditPurchase(event.data ?? {});
        logger.info('paystack charge.success', { reference: event.data?.reference, outcome });
        res.status(200).json({ outcome });
    } catch (e) {
        logger.error('paystack webhook failed, Paystack will retry', e);
        res.status(500).end();
    }
});
