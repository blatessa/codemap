import { expect, test, type Page } from '@playwright/test';
import { bigGraph } from './synth';

const node = (page: Page, id: string) => page.locator(`[data-node="${id}"]`).first();
const mod = (page: Page, id: string) => page.locator(`#map [data-mod="${id}"]`);

async function state(page: Page) {
  return (await page.request.get('/api/state')).json();
}

async function open(page: Page) {
  await page.request.post('/__mock/reset');
  await page.goto('/');
  await expect(page.locator('#map [data-box]').first()).toBeVisible();
}

async function search(page: Page, text: string) {
  await page.keyboard.press('/');
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

test.beforeEach(async ({ page }) => open(page));

test('selecting page:/checkout traces the path down to table:orders and stops at external nodes', async ({ page }) => {
  await search(page, '/checkout');
  await expect(node(page, 'page:/checkout')).toHaveClass(/\bsel\b/);
  await expect(node(page, 'table:orders')).toHaveClass(/\bon\b/);
  await expect(node(page, 'go:shop/internal/payments.(*Handler).HandleWebhook')).toHaveClass(/\bdim\b/);
  const drawer = page.locator('#drawer');
  await expect(drawer.getByText('Call tree')).toBeVisible();
  await expect(drawer.getByText('Tests along this path')).toBeVisible();
  await expect(drawer.getByText('navigates to the new order')).toBeVisible();
});

test('selecting an external node continues through it', async ({ page }) => {
  await search(page, 'api.stripe.com');
  await expect(node(page, 'go:shop/internal/payments.(*Handler).HandleWebhook')).toHaveClass(/\bon\b/);
  const drawer = page.locator('#drawer');
  await expect(drawer.getByText('Called by')).toBeVisible();
  await expect(drawer.getByText('Calls us')).toBeVisible();
  await expect(drawer.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', 'https://dashboard.stripe.com');
});

test('table fields render by duck typing with Writes and Reads from edge types', async ({ page }) => {
  await page.keyboard.press('/');
  await page.keyboard.type('orders');
  await page.locator('#results [data-go="table:orders"]').click();
  const drawer = page.locator('#drawer');
  await expect(drawer.getByText('Writes', { exact: true })).toBeVisible();
  await expect(drawer.getByText('Reads', { exact: true })).toBeVisible();
  await expect(drawer.getByText('Columns', { exact: true })).toBeVisible();
  await expect(drawer.locator('table.cols-t td', { hasText: 'charge_id' })).toBeVisible();
});

test('focus shows only the selected path', async ({ page }) => {
  await search(page, '/checkout');
  await page.locator('#focus').click();
  await expect(node(page, 'table:orders')).toBeVisible();
  await expect(page.locator('[data-node="go:shop/internal/payments.(*Handler).HandleWebhook"]')).toHaveCount(0);
});

test('splitting a module into a block writes blocks.toml, and merge back removes it', async ({ page }) => {
  await mod(page, 'mod:go:shop/internal/orders').click();
  const drawer = page.locator('#drawer');
  await drawer.getByRole('button', { name: 'Split…' }).click();
  await drawer.getByLabel('Repo.Insert').check();
  await drawer.getByLabel('Repo.Find').check();
  await drawer.locator('#s-name').fill('orders · repo');
  await drawer.getByRole('button', { name: 'Split', exact: true }).click();
  const box = page.locator('#map [data-box="block:orders-repo"]');
  await expect(box).toBeVisible();
  await expect(drawer.getByText('split from internal/orders')).toBeVisible();
  await expect
    .poll(async () => (await state(page)).project.blocks)
    .toEqual([{ id: 'block:orders-repo', name: 'orders · repo', from: 'mod:go:shop/internal/orders', match: ['Repo.Insert', 'Repo.Find'] }]);
  // the block joins the source module's area
  await expect.poll(async () => (await state(page)).project.areas.find((a: { name: string }) => a.name === 'Commerce').modules).toContain('block:orders-repo');

  await drawer.getByRole('button', { name: 'Merge back' }).click();
  await expect(box).toHaveCount(0);
  await expect.poll(async () => (await state(page)).project.blocks).toEqual([]);
});

test('creating an area, renaming it and dragging a module in', async ({ page }) => {
  await page.locator('#addarea').click();
  const name = page.locator('#a-name');
  await expect(name).toBeFocused();
  await name.fill('Payments flow');
  const area = page.locator('#map [data-area="Payments flow"]');
  await expect(area).toBeVisible();
  await expect.poll(async () => (await state(page)).project.areas.map((a: { name: string }) => a.name)).toContain('Payments flow');

  // drag internal/sched into the new (empty) area
  const target = await area.boundingBox();
  const src = await mod(page, 'mod:go:shop/internal/sched').boundingBox();
  await page.mouse.move(src!.x + 10, src!.y + 6);
  await page.mouse.down();
  await page.mouse.move(target!.x + 40, target!.y + 50, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => (await state(page)).project.areas.find((a: { name: string }) => a.name === 'Payments flow')?.modules)
    .toEqual(['mod:go:shop/internal/sched']);
  // dragging writes every position, so the layout stays put next time
  await expect.poll(async () => Object.keys((await state(page)).project.layout)).toContain('mod:go:shop/internal/sched');
});

test('shift-click builds a multi-selection that can become an area', async ({ page }) => {
  await mod(page, 'mod:go:shop/internal/events').click();
  await mod(page, 'mod:go:shop/internal/notify').click({ modifiers: ['Shift'] });
  const drawer = page.locator('#drawer');
  await expect(drawer.getByText('2 selected')).toBeVisible();
  await drawer.getByRole('button', { name: 'New area from these' }).click();
  await expect(page.locator('#a-name')).toHaveValue('New area');
  await expect
    .poll(async () => (await state(page)).project.areas.find((a: { name: string }) => a.name === 'New area')?.modules)
    .toEqual(['mod:go:shop/internal/events', 'mod:go:shop/internal/notify']);
});

test('saved views store selection and focus', async ({ page }) => {
  await search(page, '/checkout');
  await page.locator('#viewsbtn').click();
  await page.locator('#v-name').fill('Checkout');
  await page.locator('#v-name').press('Enter');
  await expect.poll(async () => (await state(page)).project.views).toEqual([{ name: 'Checkout', selection: ['page:/checkout'], focus: false, collapsed: [] }]);
  await page.keyboard.press('Escape');
  await page.locator('#viewsbtn').click();
  await page.locator('[data-view="Checkout"]').click();
  await expect(page.locator('#drawer h2')).toHaveText('/checkout');
});

async function openProposal(page: Page, name: string) {
  await page.locator('#m-propose').click();
  await page.locator('.pitem', { hasText: name }).click();
  await expect(page.locator('#p-name')).toHaveValue(name);
  // zoomed out, modules are single boxes; zoom in to see rows
  while ((await page.locator('#map').getAttribute('data-far')) === '1') await page.locator('#zin').click();
}

test("editing a proposal's body writes the proposal", async ({ page }) => {
  await openProposal(page, 'Refunds');
  // the proposal draws on the map in dashed purple
  await expect(page.locator('#map .fn.prop').first()).toBeAttached();
  await page.getByRole('button', { name: 'Edit' }).click();
  const body = page.locator('#p-body');
  await body.fill('## Why\nRefund from the order page.\n');
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.md h2')).toHaveText('Why');
  await expect(page.locator('.md p')).toHaveText('Refund from the order page.');
  await expect
    .poll(async () => ((await (await page.request.get('/api/proposals')).json()) as { slug: string; body: string }[]).find((p) => p.slug === 'refunds')?.body)
    .toBe('## Why\nRefund from the order page.\n');
});

test('archiving and reopening a proposal', async ({ page }) => {
  await openProposal(page, 'Refunds');
  await page.locator('#p-pr').fill('#91');
  await page.getByRole('button', { name: 'Archive' }).click();
  await expect(page.locator('.meta .pill')).toHaveText('archived');
  await expect(page.getByText('Closed by #91')).toBeVisible();
  const get = async () => ((await (await page.request.get('/api/proposals')).json()) as { slug: string; status: string; pr?: string }[]).find((p) => p.slug === 'refunds');
  await expect.poll(async () => (await get())?.status).toBe('archived');
  expect((await get())?.pr).toBe('#91');
  await page.getByRole('button', { name: 'Reopen' }).click();
  await expect.poll(async () => (await get())?.status).toBe('open');
});

test('proposing a function and a call writes nodes and edges', async ({ page }) => {
  await openProposal(page, 'Refunds');
  await search(page, 'Repo.UpdateStatus'); // brings internal/orders into view
  await page.locator('#map [data-add="mod:go:shop/internal/orders"]').click();
  await page.locator('#f-name').fill('Service.Cancel');
  await page.locator('#f-name').press('Enter');
  await expect(node(page, 'new:Service.Cancel')).toHaveClass(/\bprop\b/);
  await page.getByRole('button', { name: 'Add a call' }).click();
  await expect(page.locator('#banner')).toHaveText('Service.Cancel calls…');
  await node(page, 'go:shop/internal/orders.(*Repo).UpdateStatus').click();
  const get = async () => ((await (await page.request.get('/api/proposals')).json()) as { slug: string; nodes: object[]; edges: object[] }[]).find((p) => p.slug === 'refunds')!;
  await expect.poll(async () => (await get()).nodes).toContainEqual({ id: 'new:Service.Cancel', kind: 'function', label: 'Service.Cancel', module: 'mod:go:shop/internal/orders' });
  await expect.poll(async () => (await get()).edges).toContainEqual({ from: 'new:Service.Cancel', to: 'go:shop/internal/orders.(*Repo).UpdateStatus' });
});

test('zooming out merges calls between modules into weighted lines', async ({ page }) => {
  await search(page, 'Service.Place');
  await expect(page.locator('#map')).toHaveAttribute('data-far', '0');
  await expect(page.locator('#map .fn').first()).toBeVisible();
  while ((await page.locator('#map').getAttribute('data-far')) === '0') await page.locator('#zout').click();
  await expect(page.locator('#map .fn')).toHaveCount(0);
  const agg = page.locator('#map path[data-agg]');
  expect(await agg.count()).toBeGreaterThan(5);
  const counts = await agg.evaluateAll((ps) => ps.map((p) => Number(p.getAttribute('data-agg'))));
  expect(Math.max(...counts)).toBeGreaterThan(1);
});

test('collapse and expand a module', async ({ page }) => {
  await search(page, 'Service.Place');
  const toggle = page.locator('#map [data-toggle="mod:go:shop/internal/orders"]');
  await toggle.click();
  await expect(page.locator('#map [data-node="go:shop/internal/orders.(*Repo).Insert"]')).toHaveCount(0);
  await toggle.click();
  await expect(node(page, 'go:shop/internal/orders.(*Repo).Insert')).toBeVisible();
});

test('a graph-changed event re-fetches and keeps the selection', async ({ page }) => {
  await search(page, 'Service.Place');
  await expect(node(page, 'go:shop/internal/orders.(*Service).Place')).toHaveClass(/\bsel\b/);
  const g = (await state(page)).graph;
  g.nodes.push({ id: 'go:shop/internal/orders.(*Service).Refund', kind: 'function', label: 'Service.Refund', module: 'mod:go:shop/internal/orders' });
  g.edges.push({ from: 'go:shop/internal/orders.(*Service).Place', to: 'go:shop/internal/orders.(*Service).Refund', type: 'calls' });
  await page.request.put('/__mock/graph', { data: g });
  await expect(node(page, 'go:shop/internal/orders.(*Service).Refund')).toHaveClass(/\bon\b/);
  await expect(node(page, 'go:shop/internal/orders.(*Service).Place')).toHaveClass(/\bsel\b/);
  await expect(page.locator('#drawer').getByRole('button', { name: 'orders.Service.Refund' })).toBeVisible();
});

test('a write that conflicts with an outside edit reloads that file', async ({ page }) => {
  // no live updates, so the viewer doesn't hear about the outside edit
  await page.route('**/api/events', (r) => r.abort());
  await page.reload();
  await expect(page.locator('#map [data-box]').first()).toBeVisible();
  const s = await state(page);
  const r = await page.request.put('/api/project/views', { data: [{ name: 'Theirs' }], headers: { 'If-Match': s.versions.views } });
  expect(r.ok()).toBeTruthy();
  await page.locator('#viewsbtn').click();
  await page.locator('#v-name').fill('Mine');
  await page.locator('#v-name').press('Enter');
  await expect(page.locator('[data-view="Theirs"]')).toBeVisible();
  await expect(page.locator('[data-view="Mine"]')).toHaveCount(0);
  expect((await state(page)).project.views).toEqual([{ name: 'Theirs' }]);
});

test('dragging an area moves its modules and writes the layout', async ({ page }) => {
  const head = page.locator('#map [data-area="Messaging"]');
  const before = await mod(page, 'mod:go:shop/internal/notify').boundingBox();
  const b = await head.boundingBox();
  await page.mouse.move(b!.x + 30, b!.y + 8);
  await page.mouse.down();
  await page.mouse.move(b!.x + 30, b!.y + 108, { steps: 6 });
  await page.mouse.up();
  const after = await mod(page, 'mod:go:shop/internal/notify').boundingBox();
  expect(after!.y - before!.y).toBeGreaterThan(40);
  await expect.poll(async () => Object.keys((await state(page)).project.layout).length).toBeGreaterThan(10);
});

test('proposing a module in an area', async ({ page }) => {
  await openProposal(page, 'Refunds');
  await page.locator('#addmod').click();
  await page.locator('#f-area').selectOption('Commerce');
  await page.locator('#f-name').fill('internal/refunds');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('#map [data-box="new:mod:internal/refunds"]')).toHaveClass(/\bprop\b/);
  type P = { slug: string; modules: { id: string; area?: string }[] };
  const get = async () => ((await (await page.request.get('/api/proposals')).json()) as P[]).find((p) => p.slug === 'refunds')!;
  await expect.poll(async () => (await get()).modules?.[0]?.id).toBe('new:mod:internal/refunds');
  expect((await get()).modules[0].area).toBe('Commerce');
});

test('a proposal edge to an ID that no longer exists draws as a faint outline', async ({ page }) => {
  const s = await state(page);
  const p = s.project.proposals.find((x: { slug: string }) => x.slug === 'refunds');
  p.edges.push({ from: 'new:orders.Service.Refund', to: 'go:shop/internal/orders.(*Repo).Gone' });
  await page.request.put('/api/proposals/refunds', { data: p, headers: { 'If-Match': s.versions['proposals/refunds'] } });
  await openProposal(page, 'Refunds');
  await expect(page.locator('[data-node="go:shop/internal/orders.(*Repo).Gone"]')).toHaveClass(/\bghost\b/);
});

type AreaJ = { name: string; modules: string[] };
const areaOf = async (page: Page, name: string) => ((await state(page)).project.areas as AreaJ[]).find((a) => a.name === name)?.modules;

test('dragging a module out of its area leaves the area behind and removes it', async ({ page }) => {
  const area = page.locator('#map [data-area-box="Messaging"] .arect');
  const before = await area.boundingBox();
  const src = await mod(page, 'mod:go:shop/internal/events').boundingBox();
  await page.mouse.move(src!.x + 10, src!.y + 6);
  await page.mouse.down();
  // still inside its own area: that's the drop target
  await page.mouse.move(src!.x + 16, src!.y + 12, { steps: 3 });
  await expect(page.locator('#map [data-area-box="Messaging"]')).toHaveClass(/\bdrop\b/);
  // below everything: no target, and the area doesn't follow the box
  await page.mouse.move(src!.x + 10, src!.y + 256, { steps: 8 });
  await expect(page.locator('#map .area.drop')).toHaveCount(0);
  expect(await area.boundingBox()).toEqual(before);
  const last = await mod(page, 'mod:go:shop/internal/events').boundingBox();
  await page.mouse.up();
  await expect.poll(() => areaOf(page, 'Messaging')).toEqual(['mod:go:shop/internal/notify', 'mod:go:shop/internal/sched']);
  // the box stays where it was dropped, and the area shrinks to its other members
  expect(await mod(page, 'mod:go:shop/internal/events').boundingBox()).toEqual(last);
  expect((await area.boundingBox())!.height).toBeLessThan(before!.height);
});

test('dragging a module into another area highlights it and moves the module there', async ({ page }) => {
  const src = await mod(page, 'mod:go:shop/internal/sched').boundingBox();
  const target = await page.locator('#map [data-area-box="Commerce"] .arect').boundingBox();
  await page.mouse.move(src!.x + 10, src!.y + 6);
  await page.mouse.down();
  await page.mouse.move(target!.x + target!.width - 40, target!.y + target!.height - 16, { steps: 10 });
  await expect(page.locator('#map [data-area-box="Commerce"]')).toHaveClass(/\bdrop\b/);
  await expect(page.locator('#map .area.drop')).toHaveCount(1);
  const last = await mod(page, 'mod:go:shop/internal/sched').boundingBox();
  await page.mouse.up();
  await expect(page.locator('#map .area.drop')).toHaveCount(0);
  await expect.poll(() => areaOf(page, 'Commerce')).toContain('mod:go:shop/internal/sched');
  expect(await areaOf(page, 'Messaging')).not.toContain('mod:go:shop/internal/sched');
  // no jump on drop, nor after the writes come back from the server
  expect(await mod(page, 'mod:go:shop/internal/sched').boundingBox()).toEqual(last);
  await expect.poll(async () => Object.keys((await state(page)).project.layout)).toContain('mod:go:shop/internal/sched');
  await page.waitForTimeout(400);
  expect(await mod(page, 'mod:go:shop/internal/sched').boundingBox()).toEqual(last);
});

test('a module shows its public functions, and +N internal expands it', async ({ page }) => {
  const total = 'go:shop/internal/orders.(CreateOrder).Total',
    writeJSON = 'go:shop/internal/orders.writeJSON';
  await page.locator('#d-code').click();
  await search(page, 'Service.Place');
  const more = page.locator('#map [data-more="mod:go:shop/internal/orders"]');
  // an internal row on the selected path still shows
  await expect(node(page, total)).toBeVisible();
  await expect(page.locator(`#map [data-node="${writeJSON}"]`)).toHaveCount(0);
  await expect(more).toHaveText('+2 internal');
  await page.locator('#drawer .x').first().click();
  await expect(more).toHaveText('+3 internal');
  await expect(page.locator(`#map [data-node="${total}"]`)).toHaveCount(0);
  await more.click();
  await expect(node(page, writeJSON)).toBeVisible();
  await expect(more).toHaveText('− 3 internal');
  await more.click();
  await expect(page.locator(`#map [data-node="${writeJSON}"]`)).toHaveCount(0);
});

// ---- detail level and hiding ----

test('Features leaves support rows out, Code shows them, and a saved view keeps the level', async ({ page }) => {
  const main = 'go:shop/cmd/server.main',
    newService = 'go:shop/internal/orders.NewService',
    useOrder = 'ts:web/src/components/OrderStatus.tsx#useOrder';
  await expect(page.locator('#d-features')).toHaveAttribute('aria-pressed', 'true');
  await search(page, 'Repo.Find'); // zooms in
  await page.keyboard.press('Escape');
  await expect(page.locator(`#map [data-node="${main}"]`)).toHaveCount(0);
  await expect(page.locator(`#map [data-node="${newService}"]`)).toHaveCount(0);
  // one expander row per box, counting support and internal rows together
  await expect(page.locator('#map [data-more="mod:go:shop/internal/orders"]')).toHaveText('+6 more');
  await expect(page.locator('#map [data-more="mod:go:shop/cmd/server"]')).toHaveText('+5 support');
  await page.locator('#d-code').click();
  await expect(node(page, main)).toBeVisible();
  await expect(node(page, newService)).toBeVisible();
  await expect(node(page, useOrder)).toBeVisible();

  // a selected path shows support rows; a passthrough stays collapsed on the
  // map and shows, dimmed, in the call tree
  await page.locator('#d-features').click();
  await page.keyboard.press('/');
  await page.keyboard.type('/orders/:id');
  await page.locator('#results [data-go="page:/orders/:id"]').click();
  await expect(node(page, 'ts:web/src/api/http.ts#request')).toBeVisible();
  await expect(page.locator(`#map [data-node="${useOrder}"]`)).toHaveCount(0);
  await expect(page.locator(`#drawer .trow.sup[data-node="${useOrder}"]`)).toBeVisible();

  await page.locator('#d-code').click();
  await page.locator('#viewsbtn').click();
  await page.locator('#v-name').fill('All code');
  await page.locator('#v-name').press('Enter');
  await expect.poll(async () => (await state(page)).project.views.find((v: { name: string }) => v.name === 'All code')?.detail).toBe('code');
  await page.locator('#d-features').click();
  await page.locator('#viewsbtn').click();
  await page.locator('#views [data-view="All code"]').click();
  await expect(page.locator('#d-code')).toHaveAttribute('aria-pressed', 'true');
});

test('hiding a node takes it off the map; the Views menu unhides it', async ({ page }) => {
  const find = 'go:shop/internal/orders.(*Repo).Find';
  await search(page, 'Repo.Find');
  await page.locator('#drawer #hide').click();
  await expect(page.locator(`#map [data-node="${find}"]`)).toHaveCount(0);
  await expect.poll(async () => (await state(page)).project.hidden).toEqual([{ id: find }]);
  await page.locator('#d-code').click();
  await expect(page.locator(`#map [data-node="${find}"]`)).toHaveCount(0);

  // on a selected path it shows, dimmed
  await search(page, 'GET /orders/:id');
  await expect(node(page, find)).toHaveClass(/\bhid\b/);
  await page.keyboard.press('Escape');
  await expect(page.locator(`#map [data-node="${find}"]`)).toHaveCount(0);

  await page.locator('#viewsbtn').click();
  await page.locator('#hiddenbtn').click();
  await expect(page.locator('#hiddenbtn')).toHaveText('Hidden (1)');
  await page.locator(`#views [data-hidden="${find}"] button`).click();
  await expect(node(page, find)).toBeVisible();
  await expect.poll(async () => (await state(page)).project.hidden).toEqual([]);
  await expect(page.locator('#hiddenbtn')).toHaveCount(0);
});

test('hiding a module takes its box off the map', async ({ page }) => {
  await mod(page, 'mod:go:shop/internal/sched').click();
  await page.locator('#drawer #hide').click();
  await expect(page.locator('#map [data-box="mod:go:shop/internal/sched"]')).toHaveCount(0);
  await expect.poll(async () => (await state(page)).project.hidden).toEqual([{ id: 'mod:go:shop/internal/sched' }]);
});

// ---- folder groups, on a synthetic map too big to show whole ----

async function openBig(page: Page) {
  await page.request.put('/__mock/load', { data: bigGraph() });
  await page.goto('/');
  await expect(page.locator('#map [data-box]').first()).toBeVisible();
}
const box = (page: Page, id: string) => page.locator(`#map [data-box="${id}"]`);

test('a big map folds folders into groups that open and close in place', async ({ page }) => {
  await openBig(page);
  const plugins = 'group:internal/plugins';
  await expect(box(page, plugins)).toBeVisible();
  await expect(box(page, 'group:internal/reader')).toBeVisible();
  await expect(box(page, 'mod:go:big/internal/api')).toBeVisible();
  await expect(box(page, 'mod:go:big/internal/plugins/p5')).toHaveCount(0);
  const before = await box(page, 'mod:go:big/internal/api').boundingBox();

  await page.locator(`#map [data-mod="${plugins}"]`).dblclick();
  await expect(page.locator(`#map [data-group-box="${plugins}"]`)).toBeVisible();
  await expect(box(page, 'mod:go:big/internal/plugins/p5')).toBeVisible();
  await expect(box(page, plugins)).toHaveCount(0);
  // open groups are view state: saved views keep them
  await page.locator('#viewsbtn').click();
  await page.locator('#v-name').fill('plugins open');
  await page.locator('#v-name').press('Enter');
  await expect
    .poll(async () => (await state(page)).project.views.find((v: { name: string }) => v.name === 'plugins open')?.expanded)
    .toEqual([plugins]);
  await page.keyboard.press('Escape');

  await page.locator(`#map [data-group-box="${plugins}"] [data-gtoggle]`).click();
  await expect(box(page, plugins)).toBeVisible();
  await expect(box(page, 'mod:go:big/internal/plugins/p5')).toHaveCount(0);
  // closing puts the map back where it was
  expect(await box(page, 'mod:go:big/internal/api').boundingBox()).toEqual(before);
});

test('a traced path opens the groups it runs through', async ({ page }) => {
  await openBig(page);
  await search(page, '/feed');
  await expect(node(page, 'route:GET /feed')).toHaveClass(/\bsel\b/);
  // the path runs api -> reader/r0 -> plugins/p3: both groups open, showing only what's on it
  await expect(page.locator('#map [data-group-box="group:internal/reader"]')).toBeVisible();
  await expect(page.locator('#map [data-group-box="group:internal/plugins"]')).toHaveClass(/\breveal\b/);
  await expect(box(page, 'mod:go:big/internal/plugins/p3')).toBeVisible();
  await expect(box(page, 'mod:go:big/internal/plugins/p5')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(box(page, 'group:internal/plugins')).toBeVisible();
  await expect(box(page, 'mod:go:big/internal/plugins/p3')).toHaveCount(0);
});

test('search opens the group holding the hit', async ({ page }) => {
  await openBig(page);
  await expect(box(page, 'group:internal/reader')).toBeVisible();
  await search(page, 'r7.Parse');
  await expect(node(page, 'go:big/internal/reader/r7.Parse')).toHaveClass(/\bsel\b/);
  await expect(node(page, 'go:big/internal/reader/r7.Parse')).toBeVisible();
  await expect(page.locator('#map [data-group-box="group:internal/reader"]')).toBeVisible();
});
