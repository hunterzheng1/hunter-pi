import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { evidenceEnvelopeSchema } from "@hunter-pi/domain";
import { createPortableEvidenceEnvelope, type PortableEvidencePolicy } from "@hunter-pi/evidence";

const timestamp = "2026-08-03T00:00:00.000Z";
const sourceFingerprint = `sha256:${"a".repeat(64)}` as const;

const baseRequest = {
  schemaVersion: "1.0.0" as const,
  evidenceId: "evidence_redaction",
  kind: "observation" as const,
  scope: {
    runId: "run_redaction",
    attemptId: "att_redaction",
  },
  createdAt: timestamp,
  sourceFingerprint,
  summary: "A bounded fixture log was captured.",
  contentClass: "LOG" as const,
  content: "fixture output",
};

describe("portable Evidence capture and redaction", () => {
  it("creates a strict, run-scoped, hash-bound Evidence envelope", () => {
    const envelope = createPortableEvidenceEnvelope(baseRequest);

    expect(evidenceEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(envelope.scope).toEqual({
      runId: "run_redaction",
      attemptId: "att_redaction",
    });
    expect(envelope.capture).toMatchObject({
      retentionStatus: "RETAINED",
      capturedText: "fixture output",
      capturedBytes: 14,
      totalBytes: 14,
      truncated: false,
      cursor: { startByte: 0, endByte: 14 },
    });
    expect(
      evidenceEnvelopeSchema.safeParse({ ...envelope, providerSessionId: "private" }).success,
    ).toBe(false);
  });

  it("retains a valid UTF-8 prefix and hashes the full redacted stream when bounded", () => {
    const content = "1234567890汉字-tail";
    const envelope = createPortableEvidenceEnvelope(baseRequest, {
      maxCaptureBytes: 13,
    });
    const bounded = createPortableEvidenceEnvelope(
      { ...baseRequest, content },
      {
        maxCaptureBytes: 13,
      },
    );

    expect(envelope.capture.retentionStatus).toBe("TRUNCATED");
    expect(bounded.capture.retentionStatus).toBe("TRUNCATED");
    expect(Buffer.byteLength(bounded.capture.capturedText ?? "", "utf8")).toBeLessThanOrEqual(13);
    expect(bounded.capture.cursor.nextByte).toBe(bounded.capture.capturedBytes);
    expect(bounded.contentHash).toBe(
      `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
    );
  });

  it("removes fixture credentials, headers, private paths, prompts, and encoded variants", () => {
    const fixtureSecret = "sk-fixture-secret-123456789";
    const privatePrompt = "do not preserve this private fixture prompt";
    const windowsRoot = "C:\\Users\\Alice Example";
    const linuxRoot = "/home/alice-example";
    const encodedSecret = Buffer.from(fixtureSecret, "utf8").toString("base64");
    const encodedPath = encodeURIComponent(`${windowsRoot}\\project`);
    const escapedJsonSecret = "fixture-json-secret-after-escape";
    const content = [
      `Authorization: Bearer ${fixtureSecret}`,
      "Cookie: session=fixture-cookie-value",
      `raw=${fixtureSecret}`,
      `encoded=${encodedSecret}`,
      `path=${windowsRoot}\\project\\secret.txt`,
      `urlPath=${encodedPath}`,
      `linux=${linuxRoot}/repo/file.txt`,
      `prompt=${privatePrompt}`,
      "endpoint=https://user:password@example.invalid/path?token=fixture-query-secret",
      '{"access_token":"fixture-json-token"}',
      '{"cookie":"sid=fixture-json-cookie"}',
      JSON.stringify({ password: `before"${escapedJsonSecret}` }),
    ].join("\n");
    const policy: PortableEvidencePolicy = {
      sensitiveValues: [fixtureSecret],
      privatePathRoots: [windowsRoot, linuxRoot],
      privatePromptValues: [privatePrompt],
    };

    const envelope = createPortableEvidenceEnvelope(
      { ...baseRequest, summary: `${privatePrompt} at ${windowsRoot}`, content },
      policy,
    );
    const serialized = JSON.stringify(envelope);

    for (const forbidden of [
      fixtureSecret,
      privatePrompt,
      windowsRoot,
      linuxRoot,
      encodedSecret,
      encodedPath,
      "fixture-cookie-value",
      "user:password",
      "fixture-query-secret",
      "fixture-json-token",
      "fixture-json-cookie",
      escapedJsonSecret,
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(envelope.redaction.applied).toBe(true);
    expect(envelope.redaction.fieldsRemoved).toBeGreaterThan(0);
    expect(envelope.redaction.categories).toEqual(
      expect.arrayContaining(["CREDENTIAL", "PRIVATE_PATH", "PRIVATE_PROMPT"]),
    );
  });

  it("removes unregistered device-local absolute paths from portable Evidence", () => {
    const windowsPath = "D:\\Tools\\Hunter Pi\\workspace\\result.log";
    const posixPath = "/opt/hunter-pi/workspace/result.log";
    const envelope = createPortableEvidenceEnvelope({
      ...baseRequest,
      summary: `Captured ${windowsPath}`,
      content: `windows=${windowsPath}\nposix=${posixPath}`,
    });
    const serialized = JSON.stringify(envelope);
    const portableText = `${envelope.summary}\n${envelope.capture.capturedText ?? ""}`;

    expect(portableText).not.toContain(windowsPath);
    expect(portableText).not.toContain(posixPath);
    expect(serialized).not.toContain("Hunter Pi\\\\workspace");
    expect(envelope.redaction.categories).toContain("PRIVATE_PATH");
  });

  it("removes UNC and rooted Windows device paths without a caller policy", () => {
    const uncPath = "\\\\fixture-server\\private-share\\Alice\\result.log";
    const rootedPath = "\\Users\\Alice\\private\\result.log";
    const envelope = createPortableEvidenceEnvelope({
      ...baseRequest,
      summary: `Captured ${uncPath}`,
      content: `unc=${uncPath}\nrooted=${rootedPath}`,
    });
    const portableText = `${envelope.summary}\n${envelope.capture.capturedText ?? ""}`;

    expect(portableText).not.toContain(uncPath);
    expect(portableText).not.toContain(rootedPath);
    expect(envelope.redaction.categories).toContain("PRIVATE_PATH");
  });

  it.each(["PRIVATE_PROMPT", "ENVIRONMENT_DUMP", "CREDENTIAL_MATERIAL"] as const)(
    "stores %s content as digest-only metadata",
    (contentClass) => {
      const forbidden = `fixture-${contentClass}-must-not-survive`;
      const envelope = createPortableEvidenceEnvelope({
        ...baseRequest,
        evidenceId: `evidence_${contentClass.toLowerCase().replaceAll("_", "-")}`,
        summary: `Captured ${forbidden}`,
        contentClass,
        content: forbidden,
      });

      expect(envelope.capture.retentionStatus).toBe("DIGEST_ONLY");
      expect(envelope.capture.capturedText).toBeUndefined();
      expect(JSON.stringify(envelope)).not.toContain(forbidden);
      expect(envelope.summary).toBe(`${contentClass} content retained as digest-only Evidence.`);
      expect(envelope.redaction.applied).toBe(true);
    },
  );

  it("gives different forbidden content different digest-only identities", () => {
    const first = createPortableEvidenceEnvelope({
      ...baseRequest,
      contentClass: "PRIVATE_PROMPT",
      content: "first low-entropy private fixture",
    });
    const second = createPortableEvidenceEnvelope({
      ...baseRequest,
      contentClass: "PRIVATE_PROMPT",
      content: "second low-entropy private fixture",
    });

    expect(first.contentHash).not.toBe(second.contentHash);
    expect(first.capture.totalBytes).toBe(
      Buffer.byteLength("first low-entropy private fixture", "utf8"),
    );
    expect(JSON.stringify(first)).not.toContain("first low-entropy private fixture");
  });

  it("rejects internally inconsistent capture and redaction metadata", () => {
    const envelope = createPortableEvidenceEnvelope(baseRequest);

    expect(
      evidenceEnvelopeSchema.safeParse({
        ...envelope,
        capture: { ...envelope.capture, capturedBytes: 999 },
      }).success,
    ).toBe(false);
    expect(
      evidenceEnvelopeSchema.safeParse({
        ...envelope,
        redaction: { ...envelope.redaction, applied: false, fieldsRemoved: 1 },
      }).success,
    ).toBe(false);
  });
});
