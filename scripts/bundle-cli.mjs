import { join, resolve } from "node:path";

import { build } from "esbuild";

const repositoryRoot = resolve(import.meta.dirname, "..");

const [cliBuild] = await Promise.all([
  build({
    alias: {
      "@hunter-pi/managed-change/internal-pilot-execution": join(
        repositoryRoot,
        "packages",
        "managed-change",
        "dist",
        "pilot-execution-runtime.js",
      ),
    },
    entryPoints: [join(repositoryRoot, "apps", "cli", "src", "bin.ts")],
    outfile: join(repositoryRoot, "apps", "cli", "dist", "hpi.js"),
    bundle: true,
    define: { HPI_BUNDLED_ARTIFACT: "true" },
    external: ["@earendil-works/pi-coding-agent"],
    format: "esm",
    legalComments: "eof",
    logLevel: "silent",
    metafile: true,
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

const pilotRuntimeInputs = Object.keys(cliBuild.metafile.inputs).filter((input) =>
  /packages\/managed-change\/(?:src|dist)\/pilot-execution-runtime\.(?:ts|js)$/u.test(
    input.replaceAll("\\", "/"),
  ),
);
if (pilotRuntimeInputs.length !== 1) {
  throw new Error(
    `The bundled CLI must contain exactly one Managed pilot runtime capability module; found ${String(pilotRuntimeInputs.length)}.`,
  );
}
