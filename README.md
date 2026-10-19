# Firefight NG API

Backend for [Firefight NG](https://firefight-ng.netlify.app), a browser tactics game: Nigerian Army patrols against insurgents.
Built on Firebase: Cloud Functions (TypeScript, Node 22), Firestore and Firebase Auth, with Paystack for coin purchases.

The client is never trusted. Every coin a player gets comes from a server-checked session or a signed, verified payment,
and every change to a wallet is written to a ledger and an audit log in the same transaction.

- **Sessions:** the server starts the clock. A score is checked against the real time that has passed, then capped per day,
  added to the wallet and to the weekly leaderboard.
- **Anti-cheat:** impossible scores are rejected and logged. After 3 rejections the account is flagged: it can't play,
  drops off the leaderboard and can't win prizes.
- **Payments:** Paystack checkout started by the server (so the server sets the price). The webhook checks the signature
  and credits each purchase exactly once, even when Paystack sends the same event several times.
- **Weekly prizes:** every Monday the top verified, unflagged players get a payout record awaiting admin approval.
- **Shop:** coins buy cosmetic items.

## Run it

Needs Node 22 and Java 21 (for the Firestore emulator).

```sh
cd functions
npm install
npm test          # builds, starts the Auth, Firestore and Functions emulators, runs every test
npm run serve     # emulators only, for trying calls by hand
```

`npm run test:unit` runs only the scoring rules (no emulator, no Java).

## Deploy

```sh
npx firebase login
npx firebase use --add                                 # pick the Firebase project
npx firebase functions:secrets:set PAYSTACK_SECRET_KEY # sk_live_... or sk_test_...
cd functions && npm run deploy                         # functions and Firestore rules
```

In Firebase Auth, turn on Anonymous sign-in (guests) plus any providers players can link to later (Google, email).
In the Paystack dashboard, set the webhook URL to the deployed `paystackWebhook` URL.
Functions run in `europe-west1` with at most 10 instances each, which caps the bill if something goes wrong.

## API

All functions except `paystackWebhook` are [callable functions](https://firebase.google.com/docs/functions/callable):
call them with the Firebase client SDK (`httpsCallable(functions, 'startSession')`), which sends the player's ID token.
Errors come back as `HttpsError` codes (`unauthenticated`, `invalid-argument`, `failed-precondition`, ...) with a
readable message.

### Players

**`setProfile({ name })` → `{ name }`**
Creates the player on first call (coins 0), renames them after that. `name`: 2 to 16 letters, numbers, spaces, `_ . ' -`.

**`putSave({ data })` → `{ ok }`**
Stores the game's save (campaign, teams, settings). `data` is an object of at most 32 KB.

Players read their own `players/{uid}` and `saves/{uid}` documents directly with the Firestore SDK; nothing else about
other players is readable except the leaderboard.

### Sessions

**`startSession({ mission, daily? })` → `{ sessionId, startedAt, seed }`**
Starts the server clock for a mission. `daily: true` plays today's daily challenge and returns its map seed.
Starting a session abandons any session left open. Limits: 60 sessions per Lagos day; flagged players can't start.

**`submitSession({ sessionId, score, won, time, lost, units, prisoners?, flags? })`**

| field | |
|---|---|
| `score` | coins the game says the player earned |
| `won` | boolean |
| `time` | seconds of play the game counted |
| `lost`, `units` | units lost, units deployed (lost ≤ units ≤ 30) |
| `prisoners` | 0 to 300 |
| `flags` | facts for achievements: `captured`, `no_civilians`, `all_trucks`, `all_hostages`, `campaign_done` |

Accepted: `{ accepted: true, credited, capped, coins, earnedToday, unlocked: [{ key, name }] }`.
`credited` can be less than `score` when the daily cap is reached (`capped: true`).

Rejected: `{ accepted: false, reason, flagged }`. A session is rejected when:

- `time` is more than the real time since `startSession` (plus 30 s of slack),
- a win took under 60 s,
- `score` is more than 40 coins per minute played, more than 800 for one mission, or more than a quarter of that for a loss.

A session can be submitted once; a second submit is `failed-precondition`. Sessions older than 4 hours expire.
Each accepted or rejected session writes an `audit` entry.

**`getDaily()` → `{ date, mission, seed }`**
Today's daily challenge (Lagos date), the same for everyone.

### Leaderboard

**`getLeaderboard({ week?, limit? })` → `{ week, top: [{ rank, name, score }], me: { rank, score } | null }`**
Coins earned that week. `week` like `2026-W43` (ISO week, Lagos time), default this week. `limit` 1 to 50, default 20.
`me` is the caller's place, worked out with a count query rather than by reading the whole board.

### Shop

**`buyItem({ item })` → `{ coins, item }`**
Items: `camo-desert` (600), `camo-night` (600), `callsign-gold` (1500), `drone-skin` (900). Each can be bought once.

### Payments

**`startPurchase({ pack, email })` → `{ reference, authorizationUrl }`**
Packs: `coins-1000` (₦500), `coins-2500` (₦1,000), `coins-6000` (₦2,000). Writes a pending `purchases/{reference}`
with the price and coins, then starts a Paystack transaction for that price. Open `authorizationUrl` to pay.

**`POST paystackWebhook`** (Paystack calls this)

1. Checks `x-paystack-signature` (HMAC-SHA512 of the raw body with the secret key, compared in constant time). Bad: 401.
2. Ignores events other than `charge.success` (200).
3. In one transaction, reads `purchases/{reference}`:
   - already `paid`: counts a duplicate and changes nothing (`duplicate`),
   - amount or currency differs from what the server set: marked `mismatch`, no coins,
   - otherwise: marked `paid`, coins added, ledger and audit entries written (`credited`).

Firestore transactions are serialisable, so three copies of the same event arriving at once still credit one purchase;
the test suite sends exactly that. Errors return 500, so Paystack retries later.

### Weekly prizes

`closeWeek` runs Mondays at 00:05 Lagos time. It takes last week's board and writes a `payouts/{week}_{uid}` record
(`awaiting_approval`) for the top 3 players who are `verified` and not `flagged`: ₦50,000, ₦25,000 and ₦10,000.
It runs once per week even if the scheduler retries (`prizeWeeks/{week}` marker).

## Data

| Collection | |
|---|---|
| `players/{uid}` | name, coins, strikes, flagged, verified, wins, missionsWon, achievements, inventory, openSession |
| `players/{uid}/ledger/*` | every coin change: amount, reason (`session`, `purchase`, `shop`), ref |
| `players/{uid}/days/{YYYY-MM-DD}` | coins earned and sessions started that Lagos day |
| `saves/{uid}` | game save |
| `sessions/{id}` | uid, mission, startedAt, status (`open`, `done`, `rejected`, `expired`, `abandoned`), run, credited |
| `weeks/{week}/scores/{uid}` | weekly leaderboard: name, score |
| `purchases/{reference}` | uid, pack, kobo, coins, status (`pending`, `paid`, `mismatch`, `failed`), duplicates |
| `payouts/{week}_{uid}` | prize awaiting approval |
| `audit/*` | uid, type, details, at |

Security rules (`firestore.rules`): no client writes at all; players read only their own documents; signed-in players
read the leaderboard. Everything else goes through functions using the Admin SDK.

## Not done yet

- Bank payouts with Paystack Transfers once an admin approves a payout, and identity checks (BVN or NIN) before `verified`.
- App Check on the callable functions, to stop scripts calling them without the real app.
- Duplicate account checks (device and payment-card fingerprints).
- Chat, crews and live events.
- Moving the ledger and audit log to PostgreSQL once they get big, for reporting and cheaper long-term storage.
