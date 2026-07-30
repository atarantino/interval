#!/usr/bin/env node

/* Maintainer-only catalog refresh. The app never fetches NeetCode at runtime.
   This script treats the live site as an input to review, not an API contract:
   it extracts the current embedded catalog, proves the list invariants, preserves
   ids 1–150 by LeetCode slug, then prints a ready-to-paste PROBLEMS declaration. */

import { readFile } from "node:fs/promises";
import vm from "node:vm";

const ROOT = "https://neetcode.io/";
const INDEX = new URL("../index.html", import.meta.url);
const args = new Set(process.argv.slice(2));

const EXPECTED_CATEGORIES = {
  75: {
    "Arrays & Hashing": 8, "Two Pointers": 3, "Sliding Window": 4, Stack: 1,
    "Binary Search": 2, "Linked List": 6, Trees: 11, "Heap / Priority Queue": 1,
    Backtracking: 2, Tries: 3, Graphs: 6, "Advanced Graphs": 1,
    "1-D Dynamic Programming": 10, "2-D Dynamic Programming": 2, Greedy: 2,
    Intervals: 5, "Math & Geometry": 3, "Bit Manipulation": 5,
  },
  150: {
    "Arrays & Hashing": 9, "Two Pointers": 5, "Sliding Window": 6, Stack: 6,
    "Binary Search": 7, "Linked List": 11, Trees: 15, "Heap / Priority Queue": 7,
    Backtracking: 10, Tries: 3, Graphs: 13, "Advanced Graphs": 6,
    "1-D Dynamic Programming": 12, "2-D Dynamic Programming": 11, Greedy: 8,
    Intervals: 6, "Math & Geometry": 8, "Bit Manipulation": 7,
  },
  250: {
    "Arrays & Hashing": 22, "Two Pointers": 13, "Sliding Window": 9, Stack: 14,
    "Binary Search": 14, "Linked List": 14, Trees: 23, "Heap / Priority Queue": 12,
    Backtracking: 17, Tries: 4, Graphs: 21, "Advanced Graphs": 10,
    "1-D Dynamic Programming": 17, "2-D Dynamic Programming": 16, Greedy: 14,
    Intervals: 7, "Math & Geometry": 13, "Bit Manipulation": 10,
  },
};
const EXPECTED_DIFFICULTIES = { Easy: 60, Medium: 155, Hard: 35 };

function invariant(ok, message) {
  if (!ok) throw new Error(message);
  checks.push(message);
}

function slug(value, prefix = "") {
  return String(value || "").replace(prefix, "").replace(/^\/+|\/+$/g, "");
}

function extractBalancedArray(source) {
  const match = /\[\{problem:"[^"]+",pattern:/.exec(source);
  if (!match) throw new Error("Could not locate the embedded problem catalog");
  const start = match.index;
  let depth = 0, quote = null, escaped = false;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "[") depth++;
    else if (char === "]" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error("Problem catalog array did not terminate");
}

function countsBy(records, key) {
  const out = {};
  for (const record of records) out[record[key]] = (out[record[key]] || 0) + 1;
  return out;
}

function sameCounts(actual, expected) {
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  return [...keys].every(key => actual[key] === expected[key]);
}

const checks = [];
const html = await fetch(ROOT).then(response => {
  if (!response.ok) throw new Error(`NeetCode root returned HTTP ${response.status}`);
  return response.text();
});
const bundleName = html.match(/src="(main\.[^"]+\.js)"/)?.[1];
invariant(!!bundleName, "hashed main bundle discovered");

const bundle = await fetch(new URL(bundleName, ROOT)).then(response => {
  if (!response.ok) throw new Error(`${bundleName} returned HTTP ${response.status}`);
  return response.text();
});
const catalog = vm.runInNewContext(extractBalancedArray(bundle), Object.create(null), { timeout: 1000 });
const list250 = catalog.filter(problem => problem.neetcode250);
const list150 = catalog.filter(problem => problem.neetcode150);
const blind75 = catalog.filter(problem => problem.blind75);

invariant(list250.length === 250, "NeetCode 250 count = 250");
invariant(list150.length === 150, "NeetCode 150 count = 150");
invariant(blind75.length === 75, "Blind 75 count = 75");
invariant(list150.every(problem => problem.neetcode250), "NeetCode 150 is a subset of NeetCode 250");
invariant(blind75.every(problem => problem.neetcode150 && problem.neetcode250), "Blind 75 is a subset of both larger lists");

for (const [tier, records] of [[75, blind75], [150, list150], [250, list250]]) {
  invariant(sameCounts(countsBy(records, "pattern"), EXPECTED_CATEGORIES[tier]), `${tier} category counts match all 18 expected categories`);
}
invariant(sameCounts(countsBy(list250, "difficulty"), EXPECTED_DIFFICULTIES), "250 difficulty counts = 60 Easy / 155 Medium / 35 Hard");

const required = ["problem", "pattern", "difficulty", "link", "ncLink"];
invariant(list250.every(problem => required.every(key => typeof problem[key] === "string" && problem[key].length > 0)), "all 250 records contain every required field");

const lcSlugs = list250.map(problem => slug(problem.link));
const ncSlugs = list250.map(problem => slug(problem.ncLink));
invariant(new Set(lcSlugs).size === 250, "all 250 LeetCode slugs are unique");
invariant(new Set(ncSlugs).size === 250, "all 250 NeetCode slugs are unique");

const currentHtml = await readFile(INDEX, "utf8");
const currentLiteral = currentHtml.match(/const PROBLEMS = (\[[^\n]*\]);/)?.[1];
if (!currentLiteral) throw new Error("Could not read the current PROBLEMS declaration");
const current = JSON.parse(currentLiteral);
const legacy = current.filter(problem => problem.id <= 150).sort((a, b) => a.id - b.id);
invariant(legacy.length === 150 && legacy.every((problem, i) => problem.id === i + 1), "legacy ids 1–150 are present exactly once");

const live150BySlug = new Map(list150.map(problem => [slug(problem.link), problem]));
const legacyBySlug = new Map();
let legacyMismatches = 0;
for (const problem of legacy) {
  const lc = slug(problem.lc, /^https:\/\/leetcode\.com\/problems\//);
  if (!live150BySlug.has(lc) || legacyBySlug.has(lc)) legacyMismatches++;
  legacyBySlug.set(lc, problem.id);
}
invariant(legacyMismatches === 0, "ids 1–150 match the live NeetCode 150 by LeetCode slug (0 mismatches)");

let nextId = 151;
const problems = list250.map((problem, index) => {
  const lc = slug(problem.link);
  const existingId = legacyBySlug.get(lc);
  return {
    id: existingId || nextId++,
    ord: index + 1,
    tier: problem.blind75 ? 75 : problem.neetcode150 ? 150 : 250,
    name: problem.problem,
    cat: problem.pattern,
    diff: problem.difficulty,
    lc,
    nc: slug(problem.ncLink),
  };
});

invariant(nextId === 251, "new-only problems receive ids 151–250 in official order");
invariant(new Set(problems.map(problem => problem.id)).size === 250, "all generated ids are unique");
invariant(problems.every((problem, i) => problem.ord === i + 1), "ord is the live NeetCode 250 position 1–250");
invariant(problems.filter(problem => problem.tier === 75).length === 75, "tier 75 contains 75 problems");
invariant(problems.filter(problem => problem.tier <= 150).length === 150, "tier <= 150 contains 150 problems");
invariant(problems.filter(problem => problem.tier <= 250).length === 250, "tier <= 250 contains 250 problems");

if (args.has("--emit")) {
  const stamp = new Date().toISOString().slice(0, 10);
  console.log(`/* NeetCode catalog snapshot ${stamp} · ${bundleName} */`);
  console.log(`const PROBLEMS = ${JSON.stringify(problems)};`);
} else {
  invariant(JSON.stringify(current) === JSON.stringify(problems), "embedded PROBLEMS matches the generated live snapshot");
  const snapshotBundle = currentHtml.match(/NeetCode catalog snapshot \d{4}-\d{2}-\d{2} · ([^ ]+\.js)/)?.[1];
  invariant(snapshotBundle === bundleName, "snapshot comment records the validated bundle filename");
  console.log(`NeetCode catalog validator · ${bundleName}`);
  for (const check of checks) console.log(`PASS  ${check}`);
  console.log(`PASS  ${checks.length} invariants checked; dataset ready (${problems.length} records)`);
  console.log("Run with --emit to print the reviewed PROBLEMS declaration.");
}
