export const MISSIONS = ['savanna', 'rescue', 'downed', 'convoy', 'desert', 'hold', 'hvt', 'night', 'market', 'bridge', 'overwatch'] as const;
export type Mission = (typeof MISSIONS)[number];
export const FLAGS = ['captured', 'no_civilians', 'all_trucks', 'all_hostages', 'campaign_done'] as const;

export const LIMITS = {
    dailyCap: 2000,
    coinsPerMinute: 40,
    missionMax: 800,
    lossShare: 0.25,
    minWinSeconds: 60,
    maxSessionSeconds: 4 * 3600,
    clockSlackSeconds: 30,
    sessionsPerDay: 60,
    strikesToFlag: 3,
    saveBytes: 32 * 1024,
    boardMax: 50,
};

export const SHOP: Record<string, { name: string; price: number }> = {
    'camo-desert': { name: 'Desert camo', price: 600 },
    'camo-night': { name: 'Night camo', price: 600 },
    'callsign-gold': { name: 'Gold callsign', price: 1500 },
    'drone-skin': { name: 'Urban drone paint', price: 900 },
};

export const COIN_PACKS: Record<string, { coins: number; kobo: number }> = {
    'coins-1000': { coins: 1000, kobo: 50_000 },
    'coins-2500': { coins: 2500, kobo: 100_000 },
    'coins-6000': { coins: 6000, kobo: 200_000 },
};

export const PRIZES_NGN = [50_000, 25_000, 10_000];

export class Bad extends Error {}

export type Run = {
    score: number;
    won: boolean;
    time: number;
    lost: number;
    units: number;
    prisoners: number;
    flags: string[];
};

const int = (v: unknown, min: number, max: number, what: string) => {
    if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) throw new Bad(`${what} must be a whole number from ${min} to ${max}`);
    return v as number;
};

export function parseRun(b: Record<string, unknown>): Run {
    if (typeof b.won !== 'boolean') throw new Bad('won must be true or false');
    const units = int(b.units, 1, 30, 'units');
    return {
        score: int(b.score, 0, 1_000_000, 'score'),
        won: b.won,
        time: int(b.time, 1, LIMITS.maxSessionSeconds, 'time'),
        lost: int(b.lost, 0, units, 'lost'),
        units,
        prisoners: int(b.prisoners ?? 0, 0, 300, 'prisoners'),
        flags: (Array.isArray(b.flags) ? b.flags : []).filter((f): f is string => (FLAGS as readonly unknown[]).includes(f)),
    };
}

export const maxGain = (won: boolean, seconds: number) =>
    Math.floor(Math.min(LIMITS.missionMax, (LIMITS.coinsPerMinute * seconds) / 60) * (won ? 1 : LIMITS.lossShare));

export function judge(run: Run, elapsedSeconds: number): string | null {
    if (run.time > elapsedSeconds + LIMITS.clockSlackSeconds) return 'Claims more play time than has passed';
    if (run.won && run.time < LIMITS.minWinSeconds) return 'Won faster than the mission allows';
    if (run.score > maxGain(run.won, Math.min(run.time, elapsedSeconds))) return 'Score is too high for the time played';
    return null;
}

export const credit = (score: number, earnedToday: number) => Math.max(0, Math.min(score, LIMITS.dailyCap - earnedToday));

export const callsign = (v: unknown) => {
    const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
    if (!/^[\p{L}\p{N} _.'-]{2,16}$/u.test(s)) throw new Bad("Callsign: 2 to 16 letters, numbers, spaces, _ . ' -");
    return s;
};

const lagos = (d: Date) => new Date(d.getTime() + 3600e3);

export const lagosDay = (d = new Date()) => lagos(d).toISOString().slice(0, 10);

export function weekId(d = new Date()) {
    const t = lagos(d);
    const thursday = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 3 - ((t.getUTCDay() + 6) % 7)));
    const year = thursday.getUTCFullYear();
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const firstThursday = jan4.getTime() + (3 - ((jan4.getUTCDay() + 6) % 7)) * 864e5;
    const week = 1 + Math.round((thursday.getTime() - firstThursday) / (7 * 864e5));
    return `${year}-W${String(week).padStart(2, '0')}`;
}

export function daily(date = lagosDay()) {
    let h = 2166136261;
    for (const c of date) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    return { date, mission: MISSIONS[h % MISSIONS.length], seed: (h % 2147483646) + 1 };
}

type Facts = Run & { mission: string; daily: boolean };
type History = { wins: number; missionsWon: Set<string> };

export const ACHIEVEMENTS: { key: string; name: string; test: (r: Facts, h: History) => boolean }[] = [
    { key: 'first_win', name: 'First Contact', test: (r) => r.won },
    { key: 'flawless', name: 'Everyone Home', test: (r) => r.won && r.lost === 0 },
    { key: 'quick', name: 'Lightning Raid', test: (r) => r.won && r.time < 300 },
    { key: 'prisoners', name: 'Hands Up', test: (r) => r.prisoners >= 10 },
    { key: 'pilot', name: 'No One Left Behind', test: (r) => r.won && r.mission === 'downed' },
    { key: 'hostages', name: 'All Home', test: (r) => r.won && r.mission === 'rescue' && r.flags.includes('all_hostages') },
    { key: 'convoy', name: 'Every Truck', test: (r) => r.won && r.flags.includes('all_trucks') },
    { key: 'captured', name: 'Taken Alive', test: (r) => r.won && r.mission === 'hvt' && r.flags.includes('captured') },
    { key: 'clean', name: 'Clean Hands', test: (r) => r.won && r.mission === 'market' && r.flags.includes('no_civilians') },
    { key: 'night', name: 'Owl Eyes', test: (r) => r.won && r.mission === 'night' },
    { key: 'daily', name: 'Daily Duty', test: (r) => r.won && r.daily },
    { key: 'campaign', name: 'Commander of the North-East', test: (r) => r.won && r.flags.includes('campaign_done') },
    { key: 'every', name: 'Full Tour', test: (r, h) => MISSIONS.every((m) => h.missionsWon.has(m)) },
    { key: 'veteran', name: 'Veteran', test: (r, h) => h.wins >= 25 },
];
