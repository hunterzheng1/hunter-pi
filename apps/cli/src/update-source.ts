import { z } from "zod";

import {
  releaseCandidateSchema,
  windowsPortableQualificationEvidenceSchema,
  type ReleaseCandidate,
  type WindowsPortableQualificationEvidence,
} from "@hunter-pi/updater";

import type { AutomaticUpdateDiscovery } from "./cli.js";

const RELEASE_LIST_LIMIT = 2 * 1024 * 1024;
const CANDIDATE_LIMIT = 512 * 1024;
const ARTIFACT_LIMIT = 512 * 1024 * 1024;
const UPDATE_TIMEOUT_MS = 120_000;
const REPOSITORY = "hunterzheng1/hunter-pi";
const RELEASE_LIST_URL = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=20`;
const GITHUB_API_HOSTS = new Set(["api.github.com"]);
const GITHUB_ASSET_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

export class HpiUpdateDiscoveryError extends Error {
  readonly stage: "DISCOVERY" | "DOWNLOAD" | "VALIDATION";
  readonly host: string | undefined;

  constructor(stage: "DISCOVERY" | "DOWNLOAD" | "VALIDATION", message: string, host?: string) {
    super(message);
    this.name = "HpiUpdateDiscoveryError";
    this.stage = stage;
    this.host = host;
  }
}

function invalidUpdate(message: string, host?: string): HpiUpdateDiscoveryError {
  return new HpiUpdateDiscoveryError("VALIDATION", message, host);
}

const githubAssetSchema = z.object({
  name: z.string().min(1).max(256),
  browser_download_url: z.url(),
});

const githubReleaseSchema = z.object({
  tag_name: z.string().min(2).max(128),
  html_url: z.url(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  assets: z.array(githubAssetSchema).max(64),
});

const githubReleaseListSchema = z.array(githubReleaseSchema).max(100);

interface ParsedSemver {
  readonly source: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}

function parseSemver(value: string): ParsedSemver {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(
      value,
    );
  if (match === null)
    throw invalidUpdate("the release channel returned an invalid product version");
  const [, major, minor, patch, prerelease] = match;
  if (major === undefined || minor === undefined || patch === undefined) {
    throw invalidUpdate("the release channel returned an incomplete product version");
  }
  return {
    source: value,
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease?.split(".") ?? [],
  };
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumber = /^(?:0|[1-9]\d*)$/u.test(left) ? Number(left) : undefined;
  const rightNumber = /^(?:0|[1-9]\d*)$/u.test(right) ? Number(right) : undefined;
  if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber - rightNumber;
  if (leftNumber !== undefined) return -1;
  if (rightNumber !== undefined) return 1;
  return left.localeCompare(right, "en", { sensitivity: "case", usage: "sort" });
}

function compareSemver(left: ParsedSemver, right: ParsedSemver): number {
  for (const key of ["major", "minor", "patch"] as const) {
    const difference = left[key] - right[key];
    if (difference !== 0) return difference;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const count = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    const difference = comparePrereleaseIdentifier(leftIdentifier, rightIdentifier);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
  label: string,
  deadline: number,
  timeoutError: () => HpiUpdateDiscoveryError,
  abort: () => void,
): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`${label} download returned HTTP ${String(response.status)}`);
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maximumBytes) {
    throw new Error(`${label} download exceeds its byte limit`);
  }
  const body = response.body;
  if (body === null) throw new Error(`${label} response has no body`);
  const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      abort();
      await reader.cancel().catch(() => undefined);
      throw timeoutError();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          abort();
          reject(timeoutError());
        }, remaining);
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
    if (next.done) break;
    const chunk: Uint8Array = next.value;
    byteLength += chunk.byteLength;
    if (byteLength > maximumBytes) {
      await reader.cancel();
      throw new Error(`${label} download exceeds its byte limit`);
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function requestBytes(
  url: string,
  maximumBytes: number,
  label: string,
  stage: "DISCOVERY" | "DOWNLOAD",
  deadline: number,
  allowedFinalHosts: ReadonlySet<string>,
  fetcher: typeof fetch,
): Promise<Uint8Array> {
  const host = new URL(url).host;
  const timeoutError = () =>
    new HpiUpdateDiscoveryError(
      stage,
      `${label} download timed out for ${host}; verify network access and retry`,
      host,
    );
  const controller = new AbortController();
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw timeoutError();
  let response: Response;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    response = await Promise.race([
      fetcher(url, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "hunter-pi-update",
        },
        redirect: "follow",
        signal: controller.signal,
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(timeoutError());
        }, remaining);
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  } catch (error) {
    if (error instanceof HpiUpdateDiscoveryError) throw error;
    throw new HpiUpdateDiscoveryError(
      stage,
      `${label} download failed for ${host}; verify TLS trust, HTTPS proxy policy, and network access`,
      host,
    );
  }
  let finalUrl: URL;
  try {
    finalUrl = new URL(response.url);
  } catch {
    throw invalidUpdate(`${label} response did not identify its final HTTPS source`, host);
  }
  if (
    finalUrl.protocol !== "https:" ||
    finalUrl.username.length !== 0 ||
    finalUrl.password.length !== 0 ||
    !allowedFinalHosts.has(finalUrl.hostname)
  ) {
    throw invalidUpdate(`${label} response left the official GitHub source`, finalUrl.hostname);
  }
  try {
    return await readBoundedResponse(response, maximumBytes, label, deadline, timeoutError, () => {
      controller.abort();
    });
  } catch (error) {
    if (error instanceof HpiUpdateDiscoveryError) throw error;
    throw new HpiUpdateDiscoveryError(
      stage,
      `${label} download was rejected for ${host}; verify release availability and retry`,
      host,
    );
  }
}

function exactReleaseAssetUrl(url: string, tag: string, name: string): string {
  const parsed = new URL(url);
  const expectedPath = `/${REPOSITORY}/releases/download/${tag}/${name}`;
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    parsed.username.length !== 0 ||
    parsed.password.length !== 0 ||
    parsed.search.length !== 0 ||
    parsed.hash.length !== 0 ||
    parsed.pathname !== expectedPath
  ) {
    throw invalidUpdate("the release channel returned an invalid update asset URL", "github.com");
  }
  return parsed.toString();
}

function decodeCandidate(bytes: Uint8Array): ReleaseCandidate {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("the release candidate is not valid UTF-8 JSON");
  }
  return releaseCandidateSchema.parse(value);
}

export async function discoverGithubUpdate(
  options: {
    readonly currentVersion: string;
    readonly channel: string;
  },
  fetcher: typeof fetch = fetch,
  timing: { readonly timeoutMs?: number } = {},
): Promise<AutomaticUpdateDiscovery> {
  if (options.channel !== "developer-preview") {
    throw invalidUpdate("automatic updates are not configured for this product channel");
  }
  const deadline = Date.now() + (timing.timeoutMs ?? UPDATE_TIMEOUT_MS);
  const current = parseSemver(options.currentVersion);
  const releasesBytes = await requestBytes(
    RELEASE_LIST_URL,
    RELEASE_LIST_LIMIT,
    "release index",
    "DISCOVERY",
    deadline,
    GITHUB_API_HOSTS,
    fetcher,
  );
  let releases: z.infer<typeof githubReleaseListSchema>;
  try {
    releases = githubReleaseListSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(releasesBytes)) as unknown,
    );
  } catch {
    throw invalidUpdate("the release channel returned invalid release metadata", "api.github.com");
  }
  const eligible = releases
    .filter((release) => !release.draft && release.prerelease && release.tag_name.startsWith("v"))
    .map((release) => ({ release, version: parseSemver(release.tag_name.slice(1)) }))
    .filter(({ version }) => compareSemver(version, current) > 0)
    .sort((left, right) => compareSemver(right.version, left.version));
  const selected = eligible[0];
  if (selected === undefined) {
    return { status: "CURRENT", currentVersion: options.currentVersion };
  }
  const candidateName = "portable-release-candidate.json";
  const artifactName = "update.bundle.tgz";
  const evidenceName = "windows-portable-qualification-evidence.json";
  const candidateAsset = selected.release.assets.find((asset) => asset.name === candidateName);
  const artifactAsset = selected.release.assets.find((asset) => asset.name === artifactName);
  const evidenceAsset = selected.release.assets.find((asset) => asset.name === evidenceName);
  if (candidateAsset === undefined || artifactAsset === undefined || evidenceAsset === undefined) {
    throw invalidUpdate("the newest release is missing required update assets", "github.com");
  }
  const candidateUrl = exactReleaseAssetUrl(
    candidateAsset.browser_download_url,
    selected.release.tag_name,
    candidateName,
  );
  const artifactUrl = exactReleaseAssetUrl(
    artifactAsset.browser_download_url,
    selected.release.tag_name,
    artifactName,
  );
  const evidenceUrl = exactReleaseAssetUrl(
    evidenceAsset.browser_download_url,
    selected.release.tag_name,
    evidenceName,
  );
  const candidateBytes = await requestBytes(
    candidateUrl,
    CANDIDATE_LIMIT,
    "candidate",
    "DOWNLOAD",
    deadline,
    GITHUB_ASSET_HOSTS,
    fetcher,
  );
  let candidate: ReleaseCandidate;
  try {
    candidate = decodeCandidate(candidateBytes);
  } catch {
    throw invalidUpdate("the downloaded release candidate is invalid", "github.com");
  }
  if (candidate.productVersion !== selected.version.source) {
    throw invalidUpdate("the release candidate does not match its release tag", "github.com");
  }
  if (candidate.channel !== "PREVIEW") {
    throw invalidUpdate("the release candidate does not match the developer-preview channel");
  }
  if (candidate.artifact.reference !== artifactName) {
    throw invalidUpdate(
      "the release candidate does not reference the official update artifact",
      "github.com",
    );
  }
  if (candidate.artifact.byteLength > ARTIFACT_LIMIT) {
    throw invalidUpdate("the release artifact exceeds the supported byte limit", "github.com");
  }
  const artifactBytes = await requestBytes(
    artifactUrl,
    candidate.artifact.byteLength,
    "artifact",
    "DOWNLOAD",
    deadline,
    GITHUB_ASSET_HOSTS,
    fetcher,
  );
  if (artifactBytes.byteLength !== candidate.artifact.byteLength) {
    throw invalidUpdate("the release artifact length does not match its candidate", "github.com");
  }
  const evidenceBytes = await requestBytes(
    evidenceUrl,
    CANDIDATE_LIMIT,
    "qualification Evidence",
    "DOWNLOAD",
    deadline,
    GITHUB_ASSET_HOSTS,
    fetcher,
  );
  let qualificationEvidence: WindowsPortableQualificationEvidence;
  try {
    qualificationEvidence = windowsPortableQualificationEvidenceSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(evidenceBytes)) as unknown,
    );
  } catch {
    throw invalidUpdate("the downloaded qualification Evidence is invalid", "github.com");
  }
  return {
    status: "AVAILABLE",
    candidate,
    artifact: artifactBytes,
    qualificationEvidence,
    releasePage: selected.release.html_url,
  };
}
