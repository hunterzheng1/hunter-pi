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
  releaseCandidateSchema,
  updateQualificationRequestSchema,
  type GitHubActionsQualificationSource,
  type ReleaseCandidate,
} from "./contracts.js";
import { decodePortableBundle } from "./portable-bundle.js";
import { windowsPortableQualificationCandidateIdentity } from "./qualification-identity.js";
import * as qualificationCliProcess from "./gh-cli-process.js";

export const HPI_GITHUB_REPOSITORY = "hunterzheng1/hunter-pi" as const;
export const HPI_WINDOWS_PORTABLE_ARTIFACT_NAME = "hpi-windows-x64-portable" as const;
export const HPI_WINDOWS_PORTABLE_QUALIFICATION_JOB_NAMES = [
  "Tests / ubuntu-latest",
  "Tests / windows-latest",
  "Quality + platform Evidence / ubuntu-latest",
  "Quality + platform Evidence / windows-latest",
  "Windows x64 portable artifact",
  "Windows external package smoke",
  "Windows clean locked install",
  "Pi + Task 9 + Task 10 Evidence / Windows + Ubuntu identity",
  "Task 7 containment / ubuntu-latest",
  "Task 7 containment / windows-latest",
  "Task 7 Evidence / Windows + Ubuntu identity",
  "CI gate",
] as const;
const HPI_WINDOWS_PORTABLE_QUALIFICATION_JOB_NAMES_V1 = [
  "ubuntu-latest / Node 24",
  "windows-latest / Node 24",
  "Pi + Task 9 + Task 10 Evidence / Windows + Ubuntu identity",
  "Task 7 containment / ubuntu-latest",
  "Task 7 containment / windows-latest",
  "Task 7 Evidence / Windows + Ubuntu identity",
] as const;
const windowsPortableQualificationJobNames = new Set<string>(
  HPI_WINDOWS_PORTABLE_QUALIFICATION_JOB_NAMES,
);

const gitCommitSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const githubRunIdSchema = z.number().int().positive();
function createPortableQualificationRunSchema<
  const JobNames extends readonly [string, ...string[]],
>(jobNames: JobNames) {
  const successfulJobSchema = z.strictObject({
    name: z.enum(jobNames),
    status: z.literal("completed"),
    conclusion: z.literal("success"),
  });
  return z
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
      jobs: z.array(successfulJobSchema).length(jobNames.length),
    })
    .superRefine((run, context) => {
      const expectedNames = [...jobNames].sort();
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
}

const githubActionsPortableQualificationRunV1Schema = createPortableQualificationRunSchema(
  HPI_WINDOWS_PORTABLE_QUALIFICATION_JOB_NAMES_V1,
);
export const githubActionsPortableQualificationRunSchema = createPortableQualificationRunSchema(
  HPI_WINDOWS_PORTABLE_QUALIFICATION_JOB_NAMES,
);
export type GitHubActionsPortableQualificationRun = z.infer<
  typeof githubActionsPortableQualificationRunSchema
>;

const qualificationEvidenceFields = {
  evidenceId: evidenceIdSchema,
  repository: z.literal(HPI_GITHUB_REPOSITORY),
  sourceCommit: gitCommitSchema,
  candidateIdentityFingerprint: fingerprintSchema,
  artifact: z.strictObject({
    name: z.literal(HPI_WINDOWS_PORTABLE_ARTIFACT_NAME),
    fingerprint: fingerprintSchema,
    byteLength: z.number().int().positive(),
  }),
  observedAt: timestampSchema,
} as const;
const windowsPortableQualificationEvidenceV1Schema = z.strictObject({
  schemaVersion: z.literal("hpi-windows-portable-qualification-evidence.v1"),
  ...qualificationEvidenceFields,
  run: githubActionsPortableQualificationRunV1Schema,
});
export const windowsPortableQualificationEvidenceV2Schema = z.strictObject({
  schemaVersion: z.literal("hpi-windows-portable-qualification-evidence.v2"),
  ...qualificationEvidenceFields,
  run: githubActionsPortableQualificationRunSchema,
});
export const windowsPortableQualificationEvidenceSchema = z.discriminatedUnion("schemaVersion", [
  windowsPortableQualificationEvidenceV1Schema,
  windowsPortableQualificationEvidenceV2Schema,
]);
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
  readonly #runGh: GhCliGitHubActionsQualificationObserverOptions["runGh"];
  readonly #now: () => number;

  public constructor(options: GhCliGitHubActionsQualificationObserverOptions = {}) {
    this.#temporaryParent = resolve(options.temporaryParent ?? tmpdir());
    this.#runGh = options.runGh;
    this.#now = options.now ?? Date.now;
  }

  public async observe(
    input: GitHubActionsQualificationObserverInput,
  ): Promise<GitHubActionsQualificationObservation> {
    const source = githubActionsQualificationSourceSchema.parse(input.source);
    const deadline = timestampSchema.parse(input.deadline);
    const requestedTimeoutMs = z.number().int().positive().parse(input.timeoutMs);
    const operationDeadlineMs = Math.min(Date.parse(deadline), this.#now() + requestedTimeoutMs);
    const remainingTimeoutMs = (): number => {
      const remainingMs = operationDeadlineMs - this.#now();
      if (remainingMs <= 0) throw new Error("GitHub qualification source unavailable");
      return Math.min(requestedTimeoutMs, remainingMs);
    };
    const requireUnexpiredObservation = (): void => {
      if (operationDeadlineMs - this.#now() <= 0) {
        throw new Error("GitHub qualification source unavailable");
      }
    };
    let downloadRoot: string | undefined;
    try {
      let runGh = this.#runGh;
      if (runGh === undefined) {
        const executable = await qualificationCliProcess.resolveQualificationCliExecutable(
          process.platform === "win32" ? "gh.exe" : "gh",
          remainingTimeoutMs(),
        );
        requireUnexpiredObservation();
        runGh = (arguments_, timeoutMs) =>
          qualificationCliProcess.runQualificationCliProcess(executable, arguments_, timeoutMs);
      }
      const view = await runGh(
        [
          "run",
          "view",
          String(source.runId),
          "--repo",
          source.repository,
          "--json",
          "attempt,conclusion,databaseId,event,headBranch,headSha,jobs,status,updatedAt,url,workflowName",
        ],
        remainingTimeoutMs(),
      );
      requireUnexpiredObservation();
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
        jobs: raw.jobs
          .filter((job) => windowsPortableQualificationJobNames.has(job.name))
          .map((job) => ({
            name: job.name,
            status: job.status,
            conclusion: job.conclusion,
          })),
      });
      downloadRoot = await mkdtemp(join(this.#temporaryParent, "hunter-pi-gh-qualification-"));
      const download = await runGh(
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
        remainingTimeoutMs(),
      );
      requireUnexpiredObservation();
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

export function verifyWindowsPortableQualificationEvidence(
  candidateInput: ReleaseCandidate,
  evidenceInput: unknown,
  artifact: Uint8Array,
): WindowsPortableQualificationEvidence {
  const candidate = releaseCandidateSchema.parse(candidateInput);
  const evidence = windowsPortableQualificationEvidenceSchema.parse(evidenceInput);
  const candidateIdentity = windowsPortableQualificationCandidateIdentity(candidate);
  const expectedEvidenceId = `evidence_main-ci-${String(evidence.run.id)}-portable`;
  const bundle = decodePortableBundle(artifact);
  const qualificationCheck = candidate.qualification.checks[0];
  if (
    evidence.candidateIdentityFingerprint !== sha256Fingerprint(canonicalJson(candidateIdentity)) ||
    evidence.artifact.fingerprint !== candidate.artifact.fingerprint ||
    evidence.artifact.byteLength !== candidate.artifact.byteLength ||
    evidence.sourceCommit !== evidence.run.headSha ||
    evidence.sourceCommit !== bundle.manifest.sourceCommit ||
    evidence.evidenceId !== expectedEvidenceId ||
    candidate.qualification.status !== "PASS" ||
    candidate.qualification.verifierFingerprint !== HPI_UPDATE_QUALIFICATION_VERIFIER_FINGERPRINT ||
    candidate.qualification.qualifiedAt !== evidence.run.updatedAt ||
    candidate.qualification.checks.length !== 1 ||
    qualificationCheck?.name !== "windows-portable-ci" ||
    qualificationCheck.outcome !== "PASS" ||
    canonicalJson(qualificationCheck.evidenceIds) !== canonicalJson([evidence.evidenceId])
  ) {
    throw new Error("portable qualification result does not bind the exact release Evidence");
  }
  return evidence;
}

export function windowsPortableQualificationTargetReference(
  candidate: ReleaseCandidate,
): ExternalReference {
  return externalReferenceSchema.parse({
    namespace: "hunter-pi.windows-portable-release",
    reference: sha256Fingerprint(
      canonicalJson(windowsPortableQualificationCandidateIdentity(candidate)),
    ),
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
      canonicalJson(windowsPortableQualificationCandidateIdentity(hostedCandidate)) !==
      canonicalJson(windowsPortableQualificationCandidateIdentity(candidate))
    ) {
      throw new Error("hosted candidate changes immutable release metadata");
    }
    if (sha256Fingerprint(observation.hostedArtifact) !== sha256Fingerprint(input.artifact)) {
      throw new Error("hosted portable artifact differs from the local promotion artifact");
    }

    const evidenceId = evidenceIdSchema.parse(`evidence_main-ci-${String(run.id)}-portable`);
    const candidateIdentity = windowsPortableQualificationCandidateIdentity(candidate);
    const evidence = windowsPortableQualificationEvidenceSchema.parse({
      schemaVersion: "hpi-windows-portable-qualification-evidence.v2",
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
