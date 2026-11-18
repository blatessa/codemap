import { expect, test, type Page } from '@playwright/test';

// Change requests on proposals (PLAN.md §6.1). The fixture's refunds proposal
// has three items: i1 on Service.Place's charge lines, i2 a test, i3 a move.
const PLACE = 'go:shop/internal/orders.(*Service).Place';
const MARKPAID = 'go:shop/internal/orders.(*Service).MarkPaid';
const node = (page: Page, id: string) => page.locator(`#map [data-node="${id}"]`).first();

interface It {
  id: string;
  kind: string;
  target?: string;
  status?: string;
  text?: string;
  file?: string;
  lines?: number[];
  quote?: string;
  to?: string;
  rev?: string;
}
async function items(page: Page): Promise<It[]> {
  const ps = (await (await page.request.get('/api/proposals')).json()) as { slug: string; items?: It[] }[];
  return ps.find((p) => p.slug === 'refunds')?.items ?? [];
}

async function open(page: Page) {
  await page.request.post('/__mock/reset');
  await page.goto('/');
  await expect(page.locator('#map [data-box]').first()).toBeVisible();
}

async function openProposal(page: Page, name = 'Refunds') {
  await page.locator('#m-propose').click();
  await page.locator('.pitem', { hasText: name }).click();
  await expect(page.locator('#p-name')).toHaveValue(name);
  while ((await page.locator('#map').getAttribute('data-far')) === '1') await page.locator('#zin').click();
}

async function search(page: Page, text: string) {
  await page.keyboard.press('/');
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

test.beforeEach(async ({ page }) => open(page));

test('the proposals list shows open/total requests', async ({ page }) => {
  await page.locator('#m-propose').click();
  await expect(page.locator('.pitem[data-slug="refunds"] .rcount')).toHaveText('3/3 requests');
});

test('a request on a node, from explore mode, goes into a new proposal', async ({ page }) => {
  await search(page, 'Repo.UpdateStatus');
  await page.locator('#req').click();
  await page.locator('#r-prop').selectOption('');
  await page.locator('#r-pname').fill('Status cleanup');
  await page.locator('#r-kind [data-kind="rename"]').click();
  await page.locator('#r-to').fill('Repo.SetStatus');
  await page.locator('#r-text').fill('Name it after what it does');
  await page.locator('#r-save').click();
  // the new proposal opens with its checklist
  await expect(page.locator('#p-name')).toHaveValue('Status cleanup');
  await expect(page.locator('#checklist .ritem')).toHaveCount(1);
  await expect.poll(async () => {
    const ps = (await (await page.request.get('/api/proposals')).json()) as { slug: string; items?: It[] }[];
    return ps.find((p) => p.slug === 'status-cleanup')?.items?.[0];
  }).toMatchObject({ id: 'i1', kind: 'rename', target: 'go:shop/internal/orders.(*Repo).UpdateStatus', to: 'Repo.SetStatus', status: 'open' });
});

test('a request on a node in an open proposal is appended through the API', async ({ page }) => {
  await openProposal(page);
  await search(page, 'Repo.UpdateStatus');
  await page.locator('#req').click();
  await page.locator('#r-kind [data-kind="remove"]').click();
  await page.locator('#r-text').fill('Fold into Refund');
  await page.locator('#r-save').click();
  await expect.poll(async () => (await items(page)).at(-1)).toMatchObject({ id: 'i4', kind: 'remove', text: 'Fold into Refund', rev: '3333333' });
  await expect(page.locator('#checklist [data-item="i4"]')).toBeVisible();
});

test('a request on selected code lines stores file, lines and quote, and highlights them', async ({ page }) => {
  await openProposal(page);
  await search(page, 'Service.MarkPaid');
  const drawer = page.locator('#drawer');
  await drawer.locator('[data-gl="66"]').click();
  await drawer.locator('[data-gl="69"]').click({ modifiers: ['Shift'] });
  await page.locator('#req-code').click();
  await expect(page.locator('.rquote')).toContainText('o, err := s.repo.UpdateStatus(ctx, chargeID, "paid")');
  await page.locator('#r-text').fill('Ignore unknown charges');
  await page.locator('#r-save').click();
  await expect.poll(async () => (await items(page)).at(-1)).toMatchObject({
    kind: 'change',
    target: MARKPAID,
    file: 'internal/orders/service.go',
    lines: [66, 69],
    quote: 'o, err := s.repo.UpdateStatus(ctx, chargeID, "paid")\nif err != nil {\nreturn err\n}',
  });
  // back on the function, the requested lines are marked
  await search(page, 'Service.MarkPaid');
  await expect(drawer.locator('.c [data-ln="67"]')).toHaveClass(/\brq\b/);
  await expect(drawer.locator('.c [data-ln="70"]')).not.toHaveClass(/\brq\b/);
});

test('test requests: add a test for a function, change a test', async ({ page }) => {
  await openProposal(page);
  await search(page, 'Service.MarkPaid');
  await page.locator('#req-test').click();
  await expect(page.locator('#r-kind [data-kind="test"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#r-text').fill('Webhook for an unknown charge');
  await page.locator('#r-save').click();
  await expect.poll(async () => (await items(page)).at(-1)).toMatchObject({ kind: 'test', target: MARKPAID });
  await search(page, 'Service.Place');
  await page.locator('[data-test-req="test:go:shop/internal/orders.TestPlace_OutOfStock"]').click();
  await page.locator('#r-kind [data-kind="remove"]').click();
  await page.locator('#r-text').fill('Covered by the inventory tests');
  await page.locator('#r-save').click();
  await expect.poll(async () => (await items(page)).at(-1)).toMatchObject({ kind: 'remove', target: 'test:go:shop/internal/orders.TestPlace_OutOfStock' });
});

test('dragging a function onto another module records a move', async ({ page }) => {
  await openProposal(page);
  await search(page, 'Repo.Find');
  await page.locator('#drawer .x').click();
  const from = await node(page, 'go:shop/internal/orders.(*Repo).Find').boundingBox();
  const to = await page.locator('#map [data-box="mod:go:shop/internal/payments"] .box').first().boundingBox();
  await page.mouse.move(from!.x + 30, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(from!.x + 80, from!.y + 20, { steps: 4 });
  await page.mouse.move(to!.x + to!.width / 2, to!.y + 12, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('#r-kind [data-kind="move"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#r-to')).toHaveValue('mod:go:shop/internal/payments');
  await expect.poll(async () => (await items(page)).at(-1)).toMatchObject({ kind: 'move', target: 'go:shop/internal/orders.(*Repo).Find', to: 'mod:go:shop/internal/payments' });
  await page.locator('#r-text').fill('Payments owns lookups by charge');
  await page.locator('#r-save').click();
  await expect(page.locator('#map [data-move]')).toHaveCount(2); // with the fixture's i3
});

test('pins mark targets, count, and open the item', async ({ page }) => {
  await openProposal(page);
  await search(page, 'Service.Place'); // centres it, away from the drawer
  const pin = page.locator(`#map [data-pin-target="${PLACE}"]`);
  await expect(pin).toBeVisible();
  await expect(pin.locator('text')).toHaveText('2'); // i1 and i2
  await expect(page.locator(`#map [data-pin-target="${MARKPAID}"]`)).toBeVisible();
  await expect(page.locator('#map [data-move="i3"]')).toBeAttached();
  await pin.click();
  await expect(page.locator('#drawer .eyebrow', { hasText: 'Request i1' })).toBeVisible();
  await expect(page.locator('#r-text')).toHaveValue("Charge after Insert so a failed insert doesn't leave a charge");
  // explore mode: no pins
  await page.locator('#r-text').press('Escape');
  await page.locator('#m-explore').click();
  await expect(page.locator('#map [data-pin]')).toHaveCount(0);
});

test('checklist: status change, done hides the pin, wontfix dims it', async ({ page }) => {
  await openProposal(page);
  const row = page.locator('#checklist [data-item="i3"]');
  await row.locator('[data-status="done"]').click();
  await expect(page.locator('#checklist [data-group="done"] [data-item="i3"]')).toBeVisible();
  await expect.poll(async () => (await items(page)).find((x) => x.id === 'i3')?.status).toBe('done');
  await expect(page.locator(`#map [data-pin-target="${MARKPAID}"]`)).toHaveCount(0);
  await page.locator('#checklist [data-item="i2"] [data-status="wontfix"]').click();
  await expect(page.locator(`#map [data-pin-target="${PLACE}"] text`)).toHaveCount(0); // one open left
  await page.locator('#checklist [data-item="i1"] [data-status="wontfix"]').click();
  await expect(page.locator(`#map [data-pin-target="${PLACE}"]`)).toHaveClass(/\bdim\b/);
  // clicking an item selects its target
  await page.locator('#checklist [data-item="i1"] .rt').click();
  await expect(page.locator('#drawer h2')).toContainText('Service.Place');
  await expect(page.locator('#drawer .c [data-ln="52"]')).toHaveClass(/\bfx\b/);
});

test('see changes opens compare from the item rev', async ({ page }) => {
  await openProposal(page);
  await search(page, 'Repo.UpdateStatus');
  await page.locator('#req').click();
  await page.locator('#r-text').fill('Return the order');
  await page.locator('#r-save').click();
  const row = page.locator('#checklist [data-item="i4"]');
  await row.locator('[data-status="done"]').click();
  await expect.poll(async () => (await items(page)).find((x) => x.id === 'i4')?.status).toBe('done');
  await row.locator('[data-see="i4"]').click();
  await expect(page).toHaveURL(/#compare=3333333\.\.worktree$/);
  await expect(page.locator('#drawer .dhead h2')).toContainText('Repo.UpdateStatus');
});

test('an item added through the API shows up live', async ({ page }) => {
  await openProposal(page);
  await expect(page.locator('#checklist .ritem')).toHaveCount(3);
  const r = await page.request.post('/api/proposals/refunds/items', { data: { kind: 'question', target: PLACE, text: 'Is Place idempotent?' } });
  expect(r.ok()).toBeTruthy();
  await expect(page.locator('#checklist [data-item="i4"]')).toContainText('Is Place idempotent?');
  await page.request.patch('/api/proposals/refunds/items/i4', { data: { status: 'done', reply: 'Yes, keyed by cart' } });
  await expect(page.locator('#checklist [data-group="done"] [data-item="i4"]')).toContainText('Yes, keyed by cart');
});

test('an edge is selectable from the call lists and takes requests', async ({ page }) => {
  await search(page, 'Service.Place');
  await page.locator('#drawer [data-edge-sel$="-> go:shop/internal/orders.(*Repo).Insert"]').click();
  await expect(page.locator('#drawer .eyebrow', { hasText: 'Call' })).toBeVisible();
  await page.locator('#req').click();
  await page.locator('#r-text').fill('Insert first');
  await page.locator('#r-save').click();
  await expect.poll(async () => (await items(page)).at(-1)?.target).toBe(`${PLACE} -> go:shop/internal/orders.(*Repo).Insert`);
});
