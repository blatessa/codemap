import { describe, expect, test } from 'vitest';
import { buildModel } from './model';
import { boxNamed, parseSpec, plan } from './wire';
import type { Graph } from './types';

const g: Graph = {
  version: 1,
  modules: [
    { id: 'mod:go:shop/cmd/server', label: 'cmd/server' },
    { id: 'mod:go:shop/internal/orders', label: 'internal/orders' },
    { id: 'mod:go:shop/internal/auth', label: 'internal/auth' },
    { id: 'db', label: 'database', external: true },
  ],
  nodes: [
    { id: 'r', kind: 'route', label: '/orders', module: 'mod:go:shop/cmd/server', entry: true },
    { id: 'f', kind: 'function', label: 'Repo.Find', module: 'mod:go:shop/internal/orders' },
    { id: 'a', kind: 'function', label: 'Handler.RequireUser', module: 'mod:go:shop/internal/auth' },
    { id: 't', kind: 'table', label: 'orders', module: 'db', external: true },
  ],
  edges: [],
};
const m = buildModel(g, null);
const home = m.box.get('mod:go:shop/internal/orders');

describe('parseSpec', () => {
  test.each([
    ['Service.Cancel', { label: 'Service.Cancel', kind: undefined, method: '', at: undefined }],
    ['Service.Cancel @orders', { label: 'Service.Cancel', kind: undefined, method: '', at: 'orders' }],
    ['@orders Service.Cancel', { label: 'Service.Cancel', kind: undefined, method: '', at: 'orders' }],
    ['post /orders/:id/cancel', { label: '/orders/:id/cancel', kind: 'route', method: 'POST', at: undefined }],
    ['table refunds', { label: 'refunds', kind: 'table', method: '', at: undefined }],
    ['table', { label: 'table', kind: undefined, method: '', at: undefined }],
    ['Get Order', { label: 'Get Order', kind: undefined, method: '', at: undefined }],
  ])('%s', (q, want) => expect(parseSpec(q)).toEqual(want));
  test('nothing to add', () => {
    expect(parseSpec('  ')).toBeNull();
    expect(parseSpec('@orders')).toBeNull();
  });
});

describe('plan', () => {
  test('a function goes home', () => {
    expect(plan(m, parseSpec('Service.Cancel')!, home)).toMatchObject({ kind: 'function', box: { id: 'mod:go:shop/internal/orders' } });
  });
  test('@ names another part', () => {
    expect(plan(m, parseSpec('Check @auth')!, home)?.box.id).toBe('mod:go:shop/internal/auth');
    expect(plan(m, parseSpec('Check @nowhere')!, home)).toBeNull();
  });
  test('a route goes where routes are, and gets a method', () => {
    expect(plan(m, parseSpec('POST /orders/:id/cancel')!, home)).toMatchObject({ kind: 'route', method: 'POST', box: { id: 'mod:go:shop/cmd/server' } });
  });
  test('a table goes where tables are', () => {
    expect(plan(m, parseSpec('table refunds')!, home)?.box.id).toBe('db');
  });
  test('boxNamed prefers the last path segment', () => {
    expect(boxNamed(m.boxes, 'server')?.id).toBe('mod:go:shop/cmd/server');
  });
});
