import { expect, test, type Page } from '@playwright/test';
import { bigGraph } from './synth';

// One test per thing a programmer comes to codemap for, against the mock API
// serving testdata/shop. Details belong in unit tests.

const node = (page: Page, id: string) => page.locator(`#map [data-node="${id}"]`).first();
const box = (page: Page, id: string) => page.locator(`#map [data-box="${id}"]`).first();
const ORDERS = 'mod:go:shop/internal/orders';
const INSERT = 'go:shop/internal/orders.(*Repo).Insert';
const TOTAL = 'go:shop/internal/orders.(CreateOrder).Total'; // only called inside its module

type P = { slug: string; body: string; nodes?: { id: string; module?: string }[] };
const refunds = async (page: Page) => ((await (await page.request.get('/api/proposals')).json()) as P[]).find((p) => p.slug === 'refunds')!;

// The mock is on a branch, which opens on "this branch vs main"; #rev=worktree
// opens the plain map.
async function open(page: Page, hash = '#rev=worktree') {
  await page.request.post('/__mock/reset');
  await page.goto('/' + hash);
  await expect(page.locator('#map [data-box]').first()).toBeVisible();
  while ((await page.locator('#map').getAttribute('data-far')) === '1') await page.locator('#zin').click();
}

async function search(page: Page, text: string) {
  await page.keyboard.press('Control+k');
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

test('detail follows what you select: at rest, hovered, a module, a trace', async ({ page }) => {
  await open(page);
  // at rest: boxes only, each its name and what it holds; no rows, no calls, no "N more"
  await expect(box(page, ORDERS)).toContainText('13 functions');
  await expect(page.locator('#map [data-node]')).toHaveCount(0);
  await expect(page.locator('#map .edge')).toHaveCount(0);
  await expect(page.locator('#map [data-more]')).toHaveCount(0);
  // hovering a box shows its rows and its calls in and out
  await box(page, ORDERS).locator('.box').first().hover({ force: true });
  await expect(page.locator('#map')).toHaveAttribute('data-hover', ORDERS);
  await expect(node(page, INSERT)).toBeVisible();
  await expect(page.locator('#map .edge').first()).toBeAttached();
  await expect(page.locator(`#map [data-node="${TOTAL}"]`)).toHaveCount(0);
  await page.mouse.move(5, 940);
  await expect(page.locator('#map .edge')).toHaveCount(0);
  await expect(page.locator('#map [data-node]')).toHaveCount(0);
  // a module shows its public surface (what other modules call, and what
  // touches a table), never its internals
  await search(page, 'internal/orders');
  await page.mouse.move(5, 940);
  await expect(node(page, INSERT)).toBeVisible();
  await expect(page.locator(`#map [data-node="${TOTAL}"]`)).toHaveCount(0);
  // a function shows its path, down to the table
  await search(page, '/checkout');
  await expect(node(page, 'page:/checkout')).toHaveClass(/\bsel\b/);
  await expect(node(page, 'table:orders')).toHaveClass(/\bon\b/);
  await expect(page.locator('#drawer').getByText('Call tree')).toBeVisible();
  // the trace stops 4 levels down; what's below still shows as effects
  await expect(page.locator('#drawer .trow .reach', { hasText: 'writes orders' })).toBeVisible();
  await expect(page.locator('#map path.edge.reach.on').first()).toBeAttached();
  // a screen is one step: its components aren't on the path, the API it calls is
  await expect(page.locator('#drawer .trow.eff', { hasText: 'PlaceOrderButton.onClick' })).toContainText('fetches POST /orders');
  await expect(page.locator('#map [data-node="ts:web/src/components/PlaceOrderButton.tsx#PlaceOrderButton"]')).toHaveCount(0);
  // its panel shows what's on it: components, and the action calling the API
  await expect(page.locator('#drawer').getByText('On this screen')).toBeVisible();
  await expect(page.locator('#drawer .trow', { hasText: /^onClick/ })).toContainText('fetches POST /orders');
  // a step of the story keeps the story on the map, and Escape goes back to it
  const view = await page.locator('#map g').first().getAttribute('transform');
  await page.locator('#drawer .trow[data-node="go:shop/internal/orders.(*Service).Place"]').click();
  await expect(page.locator('#drawer h2')).toHaveText('Service.Place');
  await expect(node(page, 'page:/checkout')).toBeVisible();
  expect(await page.locator('#map g').first().getAttribute('transform')).toBe(view);
  await page.keyboard.press('Escape');
  await expect(page.locator('#drawer h2')).toHaveText('/checkout');
  // there's no way to show every function
  await expect(page.locator('#showall')).toHaveCount(0);
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
  await expect(page.locator('#map .fn.prop').first()).toBeAttached();
  // a proposed function calling real code
  await search(page, 'internal/orders');
  await page.locator(`#map [data-add="${ORDERS}"]`).click();
  await page.locator('#f-name').fill('Service.Cancel');
  await page.locator('#f-name').press('Enter');
  await page.getByRole('button', { name: 'Add a call' }).click();
  // every row shows while picking the target: pan to it
  const at = (await node(page, INSERT).boundingBox())!;
  if (at.y > 700) {
    await page.mouse.move(30, 900);
    await page.mouse.down();
    await page.mouse.move(30, 900 - (at.y - 400), { steps: 6 });
    await page.mouse.up();
  }
  await node(page, INSERT).click();
  await expect.poll(async () => (await refunds(page)).nodes).toContainEqual({ id: 'new:Service.Cancel', kind: 'function', label: 'Service.Cancel', module: ORDERS });
  await page.locator("#fit").click();
  // drag a function to another module: the proposal moves it (once the fit
  // has finished moving the map)
  await expect.poll(async () => {
    const a = await node(page, INSERT).boundingBox();
    await page.waitForTimeout(100);
    const b = await node(page, INSERT).boundingBox();
    return !!a && !!b && a.x === b.x && a.y === b.y;
  }).toBe(true);
  const row = (await node(page, INSERT).boundingBox())!,
    to = (await page.locator('#map [data-mod="mod:go:shop/internal/payments"]').boundingBox())!;
  await page.mouse.move(row.x + 20, row.y + row.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await refunds(page)).nodes).toContainEqual({ id: INSERT, module: 'mod:go:shop/internal/payments' });
  // comment: c, type, Enter; highlighting code quotes it
  await search(page, 'Service.Place');
  const pre = page.locator('#drawer .code[data-file] pre.c').first();
  await pre.scrollIntoViewIfNeeded();
  const b = (await pre.boundingBox())!;
  await page.mouse.move(b.x + 2, b.y + 4);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width - 4, b.y + 30);
  await page.mouse.up();
  await expect(page.locator('#c-text')).toBeFocused();
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
  await expect(node(page, id)).toHaveClass(/\bsel\b/);
  await expect(node(page, id)).toHaveClass(/\bd-(add|cha|rem)\b/);
  await page.locator('#cmp-x').click();
  await expect(page.locator('#cmp')).not.toContainText('vs main');
});

test('folders of many side-by-side modules fold into a group that opens on click, and a trace opens the ones it runs through', async ({ page }) => {
  await page.request.put('/__mock/load', { data: bigGraph() });
  await page.goto('/#rev=worktree');
  await expect(box(page, 'group:internal/plugins')).toBeVisible();
  await expect(box(page, 'group:internal/plugins')).toContainText('20 modules');
  await expect(box(page, 'mod:go:big/internal/plugins/p3')).toHaveCount(0);
  // the rest of the map shows whole
  await expect(box(page, 'mod:go:big/internal/api')).toBeVisible();
  // a click on its caret opens it in place
  await page.locator('#map [data-gtoggle="group:internal/plugins"]').first().click({ force: true });
  await expect(page.locator('#map [data-group-box="group:internal/plugins"]')).toBeVisible();
  await expect(box(page, 'mod:go:big/internal/plugins/p7')).toBeVisible();
  await page.locator('#map [data-gtoggle="group:internal/plugins"]').first().click({ force: true });
  await expect(box(page, 'mod:go:big/internal/plugins/p7')).toHaveCount(0);
  await search(page, '/feed');
  await expect(box(page, 'mod:go:big/internal/plugins/p3')).toBeVisible();
  await expect(box(page, 'mod:go:big/internal/plugins/p5')).toHaveCount(0);
});

test('a repo with an old areas.toml still opens, without areas', async ({ page }) => {
  await open(page);
  await expect(page.locator('#map [data-area-box]')).toHaveCount(0);
  expect((await (await page.request.get('/api/state')).json()).project.areas).toBeUndefined();
  await page.keyboard.press('Control+k');
  await page.keyboard.type('area');
  await expect(page.locator('[data-cmd="area"]')).toHaveCount(0);
});
