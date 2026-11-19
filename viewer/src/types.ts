// JSON shapes shared with the server.
// Go types live in internal/graph and internal/project.

export interface GModule {
  id: string;
  label: string;
  lang?: string;
  path?: string;
  doc?: string;
  external?: boolean;
  program?: string; // the server, web app or CLI it's part of (build.Programs)
}

export interface GNode {
  id: string;
  kind: string;
  label: string;
  module: string;
  file?: string;
  line?: number;
  endLine?: number;
  doc?: string;
  entry?: boolean;
  external?: boolean;
  fields?: Record<string, unknown>;
  proposed?: boolean; // only in the graph the walks run over (model.walkGraph)
}

export interface GEdge {
  from: string;
  to: string;
  type: string;
  detail?: string;
  file?: string;
  line?: number;
  proposed?: boolean;
}

export interface Graph {
  version: number;
  rev?: string;
  modules: GModule[] | null;
  nodes: GNode[] | null;
  edges: GEdge[] | null;
}



export type Loose = Record<string, unknown>;

export interface Proposal {
  slug: string;
  name: string;
  status: string; // open | archived
  base?: string;
  pr?: string;
  updated?: string;
  modules?: Loose[] | null;
  nodes?: Loose[] | null;
  edges?: Loose[] | null;
  body: string;
}

export interface Project {
  config: unknown;
  proposals: Proposal[] | null;
}

export interface State {
  graph: Graph;
  project: Project;
  versions: Record<string, string>;
}

export interface Source {
  file: string;
  from: number;
  lines: string[];
}
