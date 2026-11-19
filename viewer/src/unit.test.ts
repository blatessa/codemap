import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { classify, humanize } from './fields';
import { atRest, linksOf, partSub, partsOf } from './parts';
import { SYNTH, buildModel, selectionOf, testsReaching, trace } from './model';
import type { Graph } from './types';

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
  const m = buildModel(g, null);

  test('tests are hidden from the map', () => {
    expect([...m.node.keys()].some((id) => id.startsWith('test:'))).toBe(false);
    expect(m.tests.length).toBeGreaterThan(0);
  });

  test('paths stop at external nodes unless one is selected', () => {
    const S = selectionOf(m, 'page:/checkout')!;
    expect(S.nodes.has('table:orders')).toBe(true);
    expect(S.nodes.has('go:shop/internal/payments.(*Handler).HandleWebhook')).toBe(false);
    const X = selectionOf(m, 'ext:stripe')!;
    expect(X.nodes.has('go:shop/internal/payments.(*Handler).HandleWebhook')).toBe(true);
  });

  test('test reach never crosses fetches edges', () => {
    const fe = testsReaching(m, ['ts:web/src/api/orders.ts#createOrder']).map((t) => t.test.id);
    expect(fe).toContain('test:ts:web/src/components/PlaceOrderButton.test.tsx#navigates to the new order');
    const be = testsReaching(m, ['go:shop/internal/orders.(*Service).Place']).map((t) => t.test.id);
    expect(be.some((id) => id.startsWith('test:ts:'))).toBe(false);
  });

  test('proposal refs to missing IDs become ghosts', () => {
    const mp = buildModel(g, {
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

describe('public rows', () => {
  const g = JSON.parse(readFileSync(new URL('../../testdata/shop.expected.json', import.meta.url), 'utf8')) as Graph;

  test('internal rows are the ones with no edge leaving their box', () => {
    const m = buildModel(g, null);
    const orders = m.box.get('mod:go:shop/internal/orders')!;
    expect(orders.rows.filter((r) => !r.pub).map((r) => r.label).sort()).toEqual(['CreateOrder.Total', 'writeError', 'writeJSON']);
  });

  test('a path keeps its internal rows', () => {
    const m = buildModel(g, null);
    const S = selectionOf(m, 'go:shop/internal/orders.(*Service).Place')!;
    expect(S.path.has('go:shop/internal/orders.(*Repo).Insert')).toBe(true);
    expect(S.path.has('go:shop/internal/orders.(CreateOrder).Total')).toBe(false); // leads nowhere: folded
    expect(S.path.has('go:shop/internal/orders.writeJSON')).toBe(false);
    // selecting a module doesn't open up its internals
    expect(selectionOf(m, 'mod:go:shop/internal/orders')!.path.size).toBe(0);
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
  const m = buildModel(g, null);
  const id = (s: string) => 'go:x/a.' + s;

  test('a selection stops at wide calls, utilities and shared functions', () => {
    const S = selectionOf(m, id('h'))!;
    expect(S.nodes.has(id('save'))).toBe(true);
    expect(S.nodes.has(id('getEngine'))).toBe(false); // support code isn't part of a trace
    expect(S.nodes.has(id('E1'))).toBe(false);
    expect(S.nodes.has(id('deep'))).toBe(false);
    // and going up, a wide call isn't a caller of each implementation
    expect(selectionOf(m, id('E3'))!.nodes.has(id('h'))).toBe(false);
  });

  test('a selection still reaches effects below the depth limit', () => {
    const S = selectionOf(m, id('h'))!;
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

describe('the part map', () => {
  // the shop as codemap build writes it: modules carry their program
  const g = JSON.parse(readFileSync(new URL('../../testdata/shop.expected.json', import.meta.url), 'utf8')) as Graph;
  for (const mo of g.modules ?? []) if (!mo.external) mo.program = mo.id.startsWith('mod:ts:') ? 'shop-web' : 'shop';
  const m = buildModel(g, null);
  const P = partsOf(m);

  test('programs are frames, the one calling the other first; resources are frames of their own', () => {
    expect(P.frames.filter((f) => !f.resource).map((f) => f.label)).toEqual(['shop-web', 'shop']);
    expect(P.frames.filter((f) => f.resource).map((f) => f.label)).toEqual(['database', 'topics', 'external services']);
    const [web, server] = P.frames;
    expect(web.x + web.w).toBeLessThan(server.x);
  });

  test('a part is a box; a table, service or topic is a box of its own; a function is never one', () => {
    expect(P.thingOf('go:shop/internal/orders.(*Repo).Insert')).toBe('mod:go:shop/internal/orders');
    expect(P.thingOf('table:orders')).toBe('table:orders');
    expect(P.at.has('table:orders')).toBe(true);
    expect(P.at.has('go:shop/internal/orders.(*Repo).Insert')).toBe(false);
  });

  test('nothing overlaps', () => {
    const rs = [...P.at.values()];
    for (let i = 0; i < rs.length; i++)
      for (let j = i + 1; j < rs.length; j++) {
        const a = rs[i],
          b = rs[j];
        expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
      }
  });

  test('lines are typed by how things talk, and at rest show communication between programs and over events strongly', () => {
    const kind = (from: string, to: string) => P.links.filter((l) => l.from === from && l.to === to).map((l) => l.kind);
    expect(kind('mod:ts:web/src/api', 'mod:go:shop/cmd/server')).toEqual(['http']);
    expect(kind('mod:go:shop/internal/orders', 'table:orders')).toContain('writes');
    expect(P.links.filter((l) => atRest(P, l)).map((l) => l.kind).sort()).toEqual(expect.arrayContaining(['event', 'http']));
    expect(atRest(P, P.links.find((l) => l.kind === 'calls' && P.programOf(l.from) === P.programOf(l.to))!)).toBe(false);
  });

  test('a link stands for every function edge between its two things', () => {
    const l = linksOf(m, m.edges).find((x) => x.from === 'mod:go:shop/cmd/server' && x.to === 'mod:go:shop/internal/orders' && x.kind === 'calls')!;
    expect(l.edges.length).toBeGreaterThan(1);
  });

  test("a part says what it holds, by kind", () => {
    expect(partSub(m.box.get('mod:go:shop/cmd/server')!)).toMatch(/^1 job · 4 routes · 1 subscriber · \d+ functions$/);
    expect(partSub(m.box.get('mod:go:shop/internal/orders')!)).toBe('13 functions');
  });

  test('one layout: selecting changes what is lit, never where things are', () => {
    const before = JSON.stringify([...P.at]);
    selectionOf(m, 'route:POST /orders');
    expect(JSON.stringify([...partsOf(m).at])).toBe(before);
  });
});
