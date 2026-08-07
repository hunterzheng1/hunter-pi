import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  collectRepositoryDoctor,
  repositoryDoctorReportSchema,
  type DoctorDependencies,
} from "../tools/doctor.ts";

const healthyDependencies = (overrides: Partial<DoctorDependencies> = {}): DoctorDependencies => ({
  fileExists: () => true,
  linuxDistribution: undefined,
  nodeVersion: "v24.14.0",
  platform: "win32",
  runCommand: (command) => ({
    ok: true,
    stdout: command === "npm" ? "11.9.0\n" : "git version 2.50.1.windows.1\n",
  }),
  ...overrides,
});

describe("repository doctor", { timeout: 30_000 }, () => {
  it("returns a deterministic, versioned report for supported prerequisites", () => {
    const first = collectRepositoryDoctor(healthyDependencies());
    const second = collectRepositoryDoctor(healthyDependencies());

    expect(first).toEqual(second);
    expect(repositoryDoctorReportSchema.parse(first)).toEqual(first);
    expect(first).toEqual({
      schemaVersion: "1.0.0",
      kind: "hunter-pi/repository-doctor",
      status: "DETECTED",
      checks: [
        {
          id: "platform",
          status: "DETECTED",
          summary: "Supported development platform detected: win32.",
        },
        {
          id: "node",
          status: "DETECTED",
          summary: "Required Node.js major detected: 24.",
        },
        {
          id: "npm",
          status: "DETECTED",
          summary: "npm executable detected (11.9.0).",
        },
        {
          id: "git",
          status: "DETECTED",
          summary: "Git executable detected (2.50.1.windows.1).",
        },
        {
          id: "repository",
          status: "DETECTED",
          summary: "Repository markers detected.",
        },
      ],
    });
  });

  it("blocks an unsupported Node.js major", () => {
    const report = collectRepositoryDoctor(healthyDependencies({ nodeVersion: "v22.17.0" }));

    expect(report.status).toBe("BLOCKED");
    expect(report.checks[1]).toEqual({
      id: "node",
      status: "BLOCKED",
      summary: "Node.js 24 is required; detected major 22.",
    });
  });

  it("blocks an unsupported npm major", () => {
    const report = collectRepositoryDoctor(
      healthyDependencies({
        runCommand: (command) => ({
          ok: true,
          stdout: command === "npm" ? "10.9.0\n" : "git version 2.50.1.windows.1\n",
        }),
      }),
    );

    expect(report.status).toBe("BLOCKED");
    expect(report.checks[2]).toEqual({
      id: "npm",
      status: "BLOCKED",
      summary: "npm 11 is required; detected major 10.",
    });
  });

  it("records an unvalidated platform as NOT_PROVEN", () => {
    const report = collectRepositoryDoctor(healthyDependencies({ platform: "darwin" }));

    expect(report.status).toBe("NOT_PROVEN");
    expect(report.checks[0]).toEqual({
      id: "platform",
      status: "NOT_PROVEN",
      summary: "Development platform is not validated by Task 1.",
    });
  });

  it("detects Ubuntu but keeps an unknown Linux distribution NOT_PROVEN", () => {
    const ubuntuReport = collectRepositoryDoctor(
      healthyDependencies({
        linuxDistribution: "ubuntu",
        platform: "linux",
      }),
    );
    const unknownLinuxReport = collectRepositoryDoctor(
      healthyDependencies({
        linuxDistribution: "alpine",
        platform: "linux",
      }),
    );

    expect(ubuntuReport.checks[0]).toEqual({
      id: "platform",
      status: "DETECTED",
      summary: "Supported development platform detected: ubuntu.",
    });
    expect(unknownLinuxReport.status).toBe("NOT_PROVEN");
    expect(unknownLinuxReport.checks[0]).toEqual({
      id: "platform",
      status: "NOT_PROVEN",
      summary: "Development platform is not validated by Task 1.",
    });
  });

  it("uses a stable BLOCKED reason without leaking command errors or paths", () => {
    const sensitive = "C:\\Users\\private-user\\.config\\token=do-not-print";
    const report = collectRepositoryDoctor(
      healthyDependencies({
        runCommand: (command) =>
          command === "npm"
            ? { ok: false, stdout: sensitive }
            : { ok: true, stdout: "git version 2.50.1.windows.1" },
      }),
    );
    const serialized = JSON.stringify(report);

    expect(report.status).toBe("BLOCKED");
    expect(report.checks[2]).toEqual({
      id: "npm",
      status: "BLOCKED",
      summary: "npm executable is unavailable.",
    });
    expect(serialized).not.toContain("private-user");
    expect(serialized).not.toContain("do-not-print");
  });

  it("contains a thrown command failure as a stable BLOCKED result", () => {
    const report = collectRepositoryDoctor(
      healthyDependencies({
        runCommand: () => {
          throw new Error("C:\\Users\\private-user\\credential-store");
        },
      }),
    );

    expect(report.status).toBe("BLOCKED");
    expect(report.checks[2]).toEqual({
      id: "npm",
      status: "BLOCKED",
      summary: "npm executable is unavailable.",
    });
    expect(JSON.stringify(report)).not.toContain("private-user");
  });

  it("blocks when repository markers are incomplete", () => {
    const report = collectRepositoryDoctor(healthyDependencies({ fileExists: () => false }));

    expect(report.status).toBe("BLOCKED");
    expect(report.checks[4]).toEqual({
      id: "repository",
      status: "BLOCKED",
      summary: "Run the doctor from the Hunter Pi repository root.",
    });
  });

  it("rejects unknown report fields", () => {
    const report = collectRepositoryDoctor(healthyDependencies());

    expect(() => repositoryDoctorReportSchema.parse({ ...report, provider: "specific" })).toThrow();
  });

  it("rejects duplicate check identities and an inconsistent aggregate", () => {
    const report = collectRepositoryDoctor(healthyDependencies());

    expect(() =>
      repositoryDoctorReportSchema.parse({
        ...report,
        checks: Array.from({ length: 5 }, () => report.checks[0]),
      }),
    ).toThrow();
    expect(() =>
      repositoryDoctorReportSchema.parse({
        ...report,
        status: "NOT_PROVEN",
      }),
    ).toThrow();
  });

  it("runs as a privacy-safe CLI on the local Task 1 prerequisites", () => {
    const result = spawnSync(process.execPath, ["tools/doctor.ts", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
      shell: false,
      windowsHide: true,
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(repositoryDoctorReportSchema.parse(JSON.parse(result.stdout))).toMatchObject({
      status: "DETECTED",
    });
  });
});
