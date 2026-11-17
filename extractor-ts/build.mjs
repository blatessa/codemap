// Bundles the extractor (with the TypeScript compiler) into one gzipped JS file
// that internal/extract/tsext embeds. Run `npm ci && npm run build` here, or
// `go generate ./internal/extract/tsext` from the repo root.
import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const out = await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  minify: true,
  legalComments: "none",
  write: false,
});
const js = out.outputFiles[0].contents;
// mtime 0 keeps the output byte-identical across rebuilds.
writeFileSync(new URL("../internal/extract/tsext/extractor.js.gz", import.meta.url), gzipSync(js, { level: 9 }));
console.log(`extractor.js: ${(js.length / 1e6).toFixed(1)} MB, gzipped into internal/extract/tsext/extractor.js.gz`);
