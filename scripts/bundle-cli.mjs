import { join, resolve } from "node:path";

import { build } from "esbuild";

const repositoryRoot = resolve(import.meta.dirname, "..");

await Promise.all([
  build({
    entryPoints: [join(repositoryRoot, "apps", "cli", "src", "bin.ts")],
    outfile: join(repositoryRoot, "apps", "cli", "dist", "hpi.js"),
    bundle: true,
    define: { HPI_BUNDLED_ARTIFACT: "true" },
    external: ["@earendil-works/pi-coding-agent"],
    format: "esm",
    legalComments: "eof",
    logLevel: "silent",
    platform: "node",
    sourcemap: false,
    target: "node24",
  }),
  build({
    entryPoints: [join(repositoryRoot, "packages", "pi-host", "src", "core-extension.ts")],
    outfile: join(repositoryRoot, "apps", "cli", "dist", "core-extension.js"),
    bundle: true,
    format: "esm",
    legalComments: "eof",
    logLevel: "silent",
    platform: "node",
    sourcemap: false,
    target: "node24",
  }),
]);
