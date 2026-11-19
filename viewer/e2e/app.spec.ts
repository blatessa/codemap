import { expect, test, type Page } from '@playwright/test';

// One test per thing a programmer comes to codemap for, against the mock API
// serving testdata/shop. Details belong in unit tests.

const node = (page: Page, id: string) => page.locator(`#map [data-node="${id}"]`).first();
const box = (page: Page, id: string) => page.locator(`#map [data-box="${id}"]`).first();
const ORDERS = 'mod:go:shop/internal/orders';
const INSERT = 'go:shop/internal/orders.(*Repo).Insert';

type P = { slug: string; body: string; nodes?: { id: string; module?: string }[] };
const refunds = async (page: Page) => ((await (await page.request.get('/api/proposals')).json()) as P[]).find((p) => p.slug === 'refunds')!;

// The mock is on a branch, which opens on "this branch vs main"; #rev=worktree
// opens the plain map.
async function open(page: Page, hash = '#rev=worktree') {
  await page.request.post('/__mock/reset');
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
  // the web app calls the server over HTTP, and orders publishes an event, drawn strongly; calls inside a program faintly
  await expect(page.locator('#map path.edge.k-http:not(.faint)').first()).toBeAttached();
  await expect(page.locator('#map path.edge.k-event:not(.faint)').first()).toBeAttached();
  await expect(page.locator('#map path.edge.k-calls.faint').first()).toBeAttached();
  // hovering a part shows just its connections
  await box(page, ORDERS).hover();
  await expect(page.locator('#map')).toHaveAttribute('data-hover', ORDERS);
  for (const k of await page.locator('#map path.edge').evaluateAll((ps) => ps.map((p) => p.getAttribute('data-link')!))) expect(k).toContain(ORDERS);
  await page.mouse.move(5, 940);
  // a feature: the panel tells its story, the map lights its parts in place
  await search(page, '/checkout');
  await expect(page.locator('#drawer h2')).toHaveText('/checkout');
  await expect(page.locator('#drawer .trow.eff', { hasText: 'PlaceOrderButton.onClick' })).toContainText('fetches POST /orders');
  await expect(box(page, ORDERS)).toHaveClass(/\btouched\b/);
  await expect(node(page, 'table:orders')).toHaveClass(/\btouched\b/);
  await expect(box(page, 'mod:go:shop/internal/notify')).toHaveClass(/\bdim\b/);
  // its steps open in the panel; the map doesn't move, and Escape goes back to the story
  const view = await page.locator('#map > g').getAttribute('transform');
  await page.locator('#drawer .trow[data-node="go:shop/internal/orders.(*Service).Place"]').click();
  await expect(page.locator('#drawer h2')).toHaveText('Service.Place');
  await expect(box(page, ORDERS)).toHaveClass(/\bmsel\b/);
  expect(await page.locator('#map > g').getAttribute('transform')).toBe(view);
  await page.keyboard.press('Escape');
  await expect(page.locator('#drawer h2')).toHaveText('/checkout');
  // a table: what writes it and what reads it
  await node(page, 'table:orders').click();
  await expect(page.locator('#drawer h2')).toHaveText('orders');
  await expect(page.locator('#drawer').getByText('Repo.Insert')).toBeVisible();
  await expect(box(page, ORDERS)).toHaveClass(/\btouched\b/);
});

test('search runs commands; switching selections keeps one panel', async ({ page }) => {
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
  const first = d.locator('[data-go^="job:"], [data-go^="go:"], [data-go^="route:"]').first();
  const id = (await first.getAttribute('data-go'))!;
  await first.click();
  // its part is selected and marked changed
  await expect(page.locator('#map .mod.msel')).toHaveClass(/\bd-(add|has)\b/);
  await expect(page.locator('#drawer h2')).not.toBeEmpty();
  expect(id).toBeTruthy();
  await page.locator('#cmp-x').click();
  await expect(page.locator('#cmp')).not.toContainText('vs main');
});
