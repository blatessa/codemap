// JSON shapes shared with the server (PLAN.md §3, §4, §6, §8).
// Go types live in internal/graph and internal/project.

export interface GModule {
  id: string;
  label: string;
  lang?: string;
  path?: string;
  doc?: string;
  external?: boolean;
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
}

export interface GEdge {
  from: string;
  to: string;
  type: string;
  detail?: string;
  file?: string;
  line?: number;
  declared?: boolean;
}

export interface Graph {
  version: number;
  rev?: string;
  modules: GModule[] | null;
  nodes: GNode[] | null;
  edges: GEdge[] | null;
}

export interface Area {
  name: string;
  modules: string[] | null;
}

export interface Block {
  id: string;
  name: string;
  from: string;
  match?: string[] | null;
  files?: string[] | null;
}

export type Layout = Record<string, [number, number]>;

export interface View {
  name: string;
  selection?: string[] | null;
  focus?: boolean;
  collapsed?: string[] | null;
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
  areas: Area[] | null;
  blocks: Block[] | null;
  layout: Layout | null;
  views: View[] | null;
  external: unknown;
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
