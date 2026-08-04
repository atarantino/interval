# Interval

Spaced reps for coding interviews — a local-first spaced-repetition trainer for the
[Blind 75](https://neetcode.io/practice/practice/blind75),
[NeetCode 150](https://neetcode.io/practice/practice/neetcode150), and
[NeetCode 250](https://neetcode.io/practice/practice/neetcode250), built on spacing-effect
and retrieval-practice research.

**Use it here → [intervalreps.vercel.app](https://intervalreps.vercel.app)**

No account or install required. Your log starts in your browser; optional sync works
with a pairing link alone, while Google sign-in makes that link recoverable.

## Why

Grinding the list front-to-back optimizes for *finishing*, not *retaining*. This app schedules each problem back into your queue right around when you'd otherwise forget it, so every rep is a real retrieval attempt instead of a warm re-read.

- **Expanding review intervals** — solve a problem cold and it comes back later each time; struggle and it comes back sooner.
- **Leech detection** — a problem where 2 of your last 3 attempts needed help gets pulled out of the grind queue. Another cold attempt would just fail the same way; the app tells you to rebuild the idea first.
- **Interleaving** — new problems are mixed across patterns on purpose, because recognizing *which* pattern applies is the skill under test.
- **Backlog gate** — new problems pause while reviews pile up (Anki's rule: adding material on top of a backlog just grows the backlog).
- **Recall** — capture a fact you had to look up while solving, write the answer later, and practice it on a schedule built for five-second retrievals.
- **Katas** — drill 23 data-structure implementations in course order, with each form linked to its lesson and scheduled on a slower cadence than Recall.
- **Choose your list and solver** — switch among the three nested lists and open problems on NeetCode or LeetCode. Existing reviews remain due even when you select a smaller list.
- **Shareable recaps** — copy a compact text summary or share a generated PNG of your streak, progress, and recent activity.

The **Method** tab in the app explains the research behind each rule.

## How it works

The entire app is one static `index.html` — no framework, build step, or bundled client dependencies. State lives in `localStorage`, with JSON export and import as a manual backup. The page contains list metadata (names, categories, difficulty, and links) plus your own attempt log, Recall cards, and kata schedule; it never stores problem statements or solutions.

Cross-device sync is entirely optional. You can turn it on with a secret pairing link and no account, or sign in with Google. Both routes use the same random 128-bit sync key; Google only associates your account with that key so you can recover the log on a new device or after clearing browser storage. It is not a separate account-based data path.

The server ([Convex](https://convex.dev), in `backend/`) stores the merged state under that key. Attempts have stable IDs, deletions stick via tombstones, and the newest deck edit wins, making merges commutative and idempotent. Devices can log offline and converge on the next successful round-trip. Anyone with a pairing link can access its log, so treat it like a password; if it leaks, rotate it in the sync panel to carry the state to a new key and revoke the old one.

Recall exercises run locally in the browser where supported, and recap text and images are generated locally without an upload.

The checked-in catalog is generated at maintenance time, never fetched by the app:

```bash
node scripts/update-neetcode-data.mjs
node scripts/update-neetcode-data.mjs --emit
```

The script reads NeetCode's current public bundle, preserves IDs 1–150 by LeetCode slug,
and validates list nesting, category and difficulty totals, slugs, IDs, order, and all
required fields before it emits the `PROBLEMS` declaration.

## Credits

The problem lists are curated by [NeetCode / Navdeep Singh](https://neetcode.io/).
NeetCode's videos, courses, and [Pro membership](https://neetcode.io/pro) support the
original work. The seeded Katas follow
[ThePrimeagen's algorithms course](https://master.dev/courses/algorithms/) and are
inspired by the [kata-machine](https://github.com/ThePrimeagen/kata-machine) workflow.
Interval schedules the forms; the public
[kata-typescript](https://github.com/atarantino/kata-typescript) harness runs them in a
real editor and test runner. This repository does not bundle kata-machine code or tests.

Not affiliated with NeetCode or LeetCode.

## Running your own

The static page works from any file host — or just open `index.html` locally. To self-host sync:

```bash
cd backend
npm install
npx convex dev   # creates your own Convex deployment
```

Then point `SYNC_URL` in `index.html` at your deployment's `.convex.site` URL.
Pairing-link sync needs no account or OAuth setup. To offer optional Google recovery,
replace `GOOGLE_CLIENT_ID` in `index.html`, set the matching `GOOGLE_CLIENT_ID` in your
Convex environment, and add your site origin to `RECOVER_ORIGINS` in
`backend/convex/http.ts`.

After installing the backend dependencies, run the merge and key-rotation checks from
the repository root:

```bash
node scripts/check-state-merge.mjs
node scripts/check-key-rotation.mjs
```

## Support

Interval is free, and staying that way. Sync runs on a small hosted backend; if the app
is earning its keep, you can [buy me a coffee](https://ko-fi.com/adamtarantino) ☕
