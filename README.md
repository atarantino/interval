# NeetCode Lists · Spaced Reps

A spaced-repetition trainer for the [Blind 75](https://neetcode.io/practice/practice/blind75),
[NeetCode 150](https://neetcode.io/practice/practice/neetcode150), and
[NeetCode 250](https://neetcode.io/practice/practice/neetcode250), built on spacing-effect
and retrieval-practice research.

**Use it here → [neetcode-spaced-reps.vercel.app](https://neetcode-spaced-reps.vercel.app)**

No account, no install. Your log lives in your browser.

## Why

Grinding the list front-to-back optimizes for *finishing*, not *retaining*. This app schedules each problem back into your queue right around when you'd otherwise forget it, so every rep is a real retrieval attempt instead of a warm re-read.

- **Expanding review intervals** — solve a problem cold and it comes back later each time; struggle and it comes back sooner.
- **Leech detection** — a problem where 2 of your last 3 attempts needed help gets pulled out of the grind queue. Another cold attempt would just fail the same way; the app tells you to rebuild the idea first.
- **Interleaving** — new problems are mixed across patterns on purpose, because recognizing *which* pattern applies is the skill under test.
- **Backlog gate** — new problems pause while reviews pile up (Anki's rule: adding material on top of a backlog just grows the backlog).
- **Katas** — a separate track for drilling data-structure implementations on the same schedule.
- **Choose your list and solver** — switch among the three nested lists and open problems on NeetCode or LeetCode. Existing reviews remain due even when you select a smaller list.

The **Method** tab in the app explains the research behind each rule.

## How it works

The entire app is one static `index.html` — no framework, no build step, no runtime dependencies. State lives in `localStorage`. The page contains list metadata (names, categories, difficulty, and links) plus your own attempt log; it never stores problem statements or solutions.

Cross-device sync is optional and account-free: the first device mints a random 128-bit key, and pairing another device is opening one link. The key is the only credential — the server ([Convex](https://convex.dev), in `backend/`) just stores the merged union of every device's log under it. Merges are commutative and idempotent (attempts union, deletions stick via tombstones, newest kata edit wins), so devices can log offline and converge on the next round-trip.

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
original work. The seeded repository drills are inspired by
[ThePrimeagen's kata-machine](https://github.com/ThePrimeagen/kata-machine) workflow;
this repository does not bundle kata-machine code or tests.

Not affiliated with NeetCode or LeetCode.

## Running your own

The static page works from any file host — or just open `index.html` locally. To self-host sync:

```bash
cd backend
npm install
npx convex dev   # creates your own Convex deployment
```

Then point `SYNC_URL` in `index.html` at your deployment's `.convex.site` URL.

## Support

Free, and staying that way. If it's working for you, you can [buy me a coffee](https://ko-fi.com/adamtarantino) ☕
