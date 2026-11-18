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

// A map with more modules than the layout hands ELK in one pass (150), all in
// areas: six areas of 30 packages, each a chain from one shared entry point.
export function areasGraph() {
  const names = ['api', 'store', 'auth', 'jobs', 'search', 'web'];
  const modules: object[] = [],
    nodes: object[] = [],
    edges: object[] = [];
  const areas = names.map((a) => ({ name: `Area ${a}`, modules: [] as string[] }));
  names.forEach((a, ai) => {
    for (let i = 0; i < 30; i++) {
      const path = `${a}/p${i}`,
        id = `mod:go:many/${path}`;
      modules.push({ id, label: path, lang: 'go', path });
      nodes.push({ id: `go:many/${path}.Run`, kind: 'function', label: 'Run', module: id, file: `${path}/x.go`, line: 1 });
      areas[ai].modules.push(id);
      if (i) edges.push({ from: `go:many/${a}/p${i - 1}.Run`, to: `go:many/${path}.Run`, type: 'calls' });
    }
    // every area starts at the same entry point, so their modules are equally
    // far from it and a layout that ignores areas mixes them up
    edges.push({ from: 'route:GET /x', to: `go:many/${a}/p0.Run`, type: 'calls' });
  });
  nodes.push({ id: 'route:GET /x', kind: 'route', label: '/x', module: areas[0].modules[0], entry: true, fields: { method: 'GET' } });
  return { graph: { version: 1, rev: 'worktree', modules, nodes, edges }, areas };
}
