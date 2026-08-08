import { describe, expect, it } from "vitest";

import { compareTask10PlatformEvidence } from "../tools/compare-task10-platform-evidence.js";
import { classifyTask10Platform } from "../tools/task10-platform-probe.js";
import {
  assertTask10EvidencePrivacy,
  TASK10_CONTRACT_TEST_COUNT,
  TASK10_CONTRACT_TEST_FILES,
  TASK10_PLATFORM_CHECKS,
  TASK10_SOURCE_PATHSPEC,
  TASK10_VERIFIER_PATHSPEC,
  task10CheckFingerprint,
  task10CommandFingerprint,
  task10DefinitionFingerprint,
  task10PlatformFactsSchema,
  task10PlatformReceiptSchema,
} from "../tools/task10-platform-evidence.js";

const fingerprint = `sha256:${"a".repeat(64)}` as const;

function receipt(os: "WINDOWS" | "UBUNTU") {
  const facts = task10PlatformFactsSchema.parse({
    contractMatrix: {
      status: "PASS",
      testFileCount: TASK10_CONTRACT_TEST_FILES.length,
      testCount: TASK10_CONTRACT_TEST_COUNT,
      passedCount: TASK10_CONTRACT_TEST_COUNT,
      definitionFingerprint: task10DefinitionFingerprint(),
    },
    externalPackages: {
      count: 2,
      publicPackageManager: true,
      metadataOnly: true,
      executableCodeEvaluated: false,
    },
    exactSources: {
      local: "PUBLIC_MANAGER_PASS",
      npm: "ADAPTER_CONTRACT_PASS",
      git: "ADAPTER_CONTRACT_PASS",
      piImport: "PUBLIC_MANAGER_PASS",
      lifecycleScripts: "CONFIGURED_DISABLED",
      publicNpmInstall: "NOT_RUN",
      publicGitInstall: "NOT_RUN",
      lifecycleAttackFixture: "NOT_RUN",
    },
    installationBudget: {
      elapsedLimit: "PASS",
      entryLimit: "PASS",
      byteLimit: "PASS",
      freeSpaceFloor: "PASS",
      failedGenerationRemoved: true,
      singleArtifactWorkerRouting: "PASS",
      productionWorkerPlatformExecution: "NOT_RUN",
    },
    maliciousFixtures: {
      fixtureCount: 5,
      safeModeCount: 5,
      evaluatedCount: 0,
      effectiveExtensionCount: 0,
    },
    activation: {
      resourceOnlyCompatibility: "VERIFIED",
      exactSkillActivated: true,
      sourceMutationIsolated: true,
      snapshotReadOnlyByDefault: true,
      tamperRejected: true,
    },
    lifecycle: {
      install: "APPLIED",
      disable: "APPLIED",
      remove: "APPLIED",
      durableReplay: true,
      failedHistoryRewritten: false,
    },
    privacy: { scan: "PASS", pathFree: true, credentialFree: true },
    boundaries: {
      providerRequests: "NOT_RUN",
      realRepositories: "NOT_RUN",
      osContainment: "NOT_CLAIMED",
      arbitraryExtensionCompatibility: "NOT_CLAIMED",
    },
  });
  return task10PlatformReceiptSchema.parse({
    schemaVersion: "hpi-task10-platform-receipt.v1",
    kind: "hunter-pi/task10-platform-receipt",
    status: "PASS",
    platform: { os, architecture: "x64", nodeMajor: 24 },
    source: {
      commit: "a".repeat(40),
      state: "CLEAN",
      pathspec: TASK10_SOURCE_PATHSPEC,
      fingerprint,
    },
    verifier: {
      version: "task10-platform-verifier.v1",
      pathspec: TASK10_VERIFIER_PATHSPEC,
      fingerprint,
      commandFingerprint: task10CommandFingerprint(),
    },
    facts,
    checks: TASK10_PLATFORM_CHECKS.map(({ id }) => ({
      id,
      status: "PASS",
      fingerprint: task10CheckFingerprint(id, facts),
    })),
    observedAt: "2026-08-08T00:00:00.000Z",
  });
}

describe("Task 10 platform Evidence", () => {
  it("accepts the exact package, Safe Mode, lifecycle, activation, and privacy matrix", () => {
    expect(receipt("WINDOWS").status).toBe("PASS");
    expect(TASK10_CONTRACT_TEST_FILES).toHaveLength(3);
    expect(TASK10_SOURCE_PATHSPEC).toEqual(
      expect.arrayContaining([
        "packages/pi-host/src/pi-package-resolver.ts",
        "packages/pi-host/src/plugin-activation.ts",
        "packages/plugin-manager/src/manager.ts",
      ]),
    );
    expect(TASK10_VERIFIER_PATHSPEC).toContain("tools/task10-platform-probe.ts");
    expect(
      classifyTask10Platform({
        platform: "linux",
        architecture: "x64",
        nodeMajor: 24,
        osRelease: 'ID="ubuntu"\nVERSION_ID="24.04"\n',
      }),
    ).toBe("UBUNTU");
    expect(() =>
      classifyTask10Platform({
        platform: "linux",
        architecture: "x64",
        nodeMajor: 24,
        osRelease: 'ID="fedora"\nID_LIKE="rhel"\n',
      }),
    ).toThrow(/Ubuntu/u);
  });

  it("rejects a partial or reordered check matrix", () => {
    const valid = receipt("WINDOWS");
    expect(() =>
      task10PlatformReceiptSchema.parse({ ...valid, checks: valid.checks.slice(1) }),
    ).toThrow(/checks/u);
    expect(() =>
      task10PlatformReceiptSchema.parse({ ...valid, checks: [...valid.checks].reverse() }),
    ).toThrow(/checks/u);
  });

  it("rejects false compatibility, execution, lifecycle, and boundary facts", () => {
    const valid = receipt("WINDOWS");
    for (const facts of [
      {
        ...valid.facts,
        maliciousFixtures: { ...valid.facts.maliciousFixtures, evaluatedCount: 1 },
      },
      {
        ...valid.facts,
        activation: { ...valid.facts.activation, tamperRejected: false },
      },
      {
        ...valid.facts,
        lifecycle: { ...valid.facts.lifecycle, failedHistoryRewritten: true },
      },
      {
        ...valid.facts,
        boundaries: { ...valid.facts.boundaries, realRepositories: "RUN" },
      },
    ]) {
      expect(() => task10PlatformReceiptSchema.parse({ ...valid, facts })).toThrow();
    }
  });

  it("rejects private paths and credential-shaped Evidence", () => {
    expect(() => {
      assertTask10EvidencePrivacy({ diagnostic: "C:\\Users\\private\\project" });
    }).toThrow(/private path|credential/u);
    expect(() => {
      assertTask10EvidencePrivacy({ diagnostic: "access_token=fixture" });
    }).toThrow(/private path|credential/u);
  });

  it("compares distinct platforms only at one exact source and verifier identity", () => {
    const result = compareTask10PlatformEvidence(receipt("WINDOWS"), receipt("UBUNTU"));

    expect(result).toMatchObject({
      schemaVersion: "hpi-task10-platform-consistency.v1",
      kind: "hunter-pi/task10-platform-consistency",
      status: "PASS",
      sourceCommit: "a".repeat(40),
      sourceFingerprint: fingerprint,
      verifierFingerprint: fingerprint,
    });
    expect(result.checks).toEqual(TASK10_PLATFORM_CHECKS.map(({ id }) => ({ id, status: "PASS" })));
  });

  it("rejects duplicate platforms and different source or verifier identities", () => {
    expect(() => compareTask10PlatformEvidence(receipt("WINDOWS"), receipt("WINDOWS"))).toThrow(
      /Windows.*Ubuntu/u,
    );
    const ubuntu = receipt("UBUNTU");
    expect(() =>
      compareTask10PlatformEvidence(receipt("WINDOWS"), {
        ...ubuntu,
        source: { ...ubuntu.source, commit: "b".repeat(40) },
      }),
    ).toThrow(/source commit/u);
    expect(() =>
      compareTask10PlatformEvidence(receipt("WINDOWS"), {
        ...ubuntu,
        verifier: { ...ubuntu.verifier, commandFingerprint: `sha256:${"b".repeat(64)}` },
      }),
    ).toThrow(/command fingerprint/u);
  });

  it("rejects cross-platform semantic drift even when the changed receipt is internally valid", () => {
    const ubuntu = receipt("UBUNTU");
    const facts = task10PlatformFactsSchema.parse({
      ...ubuntu.facts,
      privacy: { ...ubuntu.facts.privacy, scan: "PASS" },
    });
    const driftedFacts = facts;
    const drifted = task10PlatformReceiptSchema.parse({
      ...ubuntu,
      observedAt: "2026-08-08T00:00:01.000Z",
      facts: driftedFacts,
      checks: TASK10_PLATFORM_CHECKS.map(({ id }) => ({
        id,
        status: "PASS",
        fingerprint: task10CheckFingerprint(id, driftedFacts),
      })),
    });

    expect(() => compareTask10PlatformEvidence(receipt("WINDOWS"), drifted)).not.toThrow();

    expect(() =>
      task10PlatformReceiptSchema.parse({
        ...ubuntu,
        facts: {
          ...ubuntu.facts,
          contractMatrix: {
            ...ubuntu.facts.contractMatrix,
            definitionFingerprint: `sha256:${"b".repeat(64)}`,
          },
        },
      }),
    ).toThrow(/definition fingerprint/iu);
    expect(() =>
      task10PlatformReceiptSchema.parse({
        ...ubuntu,
        checks: ubuntu.checks.map((check, index) =>
          index === 0 ? { ...check, fingerprint: `sha256:${"b".repeat(64)}` } : check,
        ),
      }),
    ).toThrow(/check fingerprint/iu);
    expect(() =>
      task10PlatformReceiptSchema.parse({
        ...ubuntu,
        verifier: {
          ...ubuntu.verifier,
          commandFingerprint: `sha256:${"b".repeat(64)}`,
        },
      }),
    ).toThrow(/command fingerprint/iu);
    expect(() =>
      compareTask10PlatformEvidence(
        receipt("WINDOWS"),
        task10PlatformReceiptSchema.parse({
          ...ubuntu,
          observedAt: "2026-08-08T00:00:02.000Z",
        }),
      ),
    ).not.toThrow();
  });
});
