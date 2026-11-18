import { expect, test, type Page } from '@playwright/test';

// The mock's history (mock/revs.ts): HEAD "Archive old orders" adds Repo.Archive
// (writes users); the worktree removes it, adds the expire-carts job and changes
// Repo.Find and Store.Reserve.
const node = (page: Page, id: string) => page.locator(`[data-node="${id}"]`).first();
const box = (page: Page, id: string) => page.locator(`#map [data-box="${id}"]`).first();
const FIND = 'go:shop/internal/orders.(*Repo).Find';
const ARCHIVE = 'go:shop/internal/orders.(*Repo).Archive';
const JOB = 'job:expire-carts';
const PLACE = 'go:shop/internal/orders.(*Service).Place';
const GET_ORDER = 'ts:web/src/api/orders.ts#getOrder';

async function open(page: Page, hash = '') {
  await page.request.post('/__mock/reset');
  await page.goto('/' + hash);
  await expect(page.locator('#map [data-box]').first()).toBeVisible();
  await near(page);
}

async function preset(page: Page, id: string) {
  await page.locator('#cmp').click();
  await page.locator(`#cmp-pop [data-preset="${id}"]`).click();
}

// near zooms in past the zoomed-out mode, so rows draw
async function near(page: Page) {
  for (let i = 0; i < 3; i++) await page.locator('#zin').click();
}

test('uncommitted changes: added, removed and changed nodes are coloured', async ({ page }) => {
  await open(page);
  await preset(page, 'uncommitted');
  await expect(page.locator('#cmp')).toContainText('Uncommitted changes');
  await expect(node(page, JOB)).toHaveClass(/\bd-add\b/);
  await expect(node(page, ARCHIVE)).toHaveClass(/\bd-rem\b/);
  await expect(node(page, FIND)).toHaveClass(/\bd-cha\b/);
  await expect(node(page, 'go:shop/internal/orders.(*Repo).Insert')).not.toHaveClass(/\bd-/);
  await expect(box(page, 'mod:go:shop/internal/orders')).toHaveClass(/\bd-has\b/);
  await expect(page.locator('#map path.edge.d-add').first()).toBeAttached();
  await expect(page.locator('#map path.edge.d-rem').first()).toBeAttached();
  await expect(page).toHaveURL(/#compare=HEAD\.\.worktree$/);
  // read-only while comparing
  await expect(page.locator('#addarea')).toBeHidden();
  await expect(page.locator('#m-propose')).toBeHidden();
});

test('summary lists the changes and clicking one selects it on the map', async ({ page }) => {
  await open(page);
  await preset(page, 'uncommitted');
  const d = page.locator('#drawer');
  await expect(d.locator('#sum-title')).toHaveText('Uncommitted changes');
  await expect(d.getByText('Entry points')).toBeVisible();
  await expect(d.locator(`[data-go="${JOB}"]`)).toBeVisible();
  await expect(d.locator('.srem', { hasText: 'writes users' })).toBeVisible();
  await expect(d.locator('[data-go="mod:go:shop/internal/orders"]')).toContainText('~1');
  await d.locator(`[data-go="${JOB}"]`).click();
  await expect(node(page, JOB)).toHaveClass(/\bsel\b/);
  await expect(page.locator('#drawer h2')).toHaveText(/expire-carts/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#sum-title')).toBeVisible();
});

test('code diff for a changed node, with a toggle to the full source', async ({ page }) => {
  await open(page);
  await preset(page, 'uncommitted');
  await page.locator('#drawer [data-go="mod:go:shop/internal/orders"]').click();
  await node(page, FIND).click();
  const d = page.locator('#drawer');
  await expect(d.locator('.cdiff .la')).toContainText('changed in this revision');
  await d.locator('#src-full').click();
  await expect(d.locator('.cdiff')).toHaveCount(0);
  await expect(d.locator('.code')).toContainText('SELECT * FROM orders');
  await d.locator('#src-diff').click();
  await expect(d.locator('.cdiff')).toBeVisible();
});

test('changes only shows changed nodes plus one hop', async ({ page }) => {
  await open(page);
  await preset(page, 'uncommitted');
  await expect(node(page, 'page:/login')).toBeAttached();
  await page.locator('#changes-only').click();
  await expect(page.locator('#changes-only')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-node="page:/login"]')).toHaveCount(0);
  await near(page);
  await expect(node(page, JOB)).toBeAttached();
  await expect(node(page, ARCHIVE)).toBeAttached();
  // one hop: the job's handler and Archive's caller
  await expect(node(page, 'go:shop/internal/orders.(*Service).MarkPaid')).toBeAttached();
  await page.locator('#changes-only').click();
  await near(page);
  await expect(node(page, 'page:/login')).toBeAttached();
});

test('zoomed out, boxes with changes are marked', async ({ page }) => {
  await open(page);
  await preset(page, 'uncommitted');
  await expect(node(page, JOB)).toHaveClass(/\bd-add\b/);
  for (let i = 0; i < 6; i++) await page.locator('#zout').click();
  await expect(box(page, 'mod:go:shop/internal/inventory')).toHaveClass(/\bd-has\b/);
  await expect(box(page, 'mod:go:shop/internal/auth')).not.toHaveClass(/\bd-has\b/);
});

test('presets: last commit, branch vs main, a PR', async ({ page }) => {
  await open(page);
  await preset(page, 'last');
  await expect(page.locator('#cmp')).toContainText('Last commit');
  await expect(node(page, PLACE)).toHaveClass(/\bd-cha\b/);
  await expect(node(page, ARCHIVE)).not.toHaveClass(/\bd-/);
  await expect(page.locator('#sum-title')).toHaveText('Last commit');

  await preset(page, 'branch');
  await expect(page.locator('#cmp')).toContainText('This branch vs main');
  await expect(node(page, JOB)).toHaveClass(/\bd-add\b/);
  await expect(node(page, 'go:shop/internal/orders.(*Service).Place')).toHaveClass(/\bd-cha\b/);

  await preset(page, 'pr7');
  await expect(page.locator('#cmp')).toContainText('#7 Archive old orders');
  await expect(node(page, PLACE)).toHaveClass(/\bd-cha\b/);
  await expect(page.locator(`[data-node="${JOB}"]`)).toHaveCount(0);

  await page.locator('#cmp-x').click();
  await expect(page.locator('#cmp')).toContainText('worktree');
  await expect(node(page, JOB)).not.toHaveClass(/\bd-/);
  await expect(page.locator('#addarea')).toBeVisible();
});

test('timeline: click compares with the parent, shift-click compares two', async ({ page }) => {
  await open(page);
  await page.locator('#cmp').click();
  await page.locator('#tl-open').click();
  const tl = page.locator('#timeline');
  await expect(tl.locator('.tlrow')).toHaveCount(4); // uncommitted + 3 commits
  await expect(tl.locator('[data-sha^="3333"]')).toContainText('Archive old orders');
  await expect(tl.locator('[data-sha^="3333"] .ref')).toHaveText('agent/archive');
  await tl.locator('[data-sha^="2222"]').click();
  await expect(page.locator('#cmp')).toContainText('1111111 → 2222222');
  await expect(node(page, GET_ORDER)).toHaveClass(/\bd-add\b/);

  await page.locator('#cmp').click();
  await page.locator('#tl-open').click();
  await tl.locator('[data-sha^="1111"]').click({ modifiers: ['Shift'] });
  await tl.locator('[data-sha^="3333"]').click({ modifiers: ['Shift'] });
  await expect(page.locator('#cmp')).toContainText('1111111 → 3333333');
  await expect(node(page, ARCHIVE)).not.toHaveClass(/\bd-/);
  await expect(node(page, GET_ORDER)).toHaveClass(/\bd-add\b/);
  await expect(node(page, 'go:shop/internal/orders.(*Service).Place')).toHaveClass(/\bd-cha\b/);
});

test('since… compares a commit with the worktree', async ({ page }) => {
  await open(page);
  await preset(page, 'since');
  await page.locator('#timeline [data-sha^="1111"]').click();
  await expect(page.locator('#cmp')).toContainText('1111111 → worktree');
  await expect(node(page, GET_ORDER)).toHaveClass(/\bd-add\b/);
  await expect(node(page, JOB)).toHaveClass(/\bd-add\b/);
});

test('the URL keeps the comparison across a reload', async ({ page }) => {
  await open(page, '#compare=HEAD~1..HEAD');
  await expect(page.locator('#cmp')).toContainText('Last commit');
  await expect(node(page, PLACE)).toHaveClass(/\bd-cha\b/);
  await expect(node(page, ARCHIVE)).not.toHaveClass(/\bd-/);
  await page.reload();
  await expect(page.locator('#sum-title')).toHaveText('Last commit');
  await expect(page.locator('#map [data-box]').first()).toBeVisible();
  await near(page);
  await expect(node(page, PLACE)).toHaveClass(/\bd-cha\b/);
});

test('viewing a past rev is read-only and shows which rev', async ({ page }) => {
  await open(page);
  await page.locator('#cmp').click();
  await page.locator('#cmp-view').selectOption('main');
  await expect(page.locator('#cmp')).toContainText('main');
  await expect(page).toHaveURL(/#rev=main$/);
  await expect(node(page, ARCHIVE)).toBeAttached();
  await expect(page.locator(`[data-node="${JOB}"]`)).toHaveCount(0);
  await expect(page.locator('#addarea')).toBeHidden();
  await expect(page.locator('#m-propose')).toBeHidden();
});

test('pick any two revs to compare', async ({ page }) => {
  await open(page);
  await page.locator('#cmp').click();
  await page.locator('#cmp-from').selectOption('main');
  await page.locator('#cmp-to').selectOption('agent/archive');
  await page.locator('#cmp-go').click();
  await expect(page.locator('#cmp')).toContainText('main → agent/archive');
  await expect(node(page, 'go:shop/internal/orders.(*Service).Place')).toHaveClass(/\bd-cha\b/);
});
