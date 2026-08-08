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

const structuredCredentialKeyPattern =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|access[_-]?token|api[_-]?key|apikey|auth|key|client[_-]?secret|password|secret|token)$/iu;
const redactedCredentialJson = JSON.stringify("[REDACTED:CREDENTIAL]");
const maximumEncodedJsonLayers = 8;

interface JsonDocumentRedaction {
  readonly fieldsRemoved: number;
  readonly parsed: boolean;
  readonly text: string;
}

function redactJsonDocument(text: string, encodedLayer = 0): JsonDocumentRedaction {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { fieldsRemoved: 0, parsed: false, text };
  }
  if (typeof value === "string" && encodedLayer >= maximumEncodedJsonLayers) {
    return { fieldsRemoved: 1, parsed: true, text: redactedCredentialJson };
  }
  if (typeof value === "string") {
    const nested = redactJsonDocument(value, encodedLayer + 1);
    const embedded =
      nested.fieldsRemoved === 0 && !nested.parsed
        ? redactEmbeddedJsonDocuments(value, encodedLayer + 1)
        : nested;
    if (embedded.fieldsRemoved > 0) {
      return {
        fieldsRemoved: embedded.fieldsRemoved,
        parsed: true,
        text: JSON.stringify(embedded.text),
      };
    }
  }
  if (typeof value !== "object" || value === null) {
    return { fieldsRemoved: 0, parsed: true, text };
  }

  let fieldsRemoved = 0;
  let replacementSequence = 0;
  const pending: object[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    for (const [key, nested] of Object.entries(current) as [string, unknown][]) {
      if (structuredCredentialKeyPattern.test(key)) {
        Reflect.deleteProperty(current, key);
        fieldsRemoved += 1;
        let replacementKey: string;
        do {
          replacementSequence += 1;
          replacementKey = `redactedField${String(replacementSequence)}`;
        } while (Object.hasOwn(current, replacementKey));
        Reflect.set(current, replacementKey, "[REDACTED:CREDENTIAL]");
      } else if (typeof nested === "object" && nested !== null) {
        pending.push(nested);
      }
    }
  }
  if (fieldsRemoved === 0) return { fieldsRemoved, parsed: true, text };
  try {
    return { fieldsRemoved, parsed: true, text: JSON.stringify(value) };
  } catch {
    return { fieldsRemoved, parsed: true, text: redactedCredentialJson };
  }
}

function jsonContainerEnd(text: string, start: number): number | undefined {
  const opening = text[start];
  if (opening !== "{" && opening !== "[") return undefined;
  const stack: string[] = [opening];
  let escaped = false;
  let inString = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{" || character === "[") {
      stack.push(character);
    } else if (character === "}" || character === "]") {
      const expectedOpening = character === "}" ? "{" : "[";
      if (stack.pop() !== expectedOpening) return undefined;
      if (stack.length === 0) return index;
    }
  }
  return undefined;
}

function redactEmbeddedJsonDocuments(text: string, encodedLayer = 0): JsonDocumentRedaction {
  let cursor = 0;
  let fieldsRemoved = 0;
  let output = "";
  let scan = 0;
  while (scan < text.length) {
    const objectStart = text.indexOf("{", scan);
    const arrayStart = text.indexOf("[", scan);
    const start =
      objectStart === -1
        ? arrayStart
        : arrayStart === -1
          ? objectStart
          : Math.min(objectStart, arrayStart);
    if (start === -1) break;
    const end = jsonContainerEnd(text, start);
    if (end === undefined) {
      scan = start + 1;
      continue;
    }
    const redacted = redactJsonDocument(text.slice(start, end + 1), encodedLayer);
    if (redacted.fieldsRemoved > 0) {
      output += `${text.slice(cursor, start)}${redacted.text}`;
      cursor = end + 1;
      fieldsRemoved += redacted.fieldsRemoved;
      scan = cursor;
    } else {
      scan = redacted.parsed ? end + 1 : start + 1;
    }
  }
  return {
    fieldsRemoved,
    parsed: false,
    text: fieldsRemoved === 0 ? text : `${output}${text.slice(cursor)}`,
  };
}

function redactStructuredCredentialJson(result: MutableRedactionResult): void {
  const wholeDocument = redactJsonDocument(result.text);
  if (wholeDocument.fieldsRemoved > 0) {
    result.text = wholeDocument.text;
    result.fieldsRemoved += wholeDocument.fieldsRemoved;
    result.categories.add("CREDENTIAL");
    return;
  }

  const embeddedDocuments = redactEmbeddedJsonDocuments(result.text);
  if (embeddedDocuments.fieldsRemoved > 0) result.text = embeddedDocuments.text;
  let fieldsRemoved = embeddedDocuments.fieldsRemoved;
  result.text = result.text
    .split("\n")
    .map((line) => {
      const leadingLength = line.length - line.trimStart().length;
      const trailingLength = line.length - line.trimEnd().length;
      const end = trailingLength === 0 ? line.length : line.length - trailingLength;
      const candidate = line.slice(leadingLength, end);
      if (candidate.length === 0) return line;
      const document = redactJsonDocument(candidate);
      const redacted =
        document.fieldsRemoved === 0 && !document.parsed
          ? redactEmbeddedJsonDocuments(candidate)
          : document;
      fieldsRemoved += redacted.fieldsRemoved;
      return `${line.slice(0, leadingLength)}${redacted.text}${line.slice(end)}`;
    })
    .join("\n");
  if (fieldsRemoved > 0) {
    result.fieldsRemoved += fieldsRemoved;
    result.categories.add("CREDENTIAL");
  }
}

function redactText(text: string, policy: PortableEvidencePolicy): RedactionResult {
  const result: MutableRedactionResult = {
    text,
    fieldsRemoved: 0,
    categories: new Set<RedactionCategory>(),
  };

  redactStructuredCredentialJson(result);

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
    /"(?:authorization|proxy-authorization|cookie|set-cookie|access[_-]?token|api[_-]?key|apikey|client[_-]?secret|password|secret|token)"\s*:\s*"(?:\\(?:["\\/bfnrt]|u[0-9a-f]{4})|[^"\\\r\n])*"/giu,
    "[REDACTED:CREDENTIAL]",
    "CREDENTIAL",
  );
  replacePattern(
    result,
    /'(?:authorization|proxy-authorization|cookie|set-cookie|access[_-]?token|api[_-]?key|apikey|client[_-]?secret|password|secret|token)'\s*:\s*'(?:\\(?:['\\/bfnrt]|u[0-9a-f]{4})|[^'\\\r\n])*'/giu,
    "[REDACTED:CREDENTIAL]",
    "CREDENTIAL",
  );

  replacePattern(
    result,
    /(?:["'])?\b(?:authorization|proxy-authorization)\b(?:["'])?\s*:\s*[^\r\n]+/giu,
    "Authorization: [REDACTED:CREDENTIAL]",
    "CREDENTIAL",
  );
  replacePattern(
    result,
    /(?:["'])?\b(?:cookie|set-cookie)\b(?:["'])?\s*:\s*[^\r\n]+/giu,
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
    /(?:["'])?\b(?:access[_-]?token|api[_-]?key|apikey|client[_-]?secret|password|secret|token)\b(?:["'])?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/giu,
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
