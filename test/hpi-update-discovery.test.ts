import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { discoverGithubUpdate, HpiUpdateDiscoveryError } from "@hunter-pi/cli";
import {
  HPI_UPDATE_QUALIFICATION_VERIFIER_FINGERPRINT,
  HPI_WINDOWS_PORTABLE_QUALIFICATION_JOB_NAMES,
  releaseCandidateSchema,
  windowsPortableQualificationEvidenceSchema,
} from "@hunter-pi/updater";

const artifact = Buffer.from("qualified-update-artifact\n", "utf8");
const artifactFingerprint = `sha256:${createHash("sha256").update(artifact).digest("hex")}`;
const candidate = releaseCandidateSchema.parse({
  schemaVersion: "hpi-release-candidate.v1",
  releaseId: "release_hunter-pi-0.1.0-dev.2-fixture",
  productVersion: "0.1.0-dev.2",
  channel: "PREVIEW",
  artifact: {
    reference: "update.bundle.tgz",
    fingerprint: artifactFingerprint,
    byteLength: artifact.byteLength,
  },
  engine: {
    releaseId: "engine-release_pi-0.84.1",
    fingerprint: `sha256:${"a".repeat(64)}`,
    piVersion: "0.84.1",
  },
  qualification: {
    status: "PASS",
    verifierFingerprint: HPI_UPDATE_QUALIFICATION_VERIFIER_FINGERPRINT,
    checks: [
      {
        name: "windows-portable-ci",
        outcome: "PASS",
        evidenceIds: ["evidence_main-ci-12345-portable"],
      },
    ],
    qualifiedAt: "2026-08-13T03:00:00.000Z",
  },
  updatePolicy: { piSelfUpdate: "DISABLED", unsigned: true },
  licenses: [
    {
      name: "Hunter Pi",
      version: "0.1.0-dev.2",
      license: "MIT",
      sourceReference: "NOTICE",
    },
  ],
});

const apiUrl = "https://api.github.com/repos/hunterzheng1/hunter-pi/releases?per_page=20";
const candidateUrl =
  "https://github.com/hunterzheng1/hunter-pi/releases/download/v0.1.0-dev.2/portable-release-candidate.json";
const artifactUrl =
  "https://github.com/hunterzheng1/hunter-pi/releases/download/v0.1.0-dev.2/update.bundle.tgz";
const evidenceUrl =
  "https://github.com/hunterzheng1/hunter-pi/releases/download/v0.1.0-dev.2/windows-portable-qualification-evidence.json";
const qualificationEvidence = windowsPortableQualificationEvidenceSchema.parse({
  schemaVersion: "hpi-windows-portable-qualification-evidence.v2",
  evidenceId: "evidence_main-ci-12345-portable",
  repository: "hunterzheng1/hunter-pi",
  sourceCommit: "a".repeat(40),
  candidateIdentityFingerprint: `sha256:${"c".repeat(64)}`,
  artifact: {
    name: "hpi-windows-x64-portable",
    fingerprint: artifactFingerprint,
    byteLength: artifact.byteLength,
  },
  run: {
    id: 12345,
    attempt: 1,
    event: "push",
    headBranch: "main",
    headSha: "a".repeat(40),
    workflowName: "CI",
    status: "completed",
    conclusion: "success",
    updatedAt: "2026-08-13T03:00:00.000Z",
    url: "https://github.com/hunterzheng1/hunter-pi/actions/runs/12345",
    jobs: HPI_WINDOWS_PORTABLE_QUALIFICATION_JOB_NAMES.map((name) => ({
      name,
      status: "completed",
      conclusion: "success",
    })),
  },
  observedAt: "2026-08-13T03:00:00.000Z",
});

function responseAt(
  url: string,
  body: ConstructorParameters<typeof Response>[0],
  init: ResponseInit = {},
): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function releaseResponse(assets: readonly { readonly name: string; readonly url: string }[]) {
  return responseAt(
    apiUrl,
    JSON.stringify([
      {
        tag_name: "v0.1.0-dev.2",
        html_url: "https://github.com/hunterzheng1/hunter-pi/releases/tag/v0.1.0-dev.2",
        draft: false,
        prerelease: true,
        assets: assets.map((asset) => ({
          name: asset.name,
          browser_download_url: asset.url,
        })),
      },
      {
        tag_name: "v0.1.0-dev.1",
        html_url: "https://github.com/hunterzheng1/hunter-pi/releases/tag/v0.1.0-dev.1",
        draft: false,
        prerelease: true,
        assets: [],
      },
    ]),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

describe("GitHub update discovery", () => {
  it("downloads the exact candidate and artifact for the newest preview release", async () => {
    const requested: string[] = [];
    const fetcher: typeof fetch = (input) => {
      const url = requestUrl(input);
      requested.push(url);
      if (url === apiUrl) {
        return Promise.resolve(
          releaseResponse([
            { name: "portable-release-candidate.json", url: candidateUrl },
            { name: "update.bundle.tgz", url: artifactUrl },
            {
              name: "windows-portable-qualification-evidence.json",
              url: evidenceUrl,
            },
          ]),
        );
      }
      if (url === candidateUrl) {
        return Promise.resolve(
          responseAt(candidateUrl, JSON.stringify(candidate), { status: 200 }),
        );
      }
      if (url === artifactUrl) {
        return Promise.resolve(responseAt(artifactUrl, artifact, { status: 200 }));
      }
      if (url === evidenceUrl) {
        return Promise.resolve(
          responseAt(evidenceUrl, JSON.stringify(qualificationEvidence), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    };

    await expect(
      discoverGithubUpdate(
        { currentVersion: "0.1.0-dev.1", channel: "developer-preview" },
        fetcher,
      ),
    ).resolves.toEqual({
      status: "AVAILABLE",
      candidate,
      artifact: new Uint8Array(artifact),
      qualificationEvidence,
      releasePage: "https://github.com/hunterzheng1/hunter-pi/releases/tag/v0.1.0-dev.2",
    });
    expect(requested).toEqual([apiUrl, candidateUrl, artifactUrl, evidenceUrl]);
  });

  it("reports CURRENT without downloading assets when no newer preview exists", async () => {
    const fetcher: typeof fetch = (input) => {
      expect(requestUrl(input)).toBe(apiUrl);
      return Promise.resolve(
        responseAt(
          apiUrl,
          JSON.stringify([
            {
              tag_name: "v0.1.0-dev.1",
              html_url: "https://github.com/hunterzheng1/hunter-pi/releases/tag/v0.1.0-dev.1",
              draft: false,
              prerelease: true,
              assets: [],
            },
          ]),
          { status: 200 },
        ),
      );
    };

    await expect(
      discoverGithubUpdate(
        { currentVersion: "0.1.0-dev.1", channel: "developer-preview" },
        fetcher,
      ),
    ).resolves.toEqual({ status: "CURRENT", currentVersion: "0.1.0-dev.1" });
  });

  it("fails closed when the newest release omits required update assets", async () => {
    const fetcher: typeof fetch = () =>
      Promise.resolve(
        releaseResponse([{ name: "portable-release-candidate.json", url: candidateUrl }]),
      );

    await expect(
      discoverGithubUpdate(
        { currentVersion: "0.1.0-dev.1", channel: "developer-preview" },
        fetcher,
      ),
    ).rejects.toThrow(/required update assets/iu);
  });

  it("classifies a failed artifact response as a bounded download failure", async () => {
    const fetcher: typeof fetch = (input) => {
      const url = requestUrl(input);
      if (url === apiUrl) {
        return Promise.resolve(
          releaseResponse([
            { name: "portable-release-candidate.json", url: candidateUrl },
            { name: "update.bundle.tgz", url: artifactUrl },
            {
              name: "windows-portable-qualification-evidence.json",
              url: evidenceUrl,
            },
          ]),
        );
      }
      if (url === candidateUrl) {
        return Promise.resolve(
          responseAt(candidateUrl, JSON.stringify(candidate), { status: 200 }),
        );
      }
      return Promise.resolve(responseAt(artifactUrl, null, { status: 503 }));
    };

    const result = discoverGithubUpdate(
      { currentVersion: "0.1.0-dev.1", channel: "developer-preview" },
      fetcher,
    );
    await expect(result).rejects.toBeInstanceOf(HpiUpdateDiscoveryError);
    await expect(result).rejects.toMatchObject({ stage: "DOWNLOAD", host: "github.com" });
  });

  it("rejects candidate metadata that does not bind the selected release tag", async () => {
    const mismatched = { ...candidate, productVersion: "0.1.0-dev.3" };
    const fetcher: typeof fetch = (input) => {
      const url = requestUrl(input);
      if (url === apiUrl) {
        return Promise.resolve(
          releaseResponse([
            { name: "portable-release-candidate.json", url: candidateUrl },
            { name: "update.bundle.tgz", url: artifactUrl },
            {
              name: "windows-portable-qualification-evidence.json",
              url: evidenceUrl,
            },
          ]),
        );
      }
      if (url === candidateUrl) {
        return Promise.resolve(
          responseAt(candidateUrl, JSON.stringify(mismatched), { status: 200 }),
        );
      }
      return Promise.resolve(responseAt(artifactUrl, artifact, { status: 200 }));
    };

    await expect(
      discoverGithubUpdate(
        { currentVersion: "0.1.0-dev.1", channel: "developer-preview" },
        fetcher,
      ),
    ).rejects.toThrow(/does not match its release tag/iu);
  });

  it("rejects a candidate from a different product channel", async () => {
    const stableCandidate = { ...candidate, channel: "STABLE" };
    const fetcher: typeof fetch = (input) => {
      const url = requestUrl(input);
      if (url === apiUrl) {
        return Promise.resolve(
          releaseResponse([
            { name: "portable-release-candidate.json", url: candidateUrl },
            { name: "update.bundle.tgz", url: artifactUrl },
            { name: "windows-portable-qualification-evidence.json", url: evidenceUrl },
          ]),
        );
      }
      return Promise.resolve(
        responseAt(candidateUrl, JSON.stringify(stableCandidate), { status: 200 }),
      );
    };

    await expect(
      discoverGithubUpdate(
        { currentVersion: "0.1.0-dev.1", channel: "developer-preview" },
        fetcher,
      ),
    ).rejects.toThrow(/developer-preview channel/iu);
  });

  it("rejects a response redirected outside the official GitHub hosts", async () => {
    const fetcher: typeof fetch = () =>
      Promise.resolve(responseAt("https://attacker.example/releases", "[]", { status: 200 }));

    await expect(
      discoverGithubUpdate(
        { currentVersion: "0.1.0-dev.1", channel: "developer-preview" },
        fetcher,
      ),
    ).rejects.toMatchObject({ stage: "VALIDATION", host: "attacker.example" });
  });

  it("bounds a release-index request that never returns headers", async () => {
    const fetcher: typeof fetch = () => new Promise<Response>(() => undefined);

    await expect(
      discoverGithubUpdate(
        { currentVersion: "0.1.0-dev.1", channel: "developer-preview" },
        fetcher,
        { timeoutMs: 5 },
      ),
    ).rejects.toMatchObject({ stage: "DISCOVERY", host: "api.github.com" });
  });
});
