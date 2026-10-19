import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, type Transaction } from 'firebase-admin/firestore';
import { setGlobalOptions } from 'firebase-functions/v2';
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { Bad } from './rules.js';

setGlobalOptions({ region: 'europe-west1', maxInstances: 10 });
initializeApp();
export const db = getFirestore();

export const uidOf = (req: CallableRequest) => {
    if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in first');
    return req.auth.uid;
};

export const audit = (tx: Transaction, uid: string | null, type: string, details: Record<string, unknown> = {}) =>
    tx.set(db.collection('audit').doc(), { uid, type, ...details, at: FieldValue.serverTimestamp() });

export const ledger = (tx: Transaction, uid: string, amount: number, reason: string, ref: string) =>
    tx.set(db.collection(`players/${uid}/ledger`).doc(), { amount, reason, ref, at: FieldValue.serverTimestamp() });

export const checked = <T>(fn: () => T) => {
    try {
        return fn();
    } catch (e) {
        if (e instanceof Bad) throw new HttpsError('invalid-argument', e.message);
        throw e;
    }
};
