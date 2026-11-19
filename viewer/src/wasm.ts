// The graph walks the viewer shares with the CLI: internal/wasm, compiled to
// WebAssembly by scripts/wasm.mjs. startWasm must finish before a model asks
// for a walk.
import './wasm/wasm_exec.js';
import wasmUrl from './wasm/codemap.wasm?url';
import type { Graph } from './types';

export interface Effect {
  to: string;
  type: string;
}

// TraceRow is one row of internal/wasm's Trace; via is an index into the
// graph's edges.
export interface TraceRow {
  id: string;
  via: number;
  parent: string;
  depth: number;
  seen?: boolean;
  more?: boolean;
  targets?: string[];
  support: number;
  reaches: Effect[];
}

export interface TestReach {
  test: string;
  direct: boolean;
  via?: string;
}

interface Api {
  load(graph: string): number;
  free(h: number): void;
  trace(h: number, id: string): string;
  up(h: number, id: string): string;
  entries(h: number, id: string): string;
  effects(h: number, id: string): string;
  tests(h: number, ids: string): string;
}

declare global {
  // set by wasm_exec.js and by the Go program
  var Go: new () => { importObject: WebAssembly.Imports; run(i: WebAssembly.Instance): Promise<void> };
  var codemap: Api | undefined;
}

let ready: Promise<void> | null = null;

// startWasm loads the module: from the bundled asset, or from bytes (tests).
export function startWasm(bytes?: BufferSource): Promise<void> {
  ready ??= (async () => {
    const go = new globalThis.Go();
    const buf = bytes ?? (await (await fetch(wasmUrl)).arrayBuffer());
    const { instance } = await WebAssembly.instantiate(buf, go.importObject);
    void go.run(instance);
    if (!globalThis.codemap) throw new Error('codemap: the WebAssembly module did not start');
  })();
  return ready;
}

const api = (): Api => {
  if (!globalThis.codemap) throw new Error('codemap: walks used before startWasm finished');
  return globalThis.codemap;
};

const freed = new FinalizationRegistry<number>((h) => globalThis.codemap?.free(h));

// Walker answers questions about one graph. The graph is loaded on first use
// and each answer is kept.
export class Walker {
  private h = 0;
  private memo = new Map<string, unknown>();
  constructor(private graph: Graph) {}

  // warm loads the graph into the module ahead of the first question, so the
  // first click on a big graph doesn't pay for it.
  warm() {
    if (!this.h) {
      this.h = api().load(JSON.stringify(this.graph));
      freed.register(this, this.h);
    }
  }

  private ask<T>(key: string, f: (h: number) => string): T {
    if (this.memo.has(key)) return this.memo.get(key) as T;
    if (!this.h) {
      this.h = api().load(JSON.stringify(this.graph));
      freed.register(this, this.h);
    }
    const v = JSON.parse(f(this.h)) as T;
    this.memo.set(key, v);
    return v;
  }

  trace(id: string) {
    return this.ask<{ rows: TraceRow[]; support: number; reaches: Effect[] }>('t' + id, (h) => api().trace(h, id));
  }
  up(id: string) {
    return this.ask<{ nodes: string[]; edges: number[] }>('u' + id, (h) => api().up(h, id));
  }
  entries(id: string) {
    return this.ask<string[]>('e' + id, (h) => api().entries(h, id));
  }
  effects(id: string) {
    return this.ask<Effect[]>('f' + id, (h) => api().effects(h, id));
  }
  tests(ids: string[]) {
    const s = JSON.stringify([...ids].sort());
    return this.ask<TestReach[]>('x' + s, (h) => api().tests(h, s));
  }
}
