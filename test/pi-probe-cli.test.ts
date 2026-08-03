import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createPiProbeFailureEvidence,
  formatPiProbeEvidence,
  resolvePiProbeOutputPath,
} from "../tools/pi-public-interface-probe.js";
import { piPublicInterfaceProbeFailureReportSchema } from "@hunter-pi/pi-host";

describe("Pi public-interface probe CLI", () => {
  const repositoryRoot = resolve("C:/fixtures/hunter-pi");

  it("accepts only a flat JSON file in an approved evidence root", () => {
    expect(resolvePiProbeOutputPath(repositoryRoot, ".artifacts/pi-probe/windows.json")).toBe(
      resolve(repositoryRoot, ".artifacts/pi-probe/windows.json"),
    );
    expect(
      resolvePiProbeOutputPath(repositoryRoot, "docs/validation/evidence/pi/windows-node24.json"),
    ).toBe(resolve(repositoryRoot, "docs/validation/evidence/pi/windows-node24.json"));
  });

  it("rejects traversal, nested output, and non-JSON output", () => {
    expect(() => resolvePiProbeOutputPath(repositoryRoot, "../private.json")).toThrow(
      /approved evidence root/u,
    );
    expect(() =>
      resolvePiProbeOutputPath(repositoryRoot, ".artifacts/pi-probe/nested/windows.json"),
    ).toThrow(/flat JSON file/u);
    expect(() =>
      resolvePiProbeOutputPath(repositoryRoot, ".artifacts/pi-probe/windows.log"),
    ).toThrow(/flat JSON file/u);
  });

  it("emits JSON in the repository's stable machine-evidence format", async () => {
    await expect(formatPiProbeEvidence({ activeTools: ["hunter_pi_probe_tool"] })).resolves.toBe(
      '{ "activeTools": ["hunter_pi_probe_tool"] }\n',
    );
  });

  it("emits a strict, path-free NOT_PROVEN receipt when the probe cannot complete", () => {
    const receipt = createPiProbeFailureEvidence("2026-08-03T00:00:00.000Z", "RPC");

    expect(piPublicInterfaceProbeFailureReportSchema.parse(receipt)).toEqual(receipt);
    expect(receipt).toMatchObject({
      kind: "hunter-pi/pi-public-interface-probe-failure",
      status: "NOT_PROVEN",
      failure: { classification: "NOT_PROVEN", code: "PROBE_DID_NOT_COMPLETE", stage: "RPC" },
    });
    expect(JSON.stringify(receipt)).not.toMatch(/[A-Z]:\\|\/home\/|token|cookie|api[_-]?key/iu);
  });
});
