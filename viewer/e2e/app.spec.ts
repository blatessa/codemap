import { expect, test, type Page } from '@playwright/test';
import { bigGraph } from './synth';

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
  while ((await page.locator('#map').getAttribute('data-far')) === '1') await page.locator('#zin').click();
}

async function search(page: Page, text: string) {
  await page.keyboard.press('Control+k');
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

test('detail follows what you select: overview, a module, a trace, show all', async ({ page }) => {
  await open(page);
  // at rest: entry points show, internals wait behind "N more"
  await expect(node(page, 'route:POST /orders')).toBeVisible();
  await expect(page.locator(`#map [data-node="${INSERT}"]`)).toHaveCount(0);
  await expect(page.locator(`#map [data-more="${ORDERS}"]`)).toBeVisible();
  // a module shows everything in it
  await page.locator(`#map [data-more="${ORDERS}"]`).click();
  await expect(node(page, INSERT)).toBeVisible();
  // a function shows its path, down to the table
  await search(page, '/checkout');
  await expect(node(page, 'page:/checkout')).toHaveClass(/\bsel\b/);
  await expect(node(page, 'table:orders')).toHaveClass(/\bon\b/);
  await expect(page.locator('#drawer').getByText('Call tree')).toBeVisible();
  // everything, on request
  await page.keyboard.press('Escape');
  await page.locator('#showall').click();
  await expect(node(page, INSERT)).toBeVisible();
  await expect(page.locator(`#map [data-more]`)).toHaveCount(0);
  await expect(page.locator('#drawer .dhead')).toHaveCount(0);
});

test('search runs commands; switching selections keeps one panel', async ({ page }) => {
  await open(page);
  await search(page, 'show all');
  await expect(page.locator('#showall')).toHaveAttribute('aria-pressed', 'true');
  for (const q of ['web/src/api', 'internal/auth', 'Handler.Login']) await search(page, q);
  await expect(page.locator('#drawer .dhead')).toHaveCount(1);
});

test('a new area, with a module dragged in', async ({ page }) => {
  await open(page);
  await search(page, 'new area');
  await page.locator('#a-name').fill('Payments flow');
  await page.locator('#fit').click(); // the new area goes under everything
  const area = page.locator('#map [data-area-box="Payments flow"] .arect');
  const a = (await area.boundingBox())!,
    s = (await page.locator('#map [data-mod="mod:go:shop/internal/sched"]').boundingBox())!;
  await page.mouse.move(s.x + 10, s.y + 6);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => (await (await page.request.get('/api/state')).json()).project.areas.find((x: { name: string }) => x.name === 'Payments flow')?.modules)
    .toEqual(['mod:go:shop/internal/sched']);
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
  await node(page, INSERT).click();
  await expect.poll(async () => (await refunds(page)).nodes).toContainEqual({ id: 'new:Service.Cancel', kind: 'function', label: 'Service.Cancel', module: ORDERS });
  // drag a function to another module: the proposal moves it
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

test('a big map folds folders into groups, and a trace opens the ones it runs through', async ({ page }) => {
  await page.request.put('/__mock/load', { data: bigGraph() });
  await page.goto('/#rev=worktree');
  await expect(box(page, 'group:internal/plugins')).toBeVisible();
  await expect(box(page, 'mod:go:big/internal/plugins/p3')).toHaveCount(0);
  await search(page, '/feed');
  await expect(box(page, 'mod:go:big/internal/plugins/p3')).toBeVisible();
  await expect(box(page, 'mod:go:big/internal/plugins/p5')).toHaveCount(0);
});


test('when an agent changes areas.toml, the open map lays out again with the new areas', async ({ page }) => {
  await open(page);
  const st = await (await page.request.get('/api/state')).json();
  const areas = (st.project.areas as { name: string; modules: string[] }[]).map((a) => ({
    ...a,
    modules: a.name === 'Web app' ? [...a.modules, 'mod:go:shop/internal/sched'] : a.modules.filter((m) => m !== 'mod:go:shop/internal/sched'),
  }));
  await page.request.put('/api/project/areas', { data: areas, headers: { 'If-Match': st.versions.areas } });
  const inside = async () => {
    const a = await page.locator('#map [data-area-box="Web app"] .arect').boundingBox();
    const b = await page.locator('#map [data-box="mod:go:shop/internal/sched"]').first().boundingBox();
    return !!a && !!b && b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width + 1 && b.y + b.height <= a.y + a.height + 1;
  };
  await expect.poll(inside).toBe(true);
});
