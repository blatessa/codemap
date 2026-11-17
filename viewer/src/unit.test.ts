import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { blockFor, escapeGlob, globMatch, pathMatch } from './blocks';
import { classify, humanize } from './fields';
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
