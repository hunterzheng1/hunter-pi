import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { decodePiPackageInstallWorkerPayload } from "./pi-package-install-contract.js";
import { createPiPackageNpmCommand } from "./pi-package-resolver.js";

declare const HPI_BUNDLED_ARTIFACT: boolean | undefined;

const PI_PACKAGE_SPECIFIER = ["@earendil-works", "pi-coding-agent"].join("/");

interface PackageManagerPort {
  install(source: string): Promise<void>;
}

interface PiPackageModule {
  readonly DefaultPackageManager: new (options: {
    readonly cwd: string;
    readonly agentDir: string;
    readonly settingsManager: unknown;
  }) => PackageManagerPort;
  readonly SettingsManager: {
    inMemory(
      settings?: Readonly<Record<string, unknown>>,
      options?: Readonly<Record<string, unknown>>,
    ): unknown;
  };
}

export async function runPiPackageInstallWorkerPayload(
  encoded: string | undefined,
): Promise<0 | 1> {
  try {
    if (encoded === undefined) throw new Error("missing bounded Pi Package install payload");
    const payload = decodePiPackageInstallWorkerPayload(encoded);
    const stagingRoot = resolve(payload.stagingRoot);
    const pi = (await import(PI_PACKAGE_SPECIFIER)) as unknown as PiPackageModule;
    const settingsManager = pi.SettingsManager.inMemory(
      { npmCommand: createPiPackageNpmCommand(payload.registry) },
      { projectTrusted: true },
    );
    const manager = new pi.DefaultPackageManager({
      cwd: stagingRoot,
      agentDir: stagingRoot,
      settingsManager,
    });
    await manager.install(payload.source);
    return 0;
  } catch {
    return 1;
  }
}

const entryPoint = process.argv[1];
const bundledArtifact = typeof HPI_BUNDLED_ARTIFACT !== "undefined" && HPI_BUNDLED_ARTIFACT;
if (
  !bundledArtifact &&
  entryPoint !== undefined &&
  import.meta.url === pathToFileURL(resolve(entryPoint)).href
) {
  void runPiPackageInstallWorkerPayload(process.argv[2]).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
