import { describe, expect, it } from 'vitest';
import { match, runs } from './search';

const f = (text: string, weight = 0, fuzzy = true) => ({ text, weight, fuzzy });

describe('match', () => {
  it('ranks exact, prefix, word start, inside', () => {
    const s = (q: string, t: string) => match(q, [f(t)])!.score;
    expect(s('place', 'place')).toBeLessThan(s('place', 'placeOrder'));
    expect(s('place', 'placeOrder')).toBeLessThan(s('order', 'placeOrder'));
    expect(s('order', 'placeOrder')).toBeLessThan(s('lace', 'placeOrder'));
  });
  it('needs every word, in any field, in any order', () => {
    const fields = [f('orders.Service.Place'), f('internal/orders/service.go', 2, false)];
    expect(match('place service', fields)).not.toBeNull();
    expect(match('place payments', fields)).toBeNull();
    expect(match('service.go', fields)).not.toBeNull();
  });
  it('matches scattered characters at word starts', () => {
    const m = match('osp', [f('orders.Service.Place')])!;
    expect(m.marks).toEqual([0, 7, 15]);
    expect(match('xyz', [f('orders.Service.Place')])).toBeNull();
  });
  it('does not fuzzy-match prose', () => {
    expect(match('osp', [f('orders service place', 3, false)])).toBeNull();
  });
});

describe('runs', () => {
  it('flags matched characters', () => {
    expect(runs('place', [0, 1])).toEqual([{ t: 'pl', hit: true }, { t: 'ace', hit: false }]);
  });
});
