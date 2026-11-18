import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { blockFor, escapeGlob, globMatch, pathMatch } from './blocks';
import { classify, humanize } from './fields';
import { GROUP_AT, buildGrouping, chain } from './groups';
import { buildModel, selectionOf, testsReaching } from './model';
import type { Graph } from './types';

describe('blocks (port of project.BlockFor)', () => {
  // same cases as internal/project TestBlockFor
  const blocks = [
    { id: 'block:checkout', name: '', from: 'mod:ts:web/src/pages', match: ['/checkout*', '/orders/*'] },
    { id: 'block:account', name: '', from: 'mod:ts:web/src/pages', files: ['web/src/pages/account/**'] },
  ];
  test.each([
    [{ module: 'mod:ts:web/src/pages', label: '/checkout' }, 'block:checkout'],
    [{ module: 'mod:ts:web/src/pages', label: '/orders/:id' }, 'block:checkout'],
    [{ module: 'mod:ts:web/src/pages', label: '/settings', file: 'web/src/pages/account/deep/Settings.tsx' }, 'block:account'],
    [{ module: 'mod:ts:web/src/pages', label: '/login', file: 'web/src/pages/LoginPage.tsx' }, ''],
    [{ module: 'mod:other', label: '/checkout' }, ''],
  ])('%o -> %s', (n, want) => expect(blockFor(blocks, n)).toBe(want));

  test('path.Match semantics', () => {
    expect(pathMatch('a*', 'abc')).toBe(true);
    expect(pathMatch('a*', 'a/b')).toBe(false);
    expect(pathMatch('a?c', 'abc')).toBe(true);
    expect(pathMatch('[a-c]x', 'bx')).toBe(true);
    expect(pathMatch('[^a-c]x', 'dx')).toBe(true);
    expect(pathMatch('[^a-c]x', 'ax')).toBe(false);
    expect(pathMatch('\\*', '*')).toBe(true);
    expect(pathMatch('\\*', 'a')).toBe(false);
    expect(pathMatch('[', '[')).toBe(false); // malformed
    expect(globMatch('a/**/c.go', 'a/b/d/c.go')).toBe(true);
    expect(globMatch('a/**', 'a/b/c')).toBe(true);
    expect(globMatch('a/**/c.go', 'b/c.go')).toBe(false);
  });

  test('exact match lists survive glob characters', () => {
    for (const s of ['Handler.Get', '/orders/[id]', 'a*b?', 'x\\y']) expect(pathMatch(escapeGlob(s), s)).toBe(true);
    expect(pathMatch(escapeGlob('a*'), 'abc')).toBe(false);
  });
});

describe('field rendering rules (§3.3)', () => {
  const isNode = (id: string) => id === 'table:orders' || id === 'ext:stripe';
  test.each([
    ['https://x.dev', 'link'],
    [{ label: 'Docs', url: 'https://x' }, 'links'],
    [[{ label: 'A', url: 'https://a' }, { label: 'B', url: 'https://b' }], 'links'],
    ['table:orders', 'ref'],
    [['table:orders', 'ext:stripe'], 'refs'],
    [[['id', 'uuid', 'pk'], ['name', 'text', '']], 'table'],
    [[{ a: 1, b: 2 }, { b: 3, a: 4 }], 'table'],
    [{ code: 'type X struct{}', lang: 'go', file: 'x.go', line: 3 }, 'code'],
    [42, 'text'],
    [true, 'text'],
    ['plain', 'text'],
    [['db/migrations/0001.sql', 'db/migrations/0004.sql'], 'text'],
    [{ region: 'us-east-1', nested: { a: 1 } }, 'object'],
    [[{ a: 1 }, { b: 2 }], 'object'],
    [null, 'none'],
  ])('%j -> %s', (v, want) => expect(classify(v, isNode)).toBe(want));

  test('labels', () => {
    expect(humanize('snake_case')).toBe('Snake case');
    expect(humanize('owner')).toBe('Owner');
  });
});

describe('model on the shop fixture', () => {
  const g = JSON.parse(readFileSync(new URL('../../testdata/shop.expected.json', import.meta.url), 'utf8')) as Graph;
  const m = buildModel(g, [], null);

  test('tests are hidden from the map', () => {
    expect([...m.node.keys()].some((id) => id.startsWith('test:'))).toBe(false);
    expect(m.tests.length).toBeGreaterThan(0);
  });

  test('paths stop at external nodes unless one is selected', () => {
    const S = selectionOf(m, ['page:/checkout'], [])!;
    expect(S.nodes.has('table:orders')).toBe(true);
    expect(S.nodes.has('go:shop/internal/payments.(*Handler).HandleWebhook')).toBe(false);
    const X = selectionOf(m, ['ext:stripe'], [])!;
    expect(X.nodes.has('go:shop/internal/payments.(*Handler).HandleWebhook')).toBe(true);
  });

  test('test reach never crosses fetches edges', () => {
    const fe = testsReaching(m, ['ts:web/src/api/orders.ts#createOrder']).map((t) => t.test.id);
    expect(fe).toContain('test:ts:web/src/components/PlaceOrderButton.test.tsx#navigates to the new order');
    const be = testsReaching(m, ['go:shop/internal/orders.(*Service).Place']).map((t) => t.test.id);
    expect(be.some((id) => id.startsWith('test:ts:'))).toBe(false);
  });

  test('blocks split rows out of their module', () => {
    const mb = buildModel(g, [{ id: 'block:repo', name: 'repo', from: 'mod:go:shop/internal/orders', match: ['Repo.*'] }], null);
    expect(mb.box.get('block:repo')!.rows.map((r) => r.label).sort()).toEqual(['Repo.Find', 'Repo.Insert', 'Repo.UpdateStatus']);
    expect(mb.box.get('mod:go:shop/internal/orders')!.rows.some((r) => r.label.startsWith('Repo.'))).toBe(false);
  });

  test('proposal refs to missing IDs become ghosts', () => {
    const mp = buildModel(g, [], {
      slug: 'x',
      name: 'x',
      status: 'open',
      body: '',
      nodes: [{ id: 'new:a', kind: 'function', label: 'A', module: 'mod:go:shop/internal/orders' }],
      edges: [{ from: 'new:a', to: 'go:shop/gone.Func' }],
    });
    expect(mp.node.get('new:a')!.row.prop).toBe(true);
    expect(mp.node.get('go:shop/gone.Func')!.row.ghost).toBe(true);
    expect(mp.edges.some((e) => e.prop && e.to === 'go:shop/gone.Func')).toBe(true);
  });
});

describe('public rows and shared modules', () => {
  const g = JSON.parse(readFileSync(new URL('../../testdata/shop.expected.json', import.meta.url), 'utf8')) as Graph;

  test('internal rows are the ones with no edge leaving their box', () => {
    const m = buildModel(g, [], null);
    const orders = m.box.get('mod:go:shop/internal/orders')!;
    expect(orders.rows.filter((r) => !r.pub).map((r) => r.label).sort()).toEqual(['CreateOrder.Total', 'writeError', 'writeJSON']);
    expect(orders.pub).toBe(orders.rows.length - 3);
    // a block boundary counts as a module boundary
    const mb = buildModel(g, [{ id: 'block:repo', name: 'repo', from: 'mod:go:shop/internal/orders', match: ['Repo.*'] }], null);
    expect(mb.box.get('block:repo')!.rows.every((r) => r.pub)).toBe(true);
  });

  test('a path keeps its internal rows', () => {
    const m = buildModel(g, [], null);
    const S = selectionOf(m, ['go:shop/internal/orders.(*Service).Place'], [])!;
    expect(S.path.has('go:shop/internal/orders.(CreateOrder).Total')).toBe(true);
    expect(S.path.has('go:shop/internal/orders.writeJSON')).toBe(false);
    // selecting a module doesn't open up its internals
    expect(selectionOf(m, ['mod:go:shop/internal/orders'], [])!.path.size).toBe(0);
  });

  test('no shop module is shared', () => {
    expect(buildModel(g, [], null).boxes.filter((b) => b.shared)).toEqual([]);
  });

  test('a module most others call, and that calls nothing back, is shared', () => {
    const mods = ['a', 'b', 'c', 'd', 'core'].map((x) => ({ id: 'mod:' + x, label: x }));
    const nodes = mods.map((mo) => ({ id: mo.label + '.F', kind: 'function', label: 'F', module: mo.id }));
    nodes.push({ id: 'core.T', kind: 'test', label: 'T', module: 'mod:core' });
    const edges = [
      { from: 'a.F', to: 'b.F', type: 'calls' },
      { from: 'a.F', to: 'core.F', type: 'calls' },
      { from: 'b.F', to: 'core.F', type: 'calls' },
      { from: 'c.F', to: 'core.F', type: 'calls' },
      { from: 'd.F', to: 'c.F', type: 'calls' },
    ];
    const m = buildModel({ version: 1, modules: mods, nodes, edges }, [], null);
    expect(m.box.get('mod:core')!.shared).toBe(true);
    expect(m.box.get('mod:core')!.usedBy).toBe(3);
    expect(m.boxes.filter((b) => b.shared).map((b) => b.id)).toEqual(['mod:core']);
    // calling out to two other modules makes it part of the flow instead
    edges.push({ from: 'core.F', to: 'a.F', type: 'calls' }, { from: 'core.F', to: 'd.F', type: 'calls' });
    expect(buildModel({ version: 1, modules: mods, nodes, edges }, [], null).box.get('mod:core')!.shared).toBe(false);
  });
});

describe('folder groups', () => {
  const graph = (paths: string[]): Graph => ({
    version: 1,
    modules: paths.map((p) => ({ id: 'mod:' + p, label: p, path: p })),
    nodes: paths.map((p) => ({ id: p + '.F', kind: 'function', label: 'F', module: 'mod:' + p })),
    edges: [],
  });
  const group = (paths: string[], keep: string[] = []) => {
    const m = buildModel(graph(paths), [], null);
    return buildGrouping(m.boxes, m.box, new Set(keep));
  };
  const many = (dir: string, n: number) => Array.from({ length: n }, (_, i) => `${dir}/p${i}`);

  test('small maps are left alone', () => {
    expect(group(many('internal', GROUP_AT))).toBeNull();
  });

  test('big folders of similar packages fold; the rest shows', () => {
    const top = ['cmd/app', 'internal/api', 'internal/store', 'internal/auth', 'internal/a', 'internal/b', 'internal/c', 'internal/d', 'internal/e'];
    const G = group([...top, ...many('internal/reader', 20), ...many('internal/integration', 25), 'internal/http/request', 'internal/http/response'])!;
    expect(G.top.filter((id) => id.startsWith('group:')).sort()).toEqual(['group:internal/integration', 'group:internal/reader']);
    for (const p of top) expect(G.top).toContain('mod:' + p);
    // small folders open
    expect(G.top).toContain('mod:internal/http/request');
    expect(G.groups.get('group:internal/reader')!.members).toHaveLength(20);
    expect(chain(G, 'mod:internal/reader/p3')).toEqual(['group:internal/reader']);
    expect(G.top.length).toBeLessThanOrEqual(GROUP_AT);
  });

  test('a one-child chain reads as one path, for TS directories too', () => {
    const G = group([...many('frontend/apps/site/app/components', 30), 'frontend/apps/site/app/hooks', 'backend/main'])!;
    expect([...G.groups.keys()]).toContain('group:frontend/apps/site/app/components');
    expect([...G.groups.keys()].some((k) => k === 'group:frontend' || k === 'group:frontend/apps')).toBe(false);
  });

  test('kept modules (in an area, or shared) never fold', () => {
    const G = group([...many('internal/reader', 20), ...many('internal/plugins', 20)], ['mod:internal/reader/p7'])!;
    expect(G.top).toContain('mod:internal/reader/p7');
    expect(G.groups.get('group:internal/reader')!.members).not.toContain('mod:internal/reader/p7');
  });
});
