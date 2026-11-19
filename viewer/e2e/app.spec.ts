import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fixtureRoot } from '../scripts/server.ts';

// One test per thing a programmer comes to codemap for, against codemap serve
// on a git copy of testdata/shop (scripts/server.ts). Details belong in unit tests.

const root = fixtureRoot(Number(process.env.CODEMAP_E2E_PORT) || 7782);

// reset puts .codemap back as committed and waits for the server to see it.
async function reset(page: Page) {
  execFileSync('git', ['checkout', '-q', '--', '.codemap'], { cwd: root });
  execFileSync('git', ['clean', '-qfd', '.codemap'], { cwd: root });
  const want = createHash('sha256').update(readFileSync(path.join(root, '.codemap/proposals/refunds.md'))).digest('hex').slice(0, 16);
  await expect
    .poll(async () => {
      const v = ((await (await page.request.get('/api/state')).json()) as { versions: Record<string, string> }).versions;
      return Object.keys(v).length === 2 && v['proposals/refunds'] === want;
    })
    .toBe(true);
}

const node = (page: Page, id: string) => page.locator(`#map [data-node="${id}"]`).first();
const box = (page: Page, id: string) => page.locator(`#map [data-box="${id}"]`).first();
const ORDERS = 'mod:go:shop/internal/orders';
const INSERT = 'go:shop/internal/orders.(*Repo).Insert';

type P = { slug: string; body: string; nodes?: { id: string; module?: string }[] };
const refunds = async (page: Page) => ((await (await page.request.get('/api/proposals')).json()) as P[]).find((p) => p.slug === 'refunds')!;

// The fixture is on a branch, which opens on "this branch vs main";
// #plain opens the plain map.
async function open(page: Page, hash = '#plain') {
  await reset(page);
  await page.goto('/' + hash);
  await expect(page.locator('#map [data-box]').first()).toBeVisible();
}

async function search(page: Page, text: string) {
  await page.keyboard.press('Control+k');
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

test('the map is parts and how they talk; selecting lights things where they are', async ({ page }) => {
  await open(page);
  // at rest: programs, their parts, the tables, topics and services; never a function
  await expect(page.locator('#map [data-frame="program:shop-web"]')).toBeVisible();
  await expect(page.locator('#map [data-frame="program:shop"]')).toBeVisible();
  await expect(box(page, ORDERS)).toContainText('13 functions');
  await expect(node(page, 'table:orders')).toBeVisible();
  await expect(page.locator('#map [data-node^="go:"], #map [data-node^="ts:"]')).toHaveCount(0);
  // at rest, no lines
  await expect(page.locator('#map path.edge')).toHaveCount(0);
  // hovering a part shows just its connections
  await box(page, ORDERS).hover();
  await expect(page.locator('#map')).toHaveAttribute('data-hover', ORDERS);
  for (const k of await page.locator('#map path.edge').evaluateAll((ps) => ps.map((p) => p.getAttribute('data-link')!))) expect(k).toContain(ORDERS);
  await page.mouse.move(5, 940);
  // a feature: the panel tells its story, the map lights its parts in place
  await search(page, '/checkout');
  await expect(page.locator('#drawer h2')).toHaveText('PAGE /checkout');
  await expect(page.locator('#drawer .trow.eff', { hasText: 'PlaceOrderButton.onClick' })).toContainText('fetches POST /orders');
  await expect(box(page, ORDERS)).toHaveClass(/\btouched\b/);
  await expect(node(page, 'table:orders')).toHaveClass(/\btouched\b/);
  await expect(box(page, 'mod:go:shop/internal/notify')).toHaveClass(/\bdim\b/);
  // its steps open in the panel; the map doesn't move, and Escape goes back to the story
  const view = await page.locator('#map > g').getAttribute('transform');
  await page.locator('#drawer .trow[data-node="go:shop/internal/orders.(*Service).Place"]').click();
  await expect(page.locator('#drawer h2')).toHaveText('Service.Place');
  await expect(box(page, ORDERS)).toHaveClass(/\bmsel\b/);
  // the story it's a step of is marked among its entry points
  await expect(page.locator('#drawer .ent.story')).toHaveText('‹ PAGE /checkout');
  expect(await page.locator('#map > g').getAttribute('transform')).toBe(view);
  await page.keyboard.press('Escape');
  await expect(page.locator('#drawer h2')).toHaveText('PAGE /checkout');
  // a table: what writes it and what reads it
  await node(page, 'table:orders').click();
  await expect(page.locator('#drawer h2')).toHaveText('orders');
  await expect(page.locator('#drawer').getByText('Repo.Insert').first()).toBeVisible();
  await expect(box(page, ORDERS)).toHaveClass(/\btouched\b/);
});

test('a route: its call tree ends in what it touches, with the tests along the way', async ({ page }) => {
  await open(page);
  await search(page, 'POST /orders');
  const d = page.locator('#drawer');
  await expect(d.locator('h2')).toHaveText('POST /orders');
  for (const t of ['writes stock', 'calls api.stripe.com', 'writes orders', 'publishes order.placed']) await expect(d.locator('.tree')).toContainText(t);
  await expect(d.getByText('TestPlace_ChargesAndInserts')).toBeVisible();
  await expect(node(page, 'ext:stripe')).toHaveClass(/\btouched\b/);
});

test('a part: its connections, why they exist, what starts it and what it does', async ({ page }) => {
  await open(page);
  await box(page, ORDERS).click();
  const d = page.locator('#drawer');
  await expect(d.locator('h2')).toHaveText('internal/orders');
  // the diagram: what calls in, what it calls out to, tables and topics by name
  await expect(d.locator('[data-conn="in:mod:go:shop/cmd/server"]')).toBeVisible();
  await expect(d.locator('[data-conn="out:table:orders"]')).toBeVisible();
  await expect(d.locator('[data-conn="out:topic:order.placed"]')).toBeVisible();
  // opening a connection shows the calls behind it
  await d.locator('[data-conn="out:mod:go:shop/internal/payments"]').click();
  await expect(d.locator('#conn-calls')).toContainText('Service.Place'); // its own code without the part
  await expect(d.locator('#conn-calls')).toContainText('payments.Client.Charge');
  await expect(d.locator('.ent', { hasText: 'POST /orders' })).toBeVisible();
  // its interface: what other parts use, the entry points through each, and its flow
  const markPaid = d.locator('.irow', { hasText: 'Service.MarkPaid' });
  await expect(markPaid).toContainText('POST /webhooks/stripe');
  await markPaid.locator('.itog').click();
  await expect(markPaid.locator('.iflow')).toContainText('writes orders');
  await d.locator('.iname', { hasText: 'Handler.Create' }).click();
  await expect(d.locator('h2')).toHaveText('Handler.Create');
});

test('the panel: sections fold, everywhere, and its edge drags', async ({ page }) => {
  await open(page);
  await page.evaluate(() => localStorage.clear());
  await search(page, 'POST /orders');
  const d = page.locator('#drawer');
  await expect(d.locator('[data-sec="Source"] pre').first()).toBeVisible();
  await d.locator('[data-sec="Source"] .stog').click();
  await expect(d.locator('[data-sec="Source"] pre')).toHaveCount(0);
  // folded on the next panel too
  await search(page, 'Service.Place');
  await expect(d.locator('[data-sec="Source"]')).toHaveClass(/folded/);
  await d.locator('[data-sec="Source"] .stog').click();
  // drag the edge wider
  const before = (await d.boundingBox())!.width;
  const h = (await page.locator('.dresize').boundingBox())!;
  await page.mouse.move(h.x + 3, h.y + 200);
  await page.mouse.down();
  await page.mouse.move(h.x - 150, h.y + 200, { steps: 5 });
  await page.mouse.up();
  expect((await d.boundingBox())!.width).toBeGreaterThan(before + 100);
  await page.locator('.dresize').dblclick();
  expect(Math.round((await d.boundingBox())!.width)).toBe(440);
});

test('search: switching selections keeps one panel', async ({ page }) => {
  await open(page);
  for (const q of ['web/src/api', 'internal/auth', 'Handler.Login']) await search(page, q);
  await expect(page.locator('#drawer .dhead')).toHaveCount(1);
});

test('proposals: open one, sketch a function and a call, move one, comment', async ({ page }) => {
  await open(page);
  await page.locator('#m-propose').click();
  await page.locator('.pitem[data-slug="refunds"]').click();
  // the parts it changes are marked, with what it proposes counted
  await expect(page.locator('#map .mod.pchg').first()).toContainText('proposed');
  // a proposed function in a part, calling real code
  await page.locator(`#map [data-add="${ORDERS}"]`).click();
  await page.locator('#f-name').fill('Service.Cancel');
  await page.locator('#f-name').press('Enter');
  await page.getByRole('button', { name: 'Add a call' }).click();
  await page.locator('#pick-q').fill('Repo.Insert');
  await page.locator('#pick-q').press('Enter');
  await expect.poll(async () => (await refunds(page)).nodes).toContainEqual({ id: 'new:Service.Cancel', kind: 'function', label: 'Service.Cancel', module: ORDERS });
  await expect.poll(async () => ((await refunds(page)) as P & { edges?: { from: string; to: string }[] }).edges).toContainEqual({ from: 'new:Service.Cancel', to: INSERT });
  // it's drawn inside its part, and listed under it in the proposal's changes
  await expect(page.locator('#map .padd[data-node="new:Service.Cancel"]')).toBeVisible();
  await page.locator('#drawer .pback').click();
  await expect(page.locator('#drawer .pchange', { hasText: 'Service.Cancel' })).toContainText('orders.Repo.Insert');
  await page.locator('#drawer .pchange .iname', { hasText: 'Service.Cancel' }).click();
  await expect(page.locator('#drawer h2')).toHaveText('Service.Cancel');
  await page.locator('#drawer .pback').click();
  // move a real function to another part
  await search(page, 'Repo.Insert');
  await page.locator('#move-to').selectOption('mod:go:shop/internal/payments');
  await expect.poll(async () => (await refunds(page)).nodes).toContainEqual({ id: INSERT, module: 'mod:go:shop/internal/payments' });
  // comment: c, type, Enter; highlighting code quotes it
  await search(page, 'Service.Place');
  await expect(page.locator('#drawer h2')).toHaveText('Service.Place');
  // (the proposal's last save can still reload the panel: retry until the highlight lands)
  await expect(async () => {
    const pre = page.locator('#drawer .code[data-file] pre.c').first();
    await pre.scrollIntoViewIfNeeded({ timeout: 500 });
    const b = (await pre.boundingBox())!;
    await page.mouse.move(b.x + 2, b.y + 4);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width - 4, b.y + 30);
    await page.mouse.up();
    await expect(page.locator('#c-text')).toBeFocused({ timeout: 500 });
  }).toPass({ timeout: 5000 });
  await page.keyboard.type('Reserve after payment.');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await refunds(page)).body).toMatch(/### `[^`]*Service\.Place` · internal\/orders\/service\.go:\d+(-\d+)?\n\n```go\n[\s\S]+\n```\n\nReserve after payment\.\n$/);
});

test('on a branch the map opens on what changed, and the summary jumps to it', async ({ page }) => {
  await open(page, '');
  await expect(page.locator('#cmp')).toContainText('vs main');
  const d = page.locator('#drawer');
  const first = d.locator('.pchange [data-node]').first();
  const id = (await first.getAttribute('data-node'))!;
  await first.click();
  // its part is selected and marked changed
  await expect(page.locator('#map .mod.msel')).toHaveClass(/\bd-(add|has)\b/);
  await expect(page.locator('#drawer h2')).not.toBeEmpty();
  expect(id).toBeTruthy();
  // the node's own panel says what changed about it
  await expect(page.locator('#drawer .kind')).toContainText(/Added|Changed|Removed/);
  // any two revisions, from the picker
  await page.locator('#cmp').click();
  await expect(page.locator('#cmp-go')).toBeVisible();
  await page.locator('#cmp-go').click();
  await expect(page.locator('#sum-title, #cmp .cl').first()).toBeVisible();
  await page.locator('#cmp-x').click();
  await expect(page.locator('#cmp')).not.toContainText('vs main');
});
