// CLI: node extractor.js --root <repo> [--config <json>]
// Writes the partial graph as JSON to stdout and warnings to stderr.

import { extract, type Config } from "./extract.ts";

function main(argv: string[]): number {
  let root = ".";
  let cfg: Config = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") root = argv[++i];
    else if (argv[i] === "--config") cfg = JSON.parse(argv[++i]);
    else {
      process.stderr.write(`usage: extractor --root <dir> [--config <json>]\n`);
      return 2;
    }
  }
  const g = extract(root, cfg, (w) => process.stderr.write("warning: " + w + "\n"));
  process.stdout.write(JSON.stringify(g));
  return 0;
}

process.exitCode = main(process.argv.slice(2));
