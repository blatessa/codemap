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

type P = { slug: string; body: string; nodes?: { id: string; module?: string; doc?: string }[]; notes?: { on?: string; file?: string; from?: number; to?: number; text: string }[] };
const refunds = async (page: Page) => ((await (await page.request.get('/api/proposals')).json()) as P[]).find((p) => p.slug === 'refunds')!;

// clickLine clicks a visible stretch of a line on the map: some point along it that nothing else covers.
async function clickLine(page: Page, line: ReturnType<Page['locator']>) {
  const pt = await line.first().evaluate((p: SVGGeometryElement) => {
    const c = (p as unknown as SVGGraphicsElement).getScreenCTM()!;
    const len = p.getTotalLength();
    for (const f of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.1, 0.9]) {
      const q = p.getPointAtLength(len * f);
      const x = q.x * c.a + c.e,
        y = q.y * c.d + c.f;
      if (document.elementFromPoint(x, y) === p) return { x, y };
    }
    return null;
  });
  if (!pt) throw new Error('no visible stretch of the line');
  await page.mouse.click(pt.x, pt.y);
}

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
  // add to a part from a popup on the map, with what it does
  await page.locator(`#map [data-add="${ORDERS}"]`).click();
  await page.locator('#f-name').fill('Service.Cancel');
  await page.getByRole('button', { name: '+ What it does' }).click();
  await page.locator('#f-doc').fill('Cancels an order and gives back its stock.');
  await page.locator('#f-doc').press('Enter');
  await expect.poll(async () => (await refunds(page)).nodes).toContainEqual({ id: 'new:Service.Cancel', kind: 'function', label: 'Service.Cancel', module: ORDERS, doc: 'Cancels an order and gives back its stock.' });
  // then click what it calls: a function in a part...
  await expect(page.locator('.cpill')).toContainText('Service.Cancel');
  await page.locator(`#map [data-box="${ORDERS}"]`).first().click({ position: { x: 20, y: 10 } });
  await page.locator('#t-q').fill('Repo.Insert');
  await page.locator('#t-q').press('Enter');
  await expect.poll(async () => ((await refunds(page)) as P & { edges?: { from: string; to: string }[] }).edges).toContainEqual({ from: 'new:Service.Cancel', to: INSERT });
  // ...or a table, with how it's used
  await page.locator('#map [data-node="table:orders"]').click();
  await page.getByRole('button', { name: 'writes' }).click();
  await page.locator('#e-detail').fill('UPDATE orders SET status');
  await page.locator('#e-detail').press('Enter');
  await expect
    .poll(async () => ((await refunds(page)) as P & { edges?: { from: string; to: string; type?: string; detail?: string }[] }).edges)
    .toContainEqual({ from: 'new:Service.Cancel', to: 'table:orders', type: 'writes', detail: 'UPDATE orders SET status' });
  await page.keyboard.press('Escape');
  // it's drawn inside its part, and listed under it in the proposal's changes
  await expect(page.locator('#map .padd[data-node="new:Service.Cancel"]')).toBeVisible();
  await expect(page.locator('#drawer .pchange', { hasText: 'Service.Cancel' })).toContainText('orders.Repo.Insert');
  await page.locator('#drawer .pchange .iname', { hasText: 'Service.Cancel' }).click();
  await expect(page.locator('#drawer h2')).toHaveText('Service.Cancel');
  await page.locator('#drawer .pback').click();
  // move a real function to another part
  await search(page, 'Repo.Insert');
  await page.locator('#move-to').selectOption('mod:go:shop/internal/payments');
  await expect.poll(async () => (await refunds(page)).nodes).toContainEqual({ id: INSERT, module: 'mod:go:shop/internal/payments' });
  // a comment on code: click a line number and type; it sits under the line
  await search(page, 'Service.Place');
  await expect(page.locator('#drawer h2')).toHaveText('Service.Place');
  await page.locator('#drawer .code .ln').first().click();
  await page.keyboard.type('Why is this a transaction?');
  await page.keyboard.press('Enter');
  await expect(page.locator('#drawer .lined .note', { hasText: 'Why is this a transaction?' })).toBeVisible();
  await expect
    .poll(async () => (await refunds(page)).notes?.find((n) => n.text === 'Why is this a transaction?'))
    .toMatchObject({ on: 'go:shop/internal/orders.(*Service).Place', file: 'internal/orders/service.go' });
  // highlighting code offers a Comment button; it opens the box under those lines
  await expect(async () => {
    const pre = page.locator('#drawer .code[data-file] pre.c').last();
    await pre.scrollIntoViewIfNeeded({ timeout: 500 });
    const b = (await pre.boundingBox())!;
    await page.mouse.move(b.x + 2, b.y + 4);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width - 4, b.y + 40);
    await page.mouse.up();
    await page.locator('.schip').click({ timeout: 500 });
    await expect(page.locator('#drawer .note.draft textarea')).toBeFocused({ timeout: 500 });
  }).toPass({ timeout: 5000 });
  await page.keyboard.type('Reserve after payment.');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await refunds(page)).notes?.find((n) => n.text === 'Reserve after payment.'))
    .toMatchObject({ file: 'internal/orders/service.go' });
  expect((await refunds(page)).notes?.find((n) => n.text === 'Reserve after payment.')?.to).toBeGreaterThan(0);
  // a comment can be edited in place
  await page.locator('#drawer .note p', { hasText: 'Reserve after payment.' }).click();
  await expect(page.locator('#drawer .note.draft textarea')).toBeFocused();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Reserve after the charge succeeds.');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await refunds(page)).notes?.map((n) => n.text)).toContain('Reserve after the charge succeeds.');
});

test('proposals: drag from a node to wire it', async ({ page }) => {
  await open(page);
  await page.locator('#m-propose').click();
  await page.locator('.pitem[data-slug="refunds"]').click();
  await page.locator(`#map [data-add="${ORDERS}"]`).click();
  await page.locator('#f-name').fill('Service.Cancel');
  await page.locator('#f-name').press('Enter');
  await page.keyboard.press('Escape');
  const row = page.locator('#map .padd[data-node="new:Service.Cancel"]');
  const drag = async (to: { x: number; y: number }) => {
    await row.hover();
    const b = (await row.locator('.handle').boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
  };
  const edges = async () => ((await refunds(page)) as P & { edges?: { from: string; to: string; type?: string }[] }).edges;
  // dropped on empty canvas: a new node, called by this one
  const rb = (await row.boundingBox())!;
  await drag({ x: rb.x + 20, y: rb.y - 200 });
  await page.locator('#f-name').fill('Audit.Write');
  await page.locator('#f-name').press('Enter');
  await expect.poll(edges).toContainEqual({ from: 'new:Service.Cancel', to: 'new:Audit.Write' });
  // dropped on a table: how it's used
  const t = (await page.locator('#map [data-node="table:orders"]').boundingBox())!;
  await drag({ x: t.x + t.width / 2, y: t.y + t.height / 2 });
  await page.locator('#e-detail').press('Enter');
  await expect.poll(edges).toContainEqual({ from: 'new:Service.Cancel', to: 'table:orders', type: 'writes' });
});

test('proposals: edit and delete what you added', async ({ page }) => {
  await open(page);
  await page.locator('#m-propose').click();
  await page.locator('.pitem[data-slug="refunds"]').click();
  await page.locator(`#map [data-add="${ORDERS}"]`).click();
  await page.locator('#f-name').fill('Service.Cancel');
  await page.locator('#f-name').press('Enter');
  await page.keyboard.press('Escape');
  await page.locator('#map .padd[data-node="new:Service.Cancel"]').click();
  // clicking it on the map opens the popup that added it: rename it, say what it does
  await expect(page.locator('#f-name')).toHaveValue('Service.Cancel');
  await page.locator('#f-name').fill('Service.Abort');
  await page.getByRole('button', { name: '+ What it does' }).click().catch(() => {});
  await page.locator('#f-doc').fill('Stops an order.');
  await page.locator('#f-doc').press('Enter');
  await expect.poll(async () => (await refunds(page)).nodes).toContainEqual({ id: 'new:Service.Cancel', kind: 'function', label: 'Service.Abort', module: ORDERS, doc: 'Stops an order.' });
  // give it a call, then change and remove it, in the same popup that added it
  await page.getByRole('button', { name: 'Add a call' }).click();
  await page.locator('#pick-q').fill('Repo.Insert');
  await page.locator('#pick-q').press('Enter');
  const edges = async () => ((await refunds(page)) as P & { edges?: { from: string; to: string; detail?: string }[] }).edges?.filter((e) => e.from === 'new:Service.Cancel');
  await expect.poll(edges).toHaveLength(1);
  await page.locator('#drawer .pcall2').click();
  await page.locator('#e-detail').fill('inserts the order');
  await page.locator('#e-detail').press('Enter');
  await expect.poll(edges).toEqual([{ from: 'new:Service.Cancel', to: INSERT, detail: 'inserts the order' }]);
  await page.locator('#drawer .pcall2').click();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect.poll(edges).toHaveLength(0);
  // click a call's line on the map to change it
  await page.getByRole('button', { name: 'Add a call' }).click();
  await page.locator('#pick-q').fill('orders');
  await page.locator('#pick-q').press('Enter');
  await expect.poll(edges).toHaveLength(1);
  await clickLine(page, page.locator('#map path.linehit[data-link*="new:Service.Cancel"]'));
  await page.locator('#e-detail').fill('the whole table');
  await page.locator('#e-detail').press('Enter');
  await expect.poll(edges).toEqual([{ from: 'new:Service.Cancel', to: 'table:orders', type: 'writes', detail: 'the whole table' }]);
  // drag the line's end to point the call somewhere else
  await page.locator('#map .padd[data-node="new:Service.Cancel"]').hover();
  await page.locator('#map path.linehit[data-link*="new:Service.Cancel"]').first().hover({ force: true });
  const eh = (await page.locator('#map .ehandle[data-link*="new:Service.Cancel"]').first().boundingBox())!;
  const stock = (await page.locator('#map [data-node="table:stock"]').boundingBox())!;
  await page.mouse.move(eh.x + eh.width / 2, eh.y + eh.height / 2);
  await page.mouse.down();
  await page.mouse.move(stock.x + stock.width / 2, stock.y + stock.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.locator('#e-detail').press('Enter');
  await expect.poll(edges).toEqual([{ from: 'new:Service.Cancel', to: 'table:stock', type: 'writes', detail: 'the whole table' }]);
  // Delete, in the node's popup, takes it out of the proposal
  await page.locator('#map .padd[data-node="new:Service.Cancel"]').click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(async () => (await refunds(page)).nodes?.some((n) => n.id === 'new:Service.Cancel')).toBe(false);
});

test('proposals: a popup stays with its node; a line of several calls lists them', async ({ page }) => {
  await open(page);
  await page.locator('#m-propose').click();
  await page.locator('.pitem[data-slug="refunds"]').click();
  await page.locator(`#map [data-add="${ORDERS}"]`).click();
  await page.locator('#f-name').fill('Service.Cancel');
  await page.locator('#f-name').press('Enter');
  await page.keyboard.press('Escape');
  // two calls into one part make one line that stands for both
  for (const name of ['Client.Charge', 'Handler.HandleWebhook']) {
    await page.locator('#map .padd[data-node="new:Service.Cancel"]').click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Add a call' }).click();
    await page.locator('#pick-q').fill(name);
    await page.locator('#pick-q').press('Enter');
  }
  const hit = page.locator('#map path.linehit[data-link^="new:Service.Cancel>mod:go:shop/internal/payments"]');
  await clickLine(page, hit);
  await expect(page.locator('.mpop .mlist button[data-edge]')).toHaveCount(2);
  await page.locator('.mpop .mlist button[data-edge]').first().click();
  await expect(page.locator('#e-detail')).toBeVisible();
  await page.keyboard.press('Escape');
  // edit popup sits beside its node, and moves with it when the map is dragged
  await page.locator('#map .padd[data-node="new:Service.Cancel"]').click();
  await expect(page.locator('#f-name')).toBeVisible();
  const node = page.locator('#map .padd[data-node="new:Service.Cancel"] rect');
  // beside the node, or kept inside the map you can see when the node is near its edge
  const beside = async () => {
    const pop = (await page.locator('.mpop').boundingBox())!;
    const n = (await node.boundingBox())!;
    const right = Math.abs(pop.x - (n.x + n.width + 14)) < 3;
    const left = Math.abs(pop.x + pop.width - (n.x - 14)) < 16;
    expect(right || left).toBe(true);
    return pop.x;
  };
  const before = await beside();
  // zoom the map: the node moves, and the popup goes with it
  await page.locator('#zin').click();
  await expect(page.locator('#f-name')).toBeVisible();
  const after = await beside();
  expect(after).not.toBe(before);
});

test('on a branch the map opens on what changed, and the summary jumps to it', async ({ page }) => {
  await open(page, '');
  await expect(page.locator('#cmp')).toContainText('vs main');
  const d = page.locator('#drawer');
  const first = d.locator('.pchange [data-node]').first();
  const id = (await first.getAttribute('data-node'))!;
  await first.click();
  // its part is selected and marked changed
  await expect(page.locator('#map .mod.msel, #map .padd.sel, #map .res.sel').first()).toHaveClass(/\b(d-(add|has|cha|rem)|cmp|sel)\b/);
  await expect(page.locator('#drawer h2')).not.toBeEmpty();
  expect(id).toBeTruthy();
  // the node's own panel says what changed about it
  await expect(page.locator('#drawer .kind')).toContainText(/Added|Changed|Removed/);
  // another comparison, from the picker
  await page.locator('#cmp').click();
  await page.locator('#cmp-pop [data-preset="uncommitted"]').click();
  await expect(page.locator('#cmp')).toContainText('Uncommitted');
  await page.locator('#cmp-x').click();
  await expect(page.locator('#cmp')).not.toContainText('vs main');
});
