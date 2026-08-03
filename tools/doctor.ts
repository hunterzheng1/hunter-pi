import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

const doctorStatusSchema = z.enum(["DETECTED", "BLOCKED", "NOT_PROVEN"]);
type DoctorStatus = z.infer<typeof doctorStatusSchema>;

const aggregateStatus = (checks: readonly { readonly status: DoctorStatus }[]): DoctorStatus => {
  if (checks.some((check) => check.status === "BLOCKED")) {
    return "BLOCKED";
  }

  if (checks.some((check) => check.status === "NOT_PROVEN")) {
    return "NOT_PROVEN";
  }

  return "DETECTED";
};

const doctorCheckShape = {
  status: doctorStatusSchema,
  summary: z.string().min(1),
};
const doctorChecksSchema = z.tuple([
  z.object({ id: z.literal("platform"), ...doctorCheckShape }).strict(),
  z.object({ id: z.literal("node"), ...doctorCheckShape }).strict(),
  z.object({ id: z.literal("npm"), ...doctorCheckShape }).strict(),
  z.object({ id: z.literal("git"), ...doctorCheckShape }).strict(),
  z.object({ id: z.literal("repository"), ...doctorCheckShape }).strict(),
]);

export const repositoryDoctorReportSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    kind: z.literal("hunter-pi/repository-doctor"),
    status: doctorStatusSchema,
    checks: doctorChecksSchema,
  })
  .strict()
  .superRefine((report, context) => {
    const expectedStatus = aggregateStatus(report.checks);
    if (report.status !== expectedStatus) {
      context.addIssue({
        code: "custom",
        message: `Aggregate status must be ${expectedStatus}.`,
        path: ["status"],
      });
    }
  });

type DoctorCheck = z.infer<typeof doctorChecksSchema>[number];
export type RepositoryDoctorReport = z.infer<typeof repositoryDoctorReportSchema>;

export interface DoctorCommandResult {
  readonly ok: boolean;
  readonly stdout: string;
}

export interface DoctorDependencies {
  readonly platform: string;
  readonly linuxDistribution: string | undefined;
  readonly nodeVersion: string;
  readonly runCommand: (command: "git" | "npm") => DoctorCommandResult;
  readonly fileExists: (relativePath: ".git" | "package.json") => boolean;
}

const collectPlatformCheck = (
  platform: string,
  linuxDistribution: string | undefined,
): DoctorCheck => {
  if (platform === "win32") {
    return {
      id: "platform",
      status: "DETECTED",
      summary: `Supported development platform detected: ${platform}.`,
    };
  }

  if (platform === "linux" && linuxDistribution?.toLowerCase() === "ubuntu") {
    return {
      id: "platform",
      status: "DETECTED",
      summary: "Supported development platform detected: ubuntu.",
    };
  }

  return {
    id: "platform",
    status: "NOT_PROVEN",
    summary: "Development platform is not validated by Task 1.",
  };
};

const collectNodeCheck = (nodeVersion: string): DoctorCheck => {
  const majorMatch = /^v?(\d+)(?:\.|$)/u.exec(nodeVersion.trim());

  if (majorMatch === null) {
    return {
      id: "node",
      status: "BLOCKED",
      summary: "Unable to prove the required Node.js 24 runtime.",
    };
  }

  const major = Number.parseInt(majorMatch[1] ?? "", 10);
  if (major !== 24) {
    return {
      id: "node",
      status: "BLOCKED",
      summary: `Node.js 24 is required; detected major ${String(major)}.`,
    };
  }

  return {
    id: "node",
    status: "DETECTED",
    summary: "Required Node.js major detected: 24.",
  };
};

const extractSafeVersion = (stdout: string): string | undefined =>
  /\b\d+(?:\.[0-9A-Za-z-]+)+\b/u.exec(stdout)?.[0];

const collectExecutableCheck = (
  id: "git" | "npm",
  label: "Git" | "npm",
  runCommand: DoctorDependencies["runCommand"],
): DoctorCheck => {
  let result: DoctorCommandResult;
  try {
    result = runCommand(id);
  } catch {
    return {
      id,
      status: "BLOCKED",
      summary: `${label} executable is unavailable.`,
    };
  }

  if (!result.ok) {
    return {
      id,
      status: "BLOCKED",
      summary: `${label} executable is unavailable.`,
    };
  }

  const version = extractSafeVersion(result.stdout);
  if (version === undefined) {
    return {
      id,
      status: "NOT_PROVEN",
      summary: `${label} executable responded, but its version was not proven.`,
    };
  }

  if (id === "npm") {
    const major = Number.parseInt(version, 10);
    if (major !== 11) {
      return {
        id,
        status: "BLOCKED",
        summary: `npm 11 is required; detected major ${String(major)}.`,
      };
    }
  }

  return {
    id,
    status: "DETECTED",
    summary: `${label} executable detected (${version}).`,
  };
};

const collectRepositoryCheck = (fileExists: DoctorDependencies["fileExists"]): DoctorCheck => {
  if (fileExists("package.json") && fileExists(".git")) {
    return {
      id: "repository",
      status: "DETECTED",
      summary: "Repository markers detected.",
    };
  }

  return {
    id: "repository",
    status: "BLOCKED",
    summary: "Run the doctor from the Hunter Pi repository root.",
  };
};

export const collectRepositoryDoctor = (
  dependencies: DoctorDependencies,
): RepositoryDoctorReport => {
  const checks: DoctorCheck[] = [
    collectPlatformCheck(dependencies.platform, dependencies.linuxDistribution),
    collectNodeCheck(dependencies.nodeVersion),
    collectExecutableCheck("npm", "npm", dependencies.runCommand),
    collectExecutableCheck("git", "Git", dependencies.runCommand),
    collectRepositoryCheck(dependencies.fileExists),
  ];

  return repositoryDoctorReportSchema.parse({
    schemaVersion: "1.0.0",
    kind: "hunter-pi/repository-doctor",
    status: aggregateStatus(checks),
    checks,
  });
};

const readLinuxDistribution = (): string | undefined => {
  if (process.platform !== "linux") {
    return undefined;
  }

  try {
    const osRelease = readFileSync("/etc/os-release", "utf8");
    const idMatch = /^ID=(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s#]+))\s*$/mu.exec(osRelease);
    return (idMatch?.[1] ?? idMatch?.[2] ?? idMatch?.[3])?.toLowerCase();
  } catch {
    return undefined;
  }
};

const runVersionCommand = (command: "git" | "npm"): DoctorCommandResult => {
  const npmEntryPoint = process.env["npm_execpath"];
  const useNpmEntryPoint =
    command === "npm" && npmEntryPoint !== undefined && npmEntryPoint.length > 0;
  const executable = useNpmEntryPoint ? process.execPath : command;
  const arguments_ = useNpmEntryPoint ? [npmEntryPoint, "--version"] : ["--version"];
  const result = spawnSync(executable, arguments_, {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });

  return {
    ok: result.error === undefined && result.status === 0,
    stdout: result.stdout,
  };
};

export const createDefaultDoctorDependencies = (): DoctorDependencies => {
  const repositoryRoot = process.cwd();

  return {
    platform: process.platform,
    linuxDistribution: readLinuxDistribution(),
    nodeVersion: process.version,
    runCommand: runVersionCommand,
    fileExists: (relativePath) => existsSync(resolve(repositoryRoot, relativePath)),
  };
};

const runCli = (): void => {
  const report = collectRepositoryDoctor(createDefaultDoctorDependencies());
  process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
  if (report.status === "BLOCKED") {
    process.exitCode = 1;
  }
};

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  runCli();
}
