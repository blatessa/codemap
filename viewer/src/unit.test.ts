import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { blockFor, escapeGlob, globMatch, pathMatch } from './blocks';
import { classify, humanize } from './fields';
import { FOLD_AT, buildGrouping, chain } from './groups';
import { SYNTH, buildModel, selectionOf, testsReaching, trace } from './model';
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
    const S = selectionOf(m, ['page:/checkout'])!;
    expect(S.nodes.has('table:orders')).toBe(true);
    expect(S.nodes.has('go:shop/internal/payments.(*Handler).HandleWebhook')).toBe(false);
    const X = selectionOf(m, ['ext:stripe'])!;
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
    const S = selectionOf(m, ['go:shop/internal/orders.(*Service).Place'])!;
    expect(S.path.has('go:shop/internal/orders.(*Repo).Insert')).toBe(true);
    expect(S.path.has('go:shop/internal/orders.(CreateOrder).Total')).toBe(false); // leads nowhere: folded
    expect(S.path.has('go:shop/internal/orders.writeJSON')).toBe(false);
    // selecting a module doesn't open up its internals
    expect(selectionOf(m, ['mod:go:shop/internal/orders'])!.path.size).toBe(0);
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
  // calls: [from, to] paths; each module has one function, F, and `entry` ones a route
  const graph = (paths: string[], calls: [string, string][] = [], entry: string[] = []): Graph => ({
    version: 1,
    modules: paths.map((p) => ({ id: 'mod:' + p, label: p, path: p, lang: 'go' })),
    nodes: [
      ...paths.map((p) => ({ id: p + '.F', kind: 'function', label: 'F', module: 'mod:' + p })),
      ...entry.map((p) => ({ id: 'route:' + p, kind: 'route', label: '/' + p, module: 'mod:' + p, entry: true })),
    ],
    edges: calls.map(([a, b]) => ({ from: a + '.F', to: b + '.F', type: 'calls' })),
  });
  const group = (paths: string[], calls: [string, string][] = [], keep: string[] = [], entry: string[] = []) => {
    const m = buildModel(graph(paths, calls, entry), [], null);
    const links: [string, string][] = m.edges.map((e) => [m.node.get(e.from)!.box.id, m.node.get(e.to)!.box.id]);
    return buildGrouping(m.boxes, m.box, new Set(keep), links);
  };
  const many = (dir: string, n: number) => Array.from({ length: n }, (_, i) => `${dir}/p${i}`);

  test('a folder of many side-by-side siblings folds, whatever the size of the map', () => {
    const G = group(['internal/integration', ...many('internal/integration', FOLD_AT)], many('internal/integration', FOLD_AT).map((p) => ['internal/integration', p]));
    expect(G.top.sort()).toEqual(['group:internal/integration', 'mod:internal/integration']);
    const g = G.groups.get('group:internal/integration')!;
    expect(g.members).toHaveLength(FOLD_AT);
    expect(g.box.label).toBe('internal/integration/*');
    expect(chain(G, 'mod:internal/integration/p3')).toEqual(['group:internal/integration']);
  });

  test('fewer siblings than FOLD_AT stay open', () => {
    const G = group(many('internal/integration', FOLD_AT - 1));
    expect(G.groups.size).toBe(0);
    expect(G.top).toHaveLength(FOLD_AT - 1);
  });

  test('siblings that call each other are a subsystem, not a set, and stay open', () => {
    const ps = many('internal', 10);
    const calls = ps.slice(1).map((p, i): [string, string] => [ps[i], p]); // a chain
    const G = group(ps, calls);
    expect(G.groups.size).toBe(0);
  });

  test('a helper several siblings use stays out; the siblings still fold', () => {
    const ps = many('migrations', 8);
    const G = group(['migrations/base', ...ps], ps.map((p) => [p, 'migrations/base']));
    expect(G.top).toContain('mod:migrations/base');
    expect(G.groups.get('group:migrations')!.members).toHaveLength(8);
  });

  test('entry points and plain modules are different kinds', () => {
    const routes = many('routers', 3);
    const G = group([...routes, ...many('routers/x', 0), 'routers/a', 'routers/b', 'routers/c'], [], [], routes);
    expect(G.groups.size).toBe(0);
    const G2 = group(many('routers', 7), [], [], many('routers', 7).slice(0, 3));
    expect(G2.groups.size).toBe(0);
  });

  test('folds nest: an opened group holds its own folded sets', () => {
    const fmts = many('models/packages', 7);
    const G = group([...many('models', 7), 'models/packages', ...fmts]);
    const outer = G.groups.get('group:models')!;
    expect(outer).toBeTruthy();
    expect(G.groups.get('group:models/packages')!.parent).toBe('group:models');
    expect(outer.children).toContain('group:models/packages');
    expect(outer.children).toContain('mod:models/packages');
    expect(chain(G, 'mod:models/packages/p1')).toEqual(['group:models/packages', 'group:models']);
  });

  test('a one-child chain reads as one path, for TS directories too', () => {
    const G = group([...many('frontend/apps/site/app/components', 8), 'backend/main']);
    expect([...G.groups.keys()]).toEqual(['group:frontend/apps/site/app/components']);
  });

  test('kept (shared) modules never fold', () => {
    const G = group(many('internal/reader', 8), [], ['mod:internal/reader/p7']);
    expect(G.top).toContain('mod:internal/reader/p7');
    expect(G.groups.get('group:internal/reader')!.members).not.toContain('mod:internal/reader/p7');
  });
});

describe('traces on a big codebase', () => {
  // h calls six Error implementations from one site (a wide call), a shared
  // function with effects (save) and a utility (getEngine); each of those
  // calls on into deep code that isn't part of h's trace.
  const fn = (id: string, fields?: Record<string, unknown>) => ({ id: 'go:x/a.' + id, kind: 'function', label: id, module: 'mod:go:x/a', fields });
  const errs = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6'];
  const g: Graph = {
    version: 1,
    modules: [
      { id: 'mod:go:x/a', label: 'a', lang: 'go', path: 'a' },
      { id: 'mod:sql:database', label: 'database', lang: 'sql', path: '', external: true },
    ],
    nodes: [
      fn('h'), fn('save', { shared: true }), fn('getEngine', { role: 'utility' }), fn('deep'), fn('step1'), fn('step2'), fn('step3'), fn('step4'), fn('step5'),
      ...errs.map((e) => fn(e)),
      { id: 'table:t', kind: 'table', label: 't', module: 'mod:sql:database', external: true },
      { id: 'table:u', kind: 'table', label: 'u', module: 'mod:sql:database', external: true },
    ],
    edges: [
      ...errs.map((e) => ({ from: 'go:x/a.h', to: 'go:x/a.' + e, type: 'calls', file: 'a/a.go', line: 3 })),
      { from: 'go:x/a.h', to: 'go:x/a.save', type: 'calls', file: 'a/a.go', line: 4 },
      { from: 'go:x/a.h', to: 'go:x/a.getEngine', type: 'calls', file: 'a/a.go', line: 5 },
      { from: 'go:x/a.save', to: 'go:x/a.deep', type: 'calls', file: 'a/a.go', line: 9 },
      { from: 'go:x/a.getEngine', to: 'go:x/a.deep', type: 'calls', file: 'a/a.go', line: 12 },
      { from: 'go:x/a.E1', to: 'go:x/a.deep', type: 'calls', file: 'a/a.go', line: 20 },
      { from: 'go:x/a.h', to: 'go:x/a.step1', type: 'calls', file: 'a/a.go', line: 6 },
      { from: 'go:x/a.step1', to: 'go:x/a.step2', type: 'calls', file: 'a/a.go', line: 30 },
      { from: 'go:x/a.step2', to: 'go:x/a.step3', type: 'calls', file: 'a/a.go', line: 31 },
      { from: 'go:x/a.step3', to: 'go:x/a.step4', type: 'calls', file: 'a/a.go', line: 32 },
      { from: 'go:x/a.step4', to: 'go:x/a.step5', type: 'calls', file: 'a/a.go', line: 33 },
      { from: 'go:x/a.step5', to: 'table:u', type: 'writes', file: 'a/a.go', line: 34 },
      { from: 'go:x/a.save', to: 'table:t', type: 'writes', file: 'a/a.go', line: 10 },
    ],
  };
  const m = buildModel(g, [], null);
  const id = (s: string) => 'go:x/a.' + s;

  test('a selection stops at wide calls, utilities and shared functions', () => {
    const S = selectionOf(m, [id('h')])!;
    expect(S.nodes.has(id('save'))).toBe(true);
    expect(S.nodes.has(id('getEngine'))).toBe(false); // support code isn't part of a trace
    expect(S.nodes.has(id('E1'))).toBe(false);
    expect(S.nodes.has(id('deep'))).toBe(false);
    // and going up, a wide call isn't a caller of each implementation
    expect(selectionOf(m, [id('E3')])!.nodes.has(id('h'))).toBe(false);
  });

  test('a selection still reaches effects below the depth limit', () => {
    const S = selectionOf(m, [id('h')])!;
    expect(S.nodes.has(id('step5'))).toBe(false);
    expect(S.nodes.has('table:u')).toBe(true);
    const e = S.extra.find((x) => x.to === 'table:u' && x.from === id('step4'))!;
    expect(e).toMatchObject({ from: id('step4'), type: 'writes', synth: 'reach' });
    expect(e.i).toBeGreaterThanOrEqual(SYNTH);
    expect(S.edges.has(e.i)).toBe(true);
  });

  test('the call tree folds a wide call into one row and stops at depth', () => {
    const t = trace(m, id('h'));
    const rows = t.rows;
    expect(t.support).toBe(2); // getEngine, and the wide call: they lead nowhere
    expect(rows.find((r) => r.id === id('step4'))!.reaches).toEqual([{ to: 'table:u', type: 'writes' }]);
    expect(rows.filter((r) => r.targets)).toHaveLength(0);
    expect(rows.find((r) => r.id === id('save'))!.more).toBe(true);
    expect(rows.some((r) => r.id === id('deep'))).toBe(false);
    expect(rows.find((r) => r.id === id('step4'))!.more).toBe(true);
    expect(rows.some((r) => r.id === id('step5'))).toBe(false);
  });
});
