import { expect, test, type Page } from '@playwright/test';

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

test('splitting a module into a block writes blocks.yaml, and merge back removes it', async ({ page }) => {
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
