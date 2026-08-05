import { createHash } from "node:crypto";

import { z } from "zod";

import {
  evidenceContentClassSchema,
  evidenceEnvelopeSchema,
  evidenceIdSchema,
  evidenceKindSchema,
  evidenceScopeSchema,
  fingerprintSchema,
  maxEvidenceCaptureBytes,
  schemaVersionSchema,
  timestampSchema,
  type EvidenceEnvelope,
  type RedactionCategory,
} from "@hunter-pi/domain";

export const portableEvidenceRequestSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  evidenceId: evidenceIdSchema,
  kind: evidenceKindSchema,
  scope: evidenceScopeSchema,
  createdAt: timestampSchema,
  sourceFingerprint: fingerprintSchema,
  summary: z.string().trim().min(1).max(4_096),
  contentClass: evidenceContentClassSchema,
  content: z.string(),
});
export type PortableEvidenceRequest = z.input<typeof portableEvidenceRequestSchema>;

export interface PortableEvidencePolicy {
  readonly maxCaptureBytes?: number;
  readonly sensitiveValues?: readonly string[];
  readonly privatePathRoots?: readonly string[];
  readonly privatePromptValues?: readonly string[];
}

interface RedactionResult {
  readonly text: string;
  readonly fieldsRemoved: number;
  readonly categories: ReadonlySet<RedactionCategory>;
}

interface MutableRedactionResult {
  text: string;
  fieldsRemoved: number;
  readonly categories: Set<RedactionCategory>;
}

export interface PortableTextRedaction {
  readonly text: string;
  readonly fieldsRemoved: number;
  readonly categories: readonly RedactionCategory[];
}

const forbiddenDigestOnlyClasses = new Set([
  "PRIVATE_PROMPT",
  "ENVIRONMENT_DUMP",
  "CREDENTIAL_MATERIAL",
]);

function encodedVariants(value: string): readonly string[] {
  if (value.length === 0) {
    return [];
  }
  const bytes = Buffer.from(value, "utf8");
  return [
    value,
    encodeURIComponent(value),
    bytes.toString("base64"),
    bytes.toString("base64url"),
    bytes.toString("hex"),
  ];
}

function replaceLiteral(
  result: MutableRedactionResult,
  literal: string,
  replacement: string,
  category: RedactionCategory,
): void {
  if (literal.length === 0 || !result.text.includes(literal)) {
    return;
  }
  const parts = result.text.split(literal);
  result.fieldsRemoved += parts.length - 1;
  result.text = parts.join(replacement);
  result.categories.add(category);
}

function replacePattern(
  result: MutableRedactionResult,
  pattern: RegExp,
  replacement: string,
  category: RedactionCategory,
): void {
  result.text = result.text.replace(pattern, () => {
    result.fieldsRemoved += 1;
    result.categories.add(category);
    return replacement;
  });
}

function redactText(text: string, policy: PortableEvidencePolicy): RedactionResult {
  const result: MutableRedactionResult = {
    text,
    fieldsRemoved: 0,
    categories: new Set<RedactionCategory>(),
  };

  for (const value of policy.privatePromptValues ?? []) {
    for (const variant of encodedVariants(value)) {
      replaceLiteral(result, variant, "[REDACTED:PRIVATE_PROMPT]", "PRIVATE_PROMPT");
    }
  }
  for (const root of policy.privatePathRoots ?? []) {
    for (const variant of encodedVariants(root)) {
      replaceLiteral(result, variant, "[REDACTED:PRIVATE_PATH]", "PRIVATE_PATH");
    }
  }
  for (const value of policy.sensitiveValues ?? []) {
    for (const variant of encodedVariants(value)) {
      replaceLiteral(result, variant, "[REDACTED:CREDENTIAL]", "CREDENTIAL");
    }
  }

  replacePattern(
    result,
    /\b(?:authorization|proxy-authorization)\s*:\s*[^\r\n]+/giu,
    "Authorization: [REDACTED:CREDENTIAL]",
    "CREDENTIAL",
  );
  replacePattern(
    result,
    /\b(?:cookie|set-cookie)\s*:\s*[^\r\n]+/giu,
    "Cookie: [REDACTED:CREDENTIAL]",
    "CREDENTIAL",
  );
  replacePattern(
    result,
    /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/giu,
    "[REDACTED:CREDENTIAL]",
    "CREDENTIAL",
  );
  replacePattern(
    result,
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b/gu,
    "[REDACTED:CREDENTIAL]",
    "CREDENTIAL",
  );
  replacePattern(
    result,
    /https?:\/\/[^/\s:@]+:[^/\s@]+@/giu,
    "https://[REDACTED:CREDENTIAL]@",
    "CREDENTIAL",
  );
  replacePattern(
    result,
    /[?&](?:access_token|api_key|apikey|auth|key|password|secret|token)=[^&#\s]+/giu,
    "?[REDACTED:SENSITIVE_QUERY]",
    "SENSITIVE_QUERY",
  );
  replacePattern(
    result,
    /\b(?:access[_-]?token|api[_-]?key|apikey|client[_-]?secret|password|secret|token)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/giu,
    "[REDACTED:CREDENTIAL]",
    "CREDENTIAL",
  );
  replacePattern(
    result,
    /(?<!\S)[A-Z][A-Z0-9_]{1,63}=(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;]+)/gu,
    "[REDACTED:ENVIRONMENT_DUMP]",
    "ENVIRONMENT_DUMP",
  );
  replacePattern(
    result,
    /\bprompt\s*=\s*[^\r\n]+/giu,
    "prompt=[REDACTED:PRIVATE_PROMPT]",
    "PRIVATE_PROMPT",
  );
  replacePattern(
    result,
    /[A-Za-z]:\\Users\\[^\\/\r\n]+/gu,
    "[REDACTED:PRIVATE_PATH]",
    "PRIVATE_PATH",
  );
  replacePattern(
    result,
    /[A-Za-z]:\\(?:Temp|tmp)(?=\\|$)/giu,
    "[REDACTED:PRIVATE_PATH]",
    "PRIVATE_PATH",
  );
  replacePattern(result, /\/(?:home|Users)\/[^/\s]+/gu, "[REDACTED:PRIVATE_PATH]", "PRIVATE_PATH");
  replacePattern(result, /\/tmp(?:\/[^/\s]+)?/gu, "[REDACTED:PRIVATE_PATH]", "PRIVATE_PATH");
  replacePattern(
    result,
    /\\\\[^\\\r\n"'<>|]+\\[^\\\r\n"'<>|]+(?:\\[^\\\r\n"'<>|]+)*/gu,
    "[REDACTED:PRIVATE_PATH]",
    "PRIVATE_PATH",
  );
  replacePattern(result, /\b[A-Za-z]:\\[^\r\n"'<>|]+/gu, "[REDACTED:PRIVATE_PATH]", "PRIVATE_PATH");
  replacePattern(
    result,
    /(?<![-A-Za-z0-9._\\])\\(?:[^\\\r\n"'<>|]+\\)*[^\\\r\n"'<>|]+/gu,
    "[REDACTED:PRIVATE_PATH]",
    "PRIVATE_PATH",
  );
  replacePattern(
    result,
    /(?<![A-Za-z0-9:])\/(?:[^/\s"'<>|]+\/)*[^/\s"'<>|]+/gu,
    "[REDACTED:PRIVATE_PATH]",
    "PRIVATE_PATH",
  );

  return result;
}

export function redactPortableText(
  text: string,
  policy: PortableEvidencePolicy = {},
): PortableTextRedaction {
  const result = redactText(text, policy);
  return {
    text: result.text,
    fieldsRemoved: result.fieldsRemoved,
    categories: [...result.categories].sort(),
  };
}

function mergeRedactions(...results: readonly RedactionResult[]) {
  const categories = new Set<RedactionCategory>();
  let fieldsRemoved = 0;
  for (const result of results) {
    fieldsRemoved += result.fieldsRemoved;
    for (const category of result.categories) {
      categories.add(category);
    }
  }
  return { categories: [...categories].sort(), fieldsRemoved };
}

function forbiddenClassCategory(contentClass: string): RedactionCategory {
  return contentClass === "PRIVATE_PROMPT"
    ? "PRIVATE_PROMPT"
    : contentClass === "ENVIRONMENT_DUMP"
      ? "ENVIRONMENT_DUMP"
      : "CREDENTIAL";
}

function utf8Prefix(
  bytes: Buffer,
  limit: number,
): { readonly bytes: Buffer; readonly text: string } {
  let end = Math.min(bytes.byteLength, limit);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (end > 0) {
    try {
      const prefix = bytes.subarray(0, end);
      return { bytes: prefix, text: decoder.decode(prefix) };
    } catch {
      end -= 1;
    }
  }
  return { bytes: Buffer.alloc(0), text: "" };
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function createPortableEvidenceEnvelope(
  request: PortableEvidenceRequest,
  policy: PortableEvidencePolicy = {},
): EvidenceEnvelope {
  const parsed = portableEvidenceRequestSchema.parse(request);
  const maxCaptureBytes = policy.maxCaptureBytes ?? maxEvidenceCaptureBytes;
  if (
    !Number.isInteger(maxCaptureBytes) ||
    maxCaptureBytes <= 0 ||
    maxCaptureBytes > maxEvidenceCaptureBytes
  ) {
    throw new RangeError(
      `maxCaptureBytes must be between 1 and ${maxEvidenceCaptureBytes.toString()}`,
    );
  }

  const digestOnly = forbiddenDigestOnlyClasses.has(parsed.contentClass);
  const forbiddenCategory = forbiddenClassCategory(parsed.contentClass);
  const summary = digestOnly
    ? {
        text: `${parsed.contentClass} content retained as digest-only Evidence.`,
        fieldsRemoved: 1,
        categories: new Set<RedactionCategory>([forbiddenCategory]),
      }
    : redactText(parsed.summary, policy);
  const content = digestOnly
    ? {
        text: `[REDACTED:${parsed.contentClass}]`,
        fieldsRemoved: 1,
        categories: new Set<RedactionCategory>([forbiddenCategory]),
      }
    : redactText(parsed.content, policy);
  const redaction = mergeRedactions(summary, content);
  const fullBytes = Buffer.from(content.text, "utf8");
  const totalBytes = digestOnly ? Buffer.byteLength(parsed.content, "utf8") : fullBytes.byteLength;
  const prefix = utf8Prefix(fullBytes, maxCaptureBytes);
  const truncated = !digestOnly && prefix.bytes.byteLength < fullBytes.byteLength;
  const retentionStatus = digestOnly ? "DIGEST_ONLY" : truncated ? "TRUNCATED" : "RETAINED";

  return evidenceEnvelopeSchema.parse({
    schemaVersion: "1.0.0",
    evidenceId: parsed.evidenceId,
    kind: parsed.kind,
    scope: parsed.scope,
    createdAt: parsed.createdAt,
    sourceFingerprint: parsed.sourceFingerprint,
    contentClass: parsed.contentClass,
    contentHash: sha256(digestOnly ? parsed.content : content.text),
    summary: summary.text,
    capture: {
      mediaType: "text/plain; charset=utf-8",
      retentionStatus,
      ...(!digestOnly && { capturedText: prefix.text }),
      capturedBytes: digestOnly ? 0 : prefix.bytes.byteLength,
      totalBytes,
      truncated,
      cursor: {
        startByte: 0,
        endByte: digestOnly ? 0 : prefix.bytes.byteLength,
        ...(truncated && { nextByte: prefix.bytes.byteLength }),
      },
    },
    redaction: {
      version: "hunter-redaction/1",
      applied: redaction.fieldsRemoved > 0,
      fieldsRemoved: redaction.fieldsRemoved,
      categories: redaction.categories,
    },
  });
}
