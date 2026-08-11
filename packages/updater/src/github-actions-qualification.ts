import { spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import {
  evidenceIdSchema,
  externalReferenceSchema,
  fingerprintSchema,
  timestampSchema,
  type ExternalReference,
  type Fingerprint,
} from "@hunter-pi/domain";
import { canonicalJson, sha256Fingerprint } from "@hunter-pi/evidence";

import {
  HPI_UPDATE_QUALIFICATION_VERIFIER_FINGERPRINT,
  githubActionsQualificationSourceSchema,
  releaseCandidateIdentitySchema,
  releaseCandidateSchema,
  updateQualificationRequestSchema,
  type GitHubActionsQualificationSource,
  type ReleaseCandidate,
} from "./contracts.js";
import { decodePortableBundle } from "./portable-bundle.js";

export const HPI_GITHUB_REPOSITORY = "hunterzheng1/hunter-pi" as const;
export const HPI_WINDOWS_PORTABLE_ARTIFACT_NAME = "hpi-windows-x64-portable" as const;
export const HPI_WINDOWS_PORTABLE_QUALIFICATION_JOB_NAMES = [
  "ubuntu-latest / Node 24",
  "windows-latest / Node 24",
  "Pi + Task 9 + Task 10 Evidence / Windows + Ubuntu identity",
  "Task 7 containment / ubuntu-latest",
  "Task 7 containment / windows-latest",
  "Task 7 Evidence / Windows + Ubuntu identity",
] as const;

const gitCommitSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const githubRunIdSchema = z.number().int().positive();
const successfulJobSchema = z.strictObject({
  name: z.enum(HPI_WINDOWS_PORTABLE_QUALIFICATION_JOB_NAMES),
  status: z.literal("completed"),
  conclusion: z.literal("success"),
});

export const githubActionsPortableQualificationRunSchema = z
  .strictObject({
    id: githubRunIdSchema,
    attempt: z.number().int().positive(),
    event: z.literal("push"),
    headBranch: z.literal("main"),
    headSha: gitCommitSchema,
    workflowName: z.literal("CI"),
    status: z.literal("completed"),
    conclusion: z.literal("success"),
    updatedAt: timestampSchema,
    url: z.url(),
    jobs: z.array(successfulJobSchema).length(HPI_WINDOWS_PORTABLE_QUALIFICATION_JOB_NAMES.length),
  })
  .superRefine((run, context) => {
    const expectedNames = [...HPI_WINDOWS_PORTABLE_QUALIFICATION_JOB_NAMES].sort();
    const observedNames = run.jobs.map((job) => job.name).sort();
    if (canonicalJson(observedNames) !== canonicalJson(expectedNames)) {
      context.addIssue({
        code: "custom",
        path: ["jobs"],
        message: "portable qualification requires the exact hosted CI job set",
      });
    }
    const expectedUrl = `https://github.com/${HPI_GITHUB_REPOSITORY}/actions/runs/${String(run.id)}`;
    if (run.url !== expectedUrl) {
      context.addIssue({
        code: "custom",
        path: ["url"],
        message: "portable qualification run URL does not bind the trusted repository and run",
      });
    }
  });
export type GitHubActionsPortableQualificationRun = z.infer<
  typeof githubActionsPortableQualificationRunSchema
>;

export const windowsPortableQualificationEvidenceSchema = z.strictObject({
  schemaVersion: z.literal("hpi-windows-portable-qualification-evidence.v1"),
  evidenceId: evidenceIdSchema,
  repository: z.literal(HPI_GITHUB_REPOSITORY),
  sourceCommit: gitCommitSchema,
  candidateIdentityFingerprint: fingerprintSchema,
  artifact: z.strictObject({
    name: z.literal(HPI_WINDOWS_PORTABLE_ARTIFACT_NAME),
    fingerprint: fingerprintSchema,
    byteLength: z.number().int().positive(),
  }),
  run: githubActionsPortableQualificationRunSchema,
  observedAt: timestampSchema,
});
export type WindowsPortableQualificationEvidence = z.infer<
  typeof windowsPortableQualificationEvidenceSchema
>;

export interface GitHubActionsQualificationObservation {
  readonly run: unknown;
  readonly hostedArtifact: Uint8Array;
  readonly hostedCandidate: unknown;
}

export interface GitHubActionsQualificationObserverInput {
  readonly source: GitHubActionsQualificationSource;
  readonly deadline: string;
  readonly timeoutMs: number;
}

export interface GhCliCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GhCliGitHubActionsQualificationObserverOptions {
  readonly temporaryParent?: string;
  readonly now?: () => number;
  readonly runGh?: (
    arguments_: readonly string[],
    timeoutMs: number,
  ) => Promise<GhCliCommandResult>;
}

const ghRunViewSchema = z.object({
  attempt: z.number().int().positive(),
  conclusion: z.string(),
  databaseId: z.number().int().positive(),
  event: z.string(),
  headBranch: z.string(),
  headSha: z.string(),
  jobs: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      conclusion: z.string(),
    }),
  ),
  status: z.string(),
  updatedAt: z.string(),
  url: z.string(),
  workflowName: z.string(),
});

function runGhCli(arguments_: readonly string[], timeoutMs: number): Promise<GhCliCommandResult> {
  return new Promise((resolvePromise) => {
    const child = spawn("gh", [...arguments_], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputExceeded = false;
    const maxOutputBytes = 1_048_576;
    const append = (current: string, chunk: unknown): string => {
      const next = current + String(chunk);
      if (Buffer.byteLength(next, "utf8") > maxOutputBytes) {
        outputExceeded = true;
        child.kill();
        return current;
      }
      return next;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      resolvePromise({ exitCode: null, stdout: "", stderr: "" });
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: outputExceeded ? null : exitCode,
        stdout: outputExceeded ? "" : stdout,
        stderr: outputExceeded ? "" : stderr,
      });
    });
  });
}

async function readContainedPhysicalFile(root: string, filename: string): Promise<Uint8Array> {
  const target = resolve(root, filename);
  const relativeTarget = relative(resolve(root), target);
  if (
    relativeTarget.length === 0 ||
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget)
  ) {
    throw new Error("qualification artifact escaped its download directory");
  }
  const status = await lstat(target);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error("qualification artifact is not one physical file");
  }
  const canonical = await realpath(target);
  if (canonical !== target) throw new Error("qualification artifact resolved through a link");
  return readFile(target);
}

export class GhCliGitHubActionsQualificationObserver {
  readonly #temporaryParent: string;
  readonly #runGh: NonNullable<GhCliGitHubActionsQualificationObserverOptions["runGh"]>;
  readonly #now: () => number;

  public constructor(options: GhCliGitHubActionsQualificationObserverOptions = {}) {
    this.#temporaryParent = resolve(options.temporaryParent ?? tmpdir());
    this.#runGh = options.runGh ?? runGhCli;
    this.#now = options.now ?? Date.now;
  }

  public async observe(
    input: GitHubActionsQualificationObserverInput,
  ): Promise<GitHubActionsQualificationObservation> {
    const source = githubActionsQualificationSourceSchema.parse(input.source);
    const deadline = timestampSchema.parse(input.deadline);
    const remainingMs = Date.parse(deadline) - this.#now();
    if (remainingMs <= 0) throw new Error("GitHub qualification source unavailable");
    const timeoutMs = Math.min(z.number().int().positive().parse(input.timeoutMs), remainingMs);
    let downloadRoot: string | undefined;
    try {
      const view = await this.#runGh(
        [
          "run",
          "view",
          String(source.runId),
          "--repo",
          source.repository,
          "--json",
          "attempt,conclusion,databaseId,event,headBranch,headSha,jobs,status,updatedAt,url,workflowName",
        ],
        timeoutMs,
      );
      if (view.exitCode !== 0) throw new Error("run view failed");
      const raw = ghRunViewSchema.parse(JSON.parse(view.stdout) as unknown);
      const run = githubActionsPortableQualificationRunSchema.parse({
        id: raw.databaseId,
        attempt: raw.attempt,
        event: raw.event,
        headBranch: raw.headBranch,
        headSha: raw.headSha,
        workflowName: raw.workflowName,
        status: raw.status,
        conclusion: raw.conclusion,
        updatedAt: raw.updatedAt,
        url: raw.url,
        jobs: raw.jobs.map((job) => ({
          name: job.name,
          status: job.status,
          conclusion: job.conclusion,
        })),
      });
      downloadRoot = await mkdtemp(join(this.#temporaryParent, "hunter-pi-gh-qualification-"));
      const download = await this.#runGh(
        [
          "run",
          "download",
          String(source.runId),
          "--repo",
          source.repository,
          "--name",
          HPI_WINDOWS_PORTABLE_ARTIFACT_NAME,
          "--dir",
          downloadRoot,
        ],
        timeoutMs,
      );
      if (download.exitCode !== 0) throw new Error("artifact download failed");
      const hostedArtifact = await readContainedPhysicalFile(downloadRoot, "update.bundle.tgz");
      const hostedCandidateBytes = await readContainedPhysicalFile(
        downloadRoot,
        "portable-release-candidate.json",
      );
      const hostedCandidate = releaseCandidateSchema.parse(
        JSON.parse(Buffer.from(hostedCandidateBytes).toString("utf8")) as unknown,
      );
      return { run, hostedArtifact, hostedCandidate };
    } catch {
      throw new Error("GitHub qualification source unavailable");
    } finally {
      if (downloadRoot !== undefined) {
        await rm(downloadRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}

export interface GitHubActionsWindowsPortableQualificationAuthorityOptions {
  readonly observe: (
    input: GitHubActionsQualificationObserverInput,
  ) => Promise<GitHubActionsQualificationObservation>;
}

export interface WindowsPortableQualificationAuthorityInput {
  readonly candidate: ReleaseCandidate;
  readonly artifact: Uint8Array;
  readonly source: GitHubActionsQualificationSource;
  readonly deadline: string;
  readonly cancellationPolicy: {
    readonly mode: "FAIL_CLOSED";
    readonly timeoutMs: number;
  };
}

export interface WindowsPortableQualificationResult {
  readonly candidate: ReleaseCandidate;
  readonly evidence: WindowsPortableQualificationEvidence;
}

export interface WindowsPortableQualificationAuthority {
  qualify(
    input: WindowsPortableQualificationAuthorityInput,
  ): Promise<WindowsPortableQualificationResult>;
}

function identityOfCandidate(candidate: ReleaseCandidate) {
  const { qualification, ...identityInput } = releaseCandidateSchema.parse(candidate);
  void qualification;
  return releaseCandidateIdentitySchema.parse(identityInput);
}

export function windowsPortableQualificationTargetReference(
  candidate: ReleaseCandidate,
): ExternalReference {
  return externalReferenceSchema.parse({
    namespace: "hunter-pi.windows-portable-release",
    reference: sha256Fingerprint(canonicalJson(identityOfCandidate(candidate))),
  });
}

export function windowsPortableQualificationRequestFingerprint(
  payload: Pick<
    z.input<typeof updateQualificationRequestSchema>,
    "expectedTarget" | "source" | "deadline" | "cancellationPolicy"
  >,
): Fingerprint {
  const parsed = updateQualificationRequestSchema
    .pick({ expectedTarget: true, source: true, deadline: true, cancellationPolicy: true })
    .parse({
      expectedTarget: payload.expectedTarget,
      source: payload.source,
      deadline: payload.deadline,
      cancellationPolicy: payload.cancellationPolicy,
    });
  return sha256Fingerprint(canonicalJson({ action: "QUALIFY", ...parsed }));
}

function assertPackagedCandidate(candidate: ReleaseCandidate): void {
  if (
    candidate.qualification.status !== "NOT_PROVEN" ||
    candidate.qualification.verifierFingerprint !== HPI_UPDATE_QUALIFICATION_VERIFIER_FINGERPRINT ||
    candidate.qualification.checks.length !== 1 ||
    candidate.qualification.checks[0]?.name !== "windows-portable-ci" ||
    candidate.qualification.checks[0].outcome !== "NOT_PROVEN" ||
    candidate.qualification.checks[0].evidenceIds.length !== 0
  ) {
    throw new Error("portable qualification requires the exact packaged NOT_PROVEN candidate");
  }
}

function assertArtifact(
  candidate: ReleaseCandidate,
  artifact: Uint8Array,
  label: "local" | "hosted",
): void {
  if (
    artifact.byteLength !== candidate.artifact.byteLength ||
    sha256Fingerprint(artifact) !== candidate.artifact.fingerprint
  ) {
    throw new Error(`${label} portable artifact does not match the release candidate`);
  }
}

export class GitHubActionsWindowsPortableQualificationAuthority implements WindowsPortableQualificationAuthority {
  readonly #observe: GitHubActionsWindowsPortableQualificationAuthorityOptions["observe"];

  public constructor(options: GitHubActionsWindowsPortableQualificationAuthorityOptions) {
    this.#observe = options.observe;
  }

  public async qualify(
    input: WindowsPortableQualificationAuthorityInput,
  ): Promise<WindowsPortableQualificationResult> {
    const candidate = releaseCandidateSchema.parse(input.candidate);
    const source = githubActionsQualificationSourceSchema.parse(input.source);
    const deadline = timestampSchema.parse(input.deadline);
    const timeoutMs = z.number().int().positive().parse(input.cancellationPolicy.timeoutMs);
    assertPackagedCandidate(candidate);
    assertArtifact(candidate, input.artifact, "local");
    const bundle = decodePortableBundle(input.artifact);
    const observation = await this.#observe({ source, deadline, timeoutMs });
    const run = githubActionsPortableQualificationRunSchema.parse(observation.run);
    const hostedCandidate = releaseCandidateSchema.parse(observation.hostedCandidate);
    if (run.id !== source.runId || run.headSha !== bundle.manifest.sourceCommit) {
      throw new Error("portable qualification run does not bind the exact artifact source");
    }
    if (Date.parse(run.updatedAt) > Date.parse(deadline)) {
      throw new Error("portable qualification run completed after the operation deadline");
    }
    assertArtifact(candidate, observation.hostedArtifact, "hosted");
    assertPackagedCandidate(hostedCandidate);
    assertArtifact(hostedCandidate, observation.hostedArtifact, "hosted");
    if (
      canonicalJson(identityOfCandidate(hostedCandidate)) !==
      canonicalJson(identityOfCandidate(candidate))
    ) {
      throw new Error("hosted candidate changes immutable release metadata");
    }
    if (sha256Fingerprint(observation.hostedArtifact) !== sha256Fingerprint(input.artifact)) {
      throw new Error("hosted portable artifact differs from the local promotion artifact");
    }

    const evidenceId = evidenceIdSchema.parse(`evidence_main-ci-${String(run.id)}-portable`);
    const candidateIdentity = identityOfCandidate(candidate);
    const evidence = windowsPortableQualificationEvidenceSchema.parse({
      schemaVersion: "hpi-windows-portable-qualification-evidence.v1",
      evidenceId,
      repository: source.repository,
      sourceCommit: bundle.manifest.sourceCommit,
      candidateIdentityFingerprint: sha256Fingerprint(canonicalJson(candidateIdentity)),
      artifact: {
        name: HPI_WINDOWS_PORTABLE_ARTIFACT_NAME,
        fingerprint: candidate.artifact.fingerprint,
        byteLength: candidate.artifact.byteLength,
      },
      run,
      observedAt: run.updatedAt,
    });
    const qualified = releaseCandidateSchema.parse({
      ...candidateIdentity,
      qualification: {
        status: "PASS",
        verifierFingerprint: HPI_UPDATE_QUALIFICATION_VERIFIER_FINGERPRINT,
        checks: [
          {
            name: "windows-portable-ci",
            outcome: "PASS",
            evidenceIds: [evidenceId],
          },
        ],
        qualifiedAt: run.updatedAt,
      },
    });
    return { candidate: qualified, evidence };
  }
}
