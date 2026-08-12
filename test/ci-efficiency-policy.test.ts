import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const workflow = await readFile(
  resolve(import.meta.dirname, "..", ".github", "workflows", "ci.yml"),
  "utf8",
);
const scopeScriptSource = await readFile(
  resolve(import.meta.dirname, "..", "scripts", "ci-scope.mjs"),
  "utf8",
);
const manifest = JSON.parse(
  await readFile(resolve(import.meta.dirname, "..", "package.json"), "utf8"),
) as { readonly scripts?: Readonly<Record<string, string>> };
const repositoryRoot = resolve(import.meta.dirname, "..");

function classify(paths: readonly string[]): string {
  const result = spawnSync(
    process.execPath,
    [resolve(repositoryRoot, "scripts", "ci-scope.mjs"), "--paths-json", JSON.stringify(paths)],
    { cwd: repositoryRoot, encoding: "utf8" },
  );

  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

describe("GitHub Actions CI efficiency policy", () => {
  it("runs the containment matrix in parallel behind the full-change scope", () => {
    const task7Section =
      /\x20{2}task7-platform:\r?\n([\s\S]*?)\r?\n\x20{2}task7-evidence-consistency:/u.exec(
        workflow,
      )?.[1];
    const task7EvidenceSection = /\x20{2}task7-evidence-consistency:\r?\n([\s\S]*)$/u.exec(
      workflow,
    )?.[1];

    expect(task7Section).toBeDefined();
    expect(task7EvidenceSection).toBeDefined();
    expect(task7Section).toMatch(/^\x20{4}needs: scope\s*$/mu);
    expect(task7Section).toMatch(/^\x20{4}if: needs\.scope\.outputs\.mode == 'full'\s*$/mu);
    expect(task7Section).toMatch(/^\x20{6}max-parallel: 2\s*$/mu);

    const task7BuildIndex = task7Section?.indexOf("run: npm run build") ?? -1;
    const task7ProbeIndex = task7Section?.indexOf("run: npm run probe:task7:compiled") ?? -1;
    const task7EvidenceBuildIndex = task7EvidenceSection?.indexOf("run: npm run build") ?? -1;
    const task7CompareIndex =
      task7EvidenceSection?.indexOf("npm run compare:task7-evidence:compiled") ?? -1;
    expect(task7BuildIndex).toBeGreaterThanOrEqual(0);
    expect(task7ProbeIndex).toBeGreaterThan(task7BuildIndex);
    expect(task7EvidenceBuildIndex).toBeGreaterThanOrEqual(0);
    expect(task7CompareIndex).toBeGreaterThan(task7EvidenceBuildIndex);
  });

  it("routes documentation-only changes through a stable inexpensive gate", () => {
    expect(classify(["README.md", "docs/user-guide.md"])).toBe("docs");
    expect(classify(["docs/user-guide.md", "packages/domain/src/schemas.ts"])).toBe("full");
    expect(classify(["README.md", "packages/domain/src/deleted-schema.ts"])).toBe("full");
    expect(classify(["packages/domain/src/old.ts", "docs/old.ts"])).toBe("full");
    expect(classify([".github/workflows/ci.yml"])).toBe("full");
    expect(scopeScriptSource).toContain('"--no-renames"');
    expect(scopeScriptSource).toContain('"--diff-filter=ACDMRTUXB"');
    expect(workflow).toMatch(/^\x20{2}docs-quality:\s*$/mu);
    expect(workflow).toMatch(/^\x20{2}tests:\s*$/mu);
    expect(workflow).toMatch(/^\x20{2}windows-portable:\s*$/mu);
    expect(workflow).toMatch(/^\x20{2}windows-package-smoke:\s*$/mu);
    expect(workflow).toMatch(/^\x20{2}windows-clean-install:\s*$/mu);
    expect(workflow).toMatch(/^\x20{2}ci-gate:\s*$/mu);

    const gateSection = /\x20{2}ci-gate:\r?\n([\s\S]*)$/u.exec(workflow)?.[1];
    expect(gateSection).toContain("- windows-package-smoke");
    expect(gateSection).toContain("- windows-clean-install");
    expect(gateSection).toContain("WINDOWS_PACKAGE_RESULT:");
    expect(gateSection).toContain("WINDOWS_CLEAN_INSTALL_RESULT:");
    expect(gateSection).toContain("process.env.WINDOWS_PACKAGE_RESULT");
    expect(gateSection).toContain("process.env.WINDOWS_CLEAN_INSTALL_RESULT");
  });

  it("uses cached locked installs and avoids rebuilding the same artifact repeatedly", () => {
    const installCommands = [...workflow.matchAll(/^\s+run: npm ci[^\r\n]*$/gmu)].map(
      (match) => match[0],
    );

    expect(installCommands.length).toBeGreaterThan(0);
    expect(
      installCommands.every(
        (command) =>
          command.includes("--prefer-offline") &&
          command.includes("--no-audit") &&
          command.includes("--no-fund"),
      ),
    ).toBe(true);

    expect(workflow).not.toContain("timeout-minutes: 55");
    expect(workflow).toContain("timeout-minutes: 15");
    expect(workflow).toContain("run: npm run package-smoke:compiled");
    expect(workflow).toContain("run: npm run pack:preview:compiled");
    expect(workflow).toContain("npm run pack:windows-portable:compiled");
    expect(workflow).toContain("name: Build exact Windows x64 portable update artifact");
    expect(workflow).toMatch(
      /- name: Test packed packages externally\s+if: runner\.os == 'Linux'/u,
    );
    expect(workflow).toMatch(/- name: Test a clean locked install\s+if: runner\.os == 'Linux'/u);
    expect(workflow).toContain("name: Test packed packages externally on Windows");
    expect(workflow).toContain("name: Test a clean locked install on Windows");
    expect(workflow).toContain("run: npm run probe:pi:compiled");
    expect(workflow).toContain("run: npm run probe:task7:compiled");
    expect(workflow).toContain("npm run probe:task9:compiled");
    expect(workflow).toContain("npm run probe:task10:compiled");
    expect(workflow).toContain("npm run compare:task7-evidence:compiled");
    expect(workflow).toContain("npm run compare:task9-evidence:compiled");
    expect(workflow).toContain("npm run compare:task10-evidence:compiled");
    expect(workflow).not.toContain("name: Managed process platform tests");
    expect(workflow).not.toMatch(
      /run: npm run (package-smoke|pack:preview|probe:pi|probe:task7|probe:task9|probe:task10)(?:\s|$)/u,
    );
    expect(workflow).not.toMatch(/npm run compare:task(?:7|9|10)-evidence(?:\s|$)/u);
  });

  it("cannot hide missing workspace references behind stale build outputs", async () => {
    const workspaceDirectories = (
      await Promise.all(
        ["apps", "packages"].map(async (workspaceRoot) =>
          (await readdir(resolve(repositoryRoot, workspaceRoot), { withFileTypes: true }))
            .filter((entry) => entry.isDirectory())
            .map((entry) => resolve(repositoryRoot, workspaceRoot, entry.name)),
        ),
      )
    ).flat();
    const workspaces = await Promise.all(
      workspaceDirectories.map(async (directory) => ({
        directory,
        manifest: JSON.parse(await readFile(resolve(directory, "package.json"), "utf8")) as {
          readonly name: string;
          readonly dependencies?: Readonly<Record<string, string>>;
          readonly devDependencies?: Readonly<Record<string, string>>;
          readonly peerDependencies?: Readonly<Record<string, string>>;
        },
        tsconfig: JSON.parse(await readFile(resolve(directory, "tsconfig.json"), "utf8")) as {
          readonly references?: readonly { readonly path: string }[];
        },
      })),
    );
    const directoryByName = new Map(
      workspaces.map((workspace) => [workspace.manifest.name, workspace.directory] as const),
    );
    const missingReferences = workspaces.flatMap((workspace) => {
      const internalDependencies = [
        ...Object.keys(workspace.manifest.dependencies ?? {}),
        ...Object.keys(workspace.manifest.devDependencies ?? {}),
        ...Object.keys(workspace.manifest.peerDependencies ?? {}),
      ].filter((dependency) => directoryByName.has(dependency));
      const referencedDirectories = new Set(
        (workspace.tsconfig.references ?? []).map((reference) =>
          resolve(workspace.directory, reference.path),
        ),
      );
      return internalDependencies
        .filter((dependency) => {
          const dependencyDirectory = directoryByName.get(dependency);
          return (
            dependencyDirectory !== undefined && !referencedDirectories.has(dependencyDirectory)
          );
        })
        .map((dependency) => `${workspace.manifest.name} -> ${dependency}`);
    });

    expect(missingReferences).toEqual([]);
    expect(manifest.scripts?.["clean:build"]).toBe("tsc -b tsconfig.build.json --clean");
    expect(manifest.scripts?.["verify"]).toMatch(/^npm run clean:build &&/u);
  });

  it("reuses quality and Pi aggregation jobs for Task 9 and Task 10 platform Evidence", () => {
    const qualitySection =
      /\x20{2}quality:\r?\n([\s\S]*?)\r?\n\x20{2}pi-evidence-consistency:/u.exec(workflow)?.[1];
    const aggregateSection =
      /\x20{2}pi-evidence-consistency:\r?\n([\s\S]*?)\r?\n\x20{2}task7-platform:/u.exec(
        workflow,
      )?.[1];

    expect(qualitySection).toContain("Run Task 9 platform finality probe");
    expect(qualitySection).toContain("Upload Task 9 platform receipt");
    expect(aggregateSection).toContain("Download Windows Task 9 receipt");
    expect(aggregateSection).toContain("Download Ubuntu Task 9 receipt");
    expect(aggregateSection).toContain("Compare exact Task 9 platform identities");
    expect(aggregateSection).toContain("Upload Task 9 consistency receipt");
    expect(qualitySection).toContain("Run Task 10 package-safety probe");
    expect(qualitySection).toContain("Upload Task 10 platform receipt");
    expect(aggregateSection).toContain("Download Windows Task 10 receipt");
    expect(aggregateSection).toContain("Download Ubuntu Task 10 receipt");
    expect(aggregateSection).toContain("Compare exact Task 10 package-safety identities");
    expect(aggregateSection).toContain("Upload Task 10 consistency receipt");
    expect(workflow).not.toMatch(/^\x20{2}task9-platform:/mu);
    expect(workflow).not.toMatch(/^\x20{2}task10-platform:/mu);
  });

  it("runs the Task 9 daily-use matrix once inside its Evidence probe", () => {
    const qualityTestScript = manifest.scripts?.["test:ci"];
    expect(qualityTestScript).toBeDefined();
    expect(workflow).toContain("run: npm run test:ci");
    for (const path of [
      "test/atomic-write.test.ts",
      "test/file-lease-manager.test.ts",
      "test/task9-archive.test.ts",
      "test/task9-recovery.test.ts",
      "test/task9-checkpoint.test.ts",
      "test/task9-cancellation.test.ts",
      "test/task9-attempt-finality-store.test.ts",
      "test/task9-attempt-finality-adapter.test.ts",
    ]) {
      expect(qualityTestScript).toContain(`--exclude ${path}`);
    }
    expect(qualityTestScript).toContain("--exclude test/managed-process-platform.test.ts");
    expect(qualityTestScript).not.toContain("task9-platform-evidence.test.ts");
    for (const path of [
      "test/task10-plugin-manager.test.ts",
      "test/task10-pi-package-adapter.test.ts",
      "test/task10-plugin-activation.test.ts",
    ]) {
      expect(qualityTestScript).toContain(`--exclude ${path}`);
    }
    expect(qualityTestScript).not.toContain("task10-platform-evidence.test.ts");

    const qualitySection =
      /\x20{2}quality:\r?\n([\s\S]*?)\r?\n\x20{2}pi-evidence-consistency:/u.exec(workflow)?.[1];
    const buildIndex = qualitySection?.indexOf("run: npm run build") ?? -1;
    const task9ProbeIndex = qualitySection?.indexOf("npm run probe:task9:compiled") ?? -1;
    const task10ProbeIndex = qualitySection?.indexOf("npm run probe:task10:compiled") ?? -1;
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(task9ProbeIndex).toBeGreaterThan(buildIndex);
    expect(task10ProbeIndex).toBeGreaterThan(buildIndex);
  });

  it("preserves and retries only structured Task 7 test-execution failures once", () => {
    const task7Section =
      /\x20{2}task7-platform:\r?\n([\s\S]*?)\r?\n\x20{2}task7-evidence-consistency:/u.exec(
        workflow,
      )?.[1];

    expect(task7Section).toMatch(/id: task7_probe/u);
    expect(task7Section).toMatch(/continue-on-error: true/u);
    expect(task7Section).toMatch(/id: task7_retry_gate/u);
    expect(task7Section).toMatch(/if: steps\.task7_probe\.outcome == 'failure'/u);
    expect(task7Section).toMatch(/receipt\.stage !== 'TEST_EXECUTION'/u);
    expect(task7Section).toMatch(/attempt-1/u);
    expect(task7Section).toMatch(/id: task7_retry/u);
    expect(task7Section).toMatch(/if: steps\.task7_retry_gate\.outcome == 'success'/u);
    expect(task7Section).toMatch(/Require a passing Task 7 receipt/u);
    expect(task7Section).toMatch(/status !== 'PASS'/u);
  });
});
