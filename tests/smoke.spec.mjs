import { test, expect, readState, logAttempt, openHistory } from './fixtures.mjs';

test('practice categories stay hidden until revealed without disturbing a draft', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    state.log = [
      { i: 'hint-1', pid: 31, d: addDays(todayStr(), -10), r: 'hints' },
      { i: 'hint-2', pid: 31, d: addDays(todayStr(), -5), r: 'hints' },
      { i: 'review-1', pid: 10, d: addDays(todayStr(), -30), r: 'cold' },
    ];
    render();
  });
  const cards = page.locator('#view .card[data-pid]');
  expect(await cards.count()).toBeGreaterThanOrEqual(3);
  for (const card of await cards.all()) {
    const pid = Number(await card.getAttribute('data-pid'));
    const category = await page.evaluate(id => PROBLEMS.find(p => p.id === id).cat, pid);
    await expect(card.locator('[data-category-hint]')).toHaveText('Show category');
    await expect(card).not.toContainText(category);
  }
  const hint = page.locator('[data-category-hint="31"]');
  await hint.click();
  await expect(hint).toHaveText('Binary Search');
  await expect(hint).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-form="31"]')).toHaveCount(0);
  await expect(page.locator('[data-category-hint="10"]')).toHaveText('Show category');
  await page.locator('[data-pid="31"] .prob-name').click();
  const notes = page.locator('[data-form="31"] [data-notes]');
  await notes.fill('Unsaved approach');
  await hint.focus();
  await page.keyboard.press('Enter');
  await expect(hint).toHaveText('Show category');
  await expect(hint).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Space');
  await expect(hint).toHaveText('Binary Search');
  await expect(notes).toHaveValue('Unsaved approach');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload();
  await expect(page.locator('[data-category-hint][aria-expanded="true"]')).toHaveCount(0);
  const freshCard = page.locator('#view .card[data-pid]').first();
  await expect(freshCard.locator('.leech-box')).toContainText('First problem in a new pattern');
  await page.locator('[data-tab="all"]').click();
  await expect(page.locator('.cat-name').filter({ hasText: 'Binary Search' })).toBeVisible();
});

test('All problems launches the selected workspace in a new tab', async ({ page, context }) => {
  // Stub destinations so the test checks navigation without contacting either service.
  await context.route(/^https:\/\/(neetcode\.io|leetcode\.com)\//, route =>
    route.fulfill({ contentType: 'text/html', body: '<title>Problem workspace</title>' }));
  await page.goto('/');
  await page.locator('[data-tab="all"]').click();
  await page.locator('[data-tier="75"]').click();
  await page.locator('#searchBox').fill('Contains Duplicate');
  await page.locator('[data-row="1"]').click();
  const form = page.locator('[data-form="1"]');
  for (const [pref, label, url, other] of [
    ['nc', 'NeetCode', 'https://neetcode.io/problems/duplicate-integer?list=blind75', 'LeetCode'],
    ['lc', 'LeetCode', 'https://leetcode.com/problems/contains-duplicate/', 'NeetCode'],
  ]) {
    await page.locator(`[data-linkpref="${pref}"]`).click();
    const launch = form.getByRole('link', { name: `Solve on ${label} ↗`, exact: true });
    await expect(launch).toBeVisible();
    await expect(launch).toHaveAttribute('href', url);
    await expect(form.getByRole('link', { name: `Open on ${other} ↗`, exact: true })).toBeVisible();
    const popupPromise = page.waitForEvent('popup');
    await launch.click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL(url);
    await popup.close();
    await expect(form.locator('[data-save]')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('attempt persists across reload and appears in history', async ({ page, isMobile }) => {
  await page.clock.setFixedTime(new Date('2026-09-05T19:00:00Z'));
  await page.goto('/');
  await logAttempt(page, 'QA persistence');
  await page.reload();
  const state = await readState(page);
  expect(state.log).toHaveLength(1);
  expect(state.log[0]).toMatchObject({ d: '2026-09-05', r: 'cold', n: 'QA persistence' });
  await openHistory(page, state.log[0].pid);
  await expect(page.locator('.history .hnote').filter({ hasText: 'QA persistence' })).toBeVisible();
  await page.locator('.hrow').first()[isMobile ? 'tap' : 'hover']();
  await page.locator('[data-del]').first().click();
  await page.reload();
  expect((await readState(page)).log).toEqual([]);
  expect((await readState(page)).deletedLog).toContain(`i:${state.log[0].i}`);
});

test('local development disables sync and does not expose repository files', async ({ page, request }) => {
  await page.goto('/');
  await page.locator('#syncBtn').click();
  await page.locator('[data-syncon]').click();
  await expect(page.getByText('Sync is disabled in this development server')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('ncsr-sync-key'))).toBeNull();
  expect((await request.get('/backend/.env.local')).status()).toBe(404);
  expect((await request.get('/__health')).status()).toBe(200);
});

test('theme and list choice survive reload without horizontal overflow', async ({ page }) => {
  await page.goto('/');
  await page.locator('#themeBtn').click();
  const theme = await page.locator('html').getAttribute('data-theme');
  await page.locator('[data-tab="all"]').click();
  await page.locator('[data-tier="75"]').click();
  await page.reload();
  expect((await readState(page)).tier).toBe(75);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Pareto 49 uses its own problems and order, and keeps outside reviews', async ({ page }) => {
  await page.goto('/');
  // Encode and Decode Strings (6) is in the Blind 75 but not the Pareto 49.
  await page.evaluate(() => { state.log = [{ i: 'outside-1', pid: 6, d: todayStr(), r: 'cold' }]; save(); render(); });
  await page.locator('[data-tab="all"]').click();
  await page.locator('[data-tier="49"]').click();
  await expect(page.locator('#listLogo')).toHaveText('Pareto 49');
  await expect(page.locator('#searchBox')).toHaveAttribute('placeholder', /49 problems in Pareto 49/);
  await expect(page.locator('.cat-block .cat-name')).toHaveText([
    'Arrays & Hashing', 'Two Pointers', 'Sliding Window', 'Stack', 'Binary Search',
    'Linked List', 'Trees', 'Heap / Priority Queue', 'Graphs',
  ]);
  // The PDF's order, not NeetCode's: Valid Sudoku (8) comes before Product of Array (7).
  await page.locator('.cat-head[data-cat="Arrays & Hashing"]').click();
  const rows = page.locator('.cat-block').first().locator('tr[data-row]');
  await expect(rows).toHaveCount(8);
  expect(await rows.evaluateAll(trs => trs.map(tr => Number(tr.dataset.row))))
    .toEqual([1, 2, 3, 4, 5, 8, 7, 9]);
  await expect(page.locator('.outside-block')).toContainText('Started outside Pareto 49');
  await expect(page.locator('.outside-block [data-row="6"]')).toBeVisible();
  await page.reload();
  expect((await readState(page)).tier).toBe(49);
  await page.locator('[data-tab="stats"]').click();
  await expect(page.locator('.tier-progress .bl')).toHaveText(['Pareto 49', 'Blind 75', 'NeetCode 150', 'NeetCode 250']);
  await expect(page.locator('.tier-progress .bv').first()).toHaveText('0/49');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Today switches the study list, offers the next list when one runs out, and hides it when paused', async ({ page }) => {
  await page.goto('/');
  const line = page.locator('.listline');
  await expect(line).toContainText('From NeetCode 150');
  await line.locator('[data-listpick]').click();
  await expect(line.locator('[data-listpick]')).toHaveAttribute('aria-expanded', 'true');
  await page.locator('.listpick [data-tier="49"]').click();
  await expect(page.locator('.listpick')).toHaveCount(0);
  await expect(line).toContainText('From Pareto 49');
  await expect(page.locator('#listLogo')).toHaveText('Pareto 49');
  expect((await readState(page)).tier).toBe(49);
  const paretoIds = await page.evaluate(() => TIER_INFO[49].ids);
  const newIds = await page.locator('.newlist .card[data-pid]').evaluateAll(cards => cards.map(c => Number(c.dataset.pid)));
  expect(newIds.length).toBeGreaterThan(0);
  for (const id of newIds) expect(paretoIds).toContain(id);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // Finishing the list offers the next one instead of a dead end.
  await page.evaluate(() => { state.dismissed = [...TIER_INFO[49].ids]; render(); });
  const next = page.locator('.newlist [data-tier="75"]');
  await expect(next).toHaveText('Continue with Blind 75');
  await next.click();
  expect((await readState(page)).tier).toBe(75);
  await expect(page.locator('.newlist .card[data-pid]').first()).toBeVisible();

  // While a backlog pauses new problems, switching would change nothing visible.
  await page.evaluate(() => {
    state.log = PROBLEMS.slice(0, NEW_GATE).map((p, n) => ({ i: `due-${n}`, pid: p.id, d: addDays(todayStr(), -60), r: 'cold' }));
    render();
  });
  await expect(page.locator('.gate')).toBeVisible();
  await expect(line).toHaveCount(0);
  await page.locator('[data-gate]').click();
  await expect(page.locator('.newlist')).toBeVisible();
  await expect(line).toHaveCount(0);
});
