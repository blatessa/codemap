import { expect, test, type Page } from '@playwright/test';

type P = { slug: string; body: string; nodes?: { id: string; module?: string }[] };
const refunds = async (page: Page) => ((await (await page.request.get('/api/proposals')).json()) as P[]).find((p) => p.slug === 'refunds')!;

test.beforeEach(async ({ page }) => {
  await page.request.post('/__mock/reset');
  await page.goto('/');
  await expect(page.locator('#map [data-box]').first()).toBeVisible();
  await page.locator('#m-propose').click();
  await page.locator('.pitem[data-slug="refunds"]').click();
});

async function pick(page: Page, text: string) {
  await page.keyboard.press('/');
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

test('a comment on a function is appended to the proposal body', async ({ page }) => {
  await pick(page, 'Service.Place');
  await page.keyboard.press('c');
  await page.keyboard.type('Reserve after payment.');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await refunds(page)).body).toMatch(/### `[^`]*Service\.Place` · internal\/orders\/service\.go:\d+(-\d+)?\n\nReserve after payment\.\n$/);
});

test('highlighting code quotes the lines', async ({ page }) => {
  await pick(page, 'Service.Place');
  const pre = page.locator('#drawer .code[data-file] pre.c').first();
  await expect(pre).toBeVisible();
  const box = (await pre.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + 4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 4, box.y + 30);
  await page.mouse.up();
  await expect(page.locator('#comment .about')).toContainText('service.go:');
  await expect(page.locator('#c-text')).toBeFocused();
  await page.keyboard.type('This part.');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await refunds(page)).body).toContain('```go\n');
  expect((await refunds(page)).body).toMatch(/This part\.\n$/);
});

test('dragging a function onto another module proposes moving it', async ({ page }) => {
  const id = 'go:shop/internal/orders.(*Service).MarkPaid';
  await pick(page, 'Service.MarkPaid');
  await page.keyboard.press('Escape');
  const row = page.locator(`#map [data-node="${id}"]`);
  const target = page.locator('#map [data-mod="mod:go:shop/internal/payments"]');
  await target.scrollIntoViewIfNeeded();
  const a = (await row.boundingBox())!,
    b = (await target.boundingBox())!;
  await page.mouse.move(a.x + 20, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 40, a.y + a.height / 2, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await refunds(page)).nodes).toContainEqual({ id, module: 'mod:go:shop/internal/payments' });
  await expect(page.locator(`#map [data-box="mod:go:shop/internal/payments"] [data-node="${id}"]`)).toHaveClass(/\bprop\b/);
});

test('comments go to the last opened proposal from Explore too', async ({ page }) => {
  await page.locator('#m-explore').click();
  await pick(page, 'Service.Place');
  await page.keyboard.press('c');
  await page.keyboard.type('From explore.');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await refunds(page)).body).toMatch(/From explore\.\n$/);
});
