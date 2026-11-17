// Writes a synthetic graph.json for performance checks:
//   node scripts/synth.mjs out.json [modules=300] [functionsPerModule=10]
// Run the dev server on it with CODEMAP_MOCK_GRAPH=out.json CODEMAP_MOCK_ROOT=<empty dir>.
import { writeFileSync } from 'node:fs';

const [out, M = '300', F = '10'] = process.argv.slice(2);
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const modules = [],
  nodes = [],
  edges = [];
const nm = +M,
  nf = +F;
for (let i = 0; i < nm; i++) {
  const id = `mod:go:big/pkg${i}`;
  modules.push({ id, label: `internal/pkg${i}`, lang: 'go', path: `internal/pkg${i}`, doc: `Package pkg${i} does thing ${i}.` });
  for (let j = 0; j < nf; j++)
    nodes.push({ id: `go:big/pkg${i}.F${j}`, kind: 'function', label: `Type${j % 3}.Func${j}`, module: id, file: `internal/pkg${i}/f.go`, line: 10 + j * 10, endLine: 18 + j * 10 });
}
for (let i = 0; i < 20; i++) nodes.push({ id: `route:GET /r${i}`, kind: 'route', label: `/r${i}`, module: 'mod:go:big/pkg0', entry: true, fields: { method: 'GET' } });
modules.push({ id: 'mod:sql:database', label: 'database', external: true });
for (let i = 0; i < 30; i++) nodes.push({ id: `table:t${i}`, kind: 'table', label: `t${i}`, module: 'mod:sql:database', external: true, fields: { columns: [['id', 'uuid', 'pk']] } });
for (let i = 0; i < 20; i++) edges.push({ from: `route:GET /r${i}`, to: `go:big/pkg${1 + i}.F0`, type: 'calls' });
// packages sit in five tiers (handlers -> services -> stores -> ...); calls go
// mostly to the next tiers, some stay in the package, a few go back up
const tiers = 5,
  per = Math.ceil(nm / tiers);
const pick = (t) => Math.min(nm - 1, t * per + Math.floor(rnd() * per));
for (let i = 0; i < nm; i++)
  for (let j = 0; j < nf; j++) {
    const from = `go:big/pkg${i}.F${j}`;
    const k = 1 + Math.floor(rnd() * 2.5);
    const t = Math.floor(i / per);
    for (let c = 0; c < k; c++) {
      const r = rnd();
      const ti = r < 0.35 ? i : r < 0.97 ? pick(Math.min(tiers - 1, t + 1 + Math.floor(rnd() * 2))) : pick(Math.floor(rnd() * tiers));
      const tj = Math.floor(rnd() * nf);
      if (ti === i && tj === j) continue;
      edges.push({ from, to: `go:big/pkg${ti}.F${tj}`, type: 'calls' });
    }
    if (rnd() < 0.05) edges.push({ from, to: `table:t${Math.floor(rnd() * 30)}`, type: rnd() < 0.5 ? 'reads' : 'writes', detail: 'SELECT 1' });
  }
const seen = new Set();
const uniq = edges.filter((e) => {
  const k = e.from + '\0' + e.to + '\0' + e.type;
  return !seen.has(k) && seen.add(k);
});
writeFileSync(out, JSON.stringify({ version: 1, rev: 'worktree', modules, nodes, edges: uniq }));
console.log(`${modules.length} modules, ${nodes.length} nodes, ${uniq.length} edges -> ${out}`);
