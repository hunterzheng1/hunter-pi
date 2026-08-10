import { describe, expect, it } from "vitest";

import {
  PilotPlanCompiler,
  createPilotRuntimeBinding,
  fingerprintPilotEngineRelease,
  pilotRuntimeBindingMatchesPlan,
} from "@hunter-pi/pilot";
import { completePilotPlanInput } from "./support/task12-plan-fixture.js";

const runtimeInput = {
  sourceCommit: "d".repeat(40),
  artifactFingerprint: `sha256:${"8".repeat(64)}`,
  enginePackageName: "@earendil-works/pi-coding-agent",
  engineVersion: "0.83.0",
  providerId: "anthropic",
  modelId: "claude-sonnet-4-5",
  configuredOrigin: "https://api.anthropic.com",
  pristineOrigin: "https://api.anthropic.com",
  credentialSource: "stored",
} as const;

describe("Task 12 installed runtime binding", () => {
  it("derives path-free product, artifact, Engine, endpoint, model, and credential fingerprints", () => {
    const binding = createPilotRuntimeBinding(runtimeInput);
    expect(binding).toMatchObject({
      schemaVersion: "hpi-pilot-runtime-binding.v1",
      artifactFingerprint: runtimeInput.artifactFingerprint,
      engineReleaseFingerprint: fingerprintPilotEngineRelease({
        packageName: runtimeInput.enginePackageName,
        version: runtimeInput.engineVersion,
      }),
    });
    expect(JSON.stringify(binding)).not.toContain(runtimeInput.configuredOrigin);
    expect(JSON.stringify(binding)).not.toContain(runtimeInput.modelId);
    expect(JSON.stringify(binding)).not.toContain(runtimeInput.credentialSource);
  });

  it("matches only an execution plan frozen to every installed runtime identity", () => {
    const binding = createPilotRuntimeBinding(runtimeInput);
    const input = completePilotPlanInput();
    const plan = new PilotPlanCompiler().compile({
      ...input,
      sourceFingerprint: binding.sourceFingerprint,
      artifactFingerprint: binding.artifactFingerprint,
      engineReleaseFingerprint: binding.engineReleaseFingerprint,
      machineProfile: {
        ...input.machineProfile,
        sourceFingerprint: binding.sourceFingerprint,
        hunterReleaseFingerprint: binding.artifactFingerprint,
        engineReleaseFingerprint: binding.engineReleaseFingerprint,
      },
      operatorScope: {
        ...input.operatorScope,
        providerEndpointFingerprint: binding.providerEndpointFingerprint,
        providerModelFingerprint: binding.providerModelFingerprint,
        credentialScopeFingerprint: binding.credentialScopeFingerprint,
      },
    });
    expect(pilotRuntimeBindingMatchesPlan(plan, binding)).toBe(true);
    expect(
      pilotRuntimeBindingMatchesPlan(plan, {
        ...binding,
        artifactFingerprint: `sha256:${"9".repeat(64)}`,
      }),
    ).toBe(false);
    expect(
      pilotRuntimeBindingMatchesPlan(plan, {
        ...binding,
        credentialScopeFingerprint: `sha256:${"a".repeat(64)}`,
      }),
    ).toBe(false);
  });
});
