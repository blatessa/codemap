// A synthetic map big enough to fold into folder groups: a handful of top-level
// packages, plus two folders of many similar packages (internal/plugins/*,
// internal/reader/*). api.Serve calls reader.r0.Parse, which calls plugins.p3.Run.
export function bigGraph() {
  const modules: object[] = [],
    nodes: object[] = [],
    edges: object[] = [];
  const mod = (path: string, fns: string[]) => {
    const id = `mod:go:big/${path}`;
    modules.push({ id, label: path, lang: 'go', path });
    for (const f of fns) nodes.push({ id: `go:big/${path}.${f}`, kind: 'function', label: f, module: id, file: `${path}/x.go`, line: 1 });
  };
  for (const p of ['cmd/server', 'internal/api', 'internal/store', 'internal/auth', 'internal/jobs', 'internal/config', 'internal/mail', 'internal/cache', 'internal/web']) mod(p, ['Serve', 'helper']);
  for (let i = 0; i < 20; i++) mod(`internal/plugins/p${i}`, ['Run']);
  for (let i = 0; i < 20; i++) mod(`internal/reader/r${i}`, ['Parse']);
  nodes.push({ id: 'route:GET /feed', kind: 'route', label: '/feed', module: 'mod:go:big/internal/api', entry: true, fields: { method: 'GET' } });
  const e = (a: string, b: string) => edges.push({ from: `go:big/${a}`, to: `go:big/${b}`, type: 'calls' });
  edges.push({ from: 'route:GET /feed', to: 'go:big/internal/api.Serve', type: 'calls' });
  e('cmd/server.Serve', 'internal/api.Serve');
  e('internal/api.Serve', 'internal/store.Serve');
  e('internal/api.Serve', 'internal/auth.Serve');
  e('internal/jobs.Serve', 'internal/store.Serve');
  e('internal/api.Serve', 'internal/reader/r0.Parse');
  e('internal/reader/r0.Parse', 'internal/plugins/p3.Run');
  for (let i = 0; i < 20; i++) e('internal/jobs.Serve', `internal/plugins/p${i}.Run`);
  for (let i = 1; i < 20; i++) e('internal/jobs.helper', `internal/reader/r${i}.Parse`);
  return { version: 1, rev: 'worktree', modules, nodes, edges };
}
