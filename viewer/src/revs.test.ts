import { describe, expect, test } from 'vitest';
import { parseDiff, presets, shortRev, sliceRange, specLabel, type Revs } from './revs';

const diff = `diff --git a/x.go b/x.go
--- a/x.go
+++ b/x.go
@@ -10,5 +10,6 @@ func A
 func Find() {
-	old()
+	new()
+	more()
 	return
 }

@@ -30,3 +31,2 @@
 func B() {
-	gone()
 }
`;

describe('code diff', () => {
  const lines = parseDiff(diff);
  test('numbers both sides', () => {
    expect(lines[0]).toEqual({ t: ' ', text: 'func Find() {', o: 10, n: 10 });
    expect(lines[1]).toMatchObject({ t: '-', o: 11, n: 0 });
    expect(lines[2]).toMatchObject({ t: '+', o: 0, n: 11 });
    expect(lines[3]).toMatchObject({ t: '+', n: 12 });
    expect(lines[4]).toMatchObject({ t: ' ', o: 12, n: 13 });
    expect(lines.at(-2)).toMatchObject({ t: '-', text: '\tgone()', o: 31 });
  });
  test('slices a node range on the new side, keeping removed lines inside it', () => {
    const r = sliceRange(lines, 10, 14, 'new');
    expect(r.map((l) => l.t).join('')).toBe(' -++  ');
    expect(r.at(-1)!.n).toBe(14);
  });
  test('slices a removed node on the old side', () => {
    const r = sliceRange(lines, 30, 32, 'old');
    expect(r.map((l) => l.t).join('')).toBe(' - ');
  });
  test('a range outside every hunk is empty', () => {
    expect(sliceRange(lines, 100, 120, 'new')).toEqual([]);
  });
});

describe('presets', () => {
  const revs: Revs = {
    commits: [],
    branches: ['feature', 'main', 'agent/fix-login'],
    current: 'feature',
    default: 'main',
    head: '',
    dirty: true,
    prs: [{ number: 7, title: 'Refunds', headRefName: 'feature', baseRefName: 'main', author: { login: 'a' }, updatedAt: '' }],
  };
  test('one click each', () => {
    expect(presets(revs).map((p) => [p.label, p.from, p.to])).toEqual([
      ['Uncommitted changes', 'HEAD', 'worktree'],
      ['This branch vs main', 'base:main', 'worktree'],
      ['agent/fix-login vs main', 'base:main', 'agent/fix-login'],
      ['#7 Refunds', 'pr:7', ''],
    ]);
  });
  test('no branch preset on the default branch', () => {
    expect(presets({ ...revs, current: 'main' }).some((p) => p.id === 'branch')).toBe(false);
  });
  test('labels', () => {
    expect(specLabel({ from: 'base:main', to: 'agent/fix-login' }, revs)).toBe('agent/fix-login vs main');
    expect(specLabel({ from: 'a'.repeat(40), to: 'worktree' }, revs)).toBe('aaaaaaa → worktree');
    expect(shortRev('main')).toBe('main');
  });
});
