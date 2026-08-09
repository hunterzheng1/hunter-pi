import { z } from "zod";

const safeNonnegativeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const safeNonnegativeNumberSchema = z.number().nonnegative();

export const piProviderUsageReasonSchema = z.enum([
  "EVENT_STREAM_INCOMPLETE",
  "ASSISTANT_USAGE_MISSING",
  "ASSISTANT_USAGE_INVALID",
  "USAGE_TOTAL_MISMATCH",
  "USAGE_COST_MISMATCH",
  "PROVIDER_RETRY_POLICY_NOT_PROVEN",
  "USAGE_OVERFLOW",
]);
export type PiProviderUsageReason = z.infer<typeof piProviderUsageReasonSchema>;

export const piProviderUsageSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("PASS"),
    requestCount: safeNonnegativeIntegerSchema,
    tokenCount: safeNonnegativeIntegerSchema,
    costMinorUnits: safeNonnegativeIntegerSchema,
    reasons: z.tuple([]),
  }),
  z.strictObject({
    status: z.literal("NOT_PROVEN"),
    requestCount: z.null(),
    tokenCount: z.null(),
    costMinorUnits: z.null(),
    reasons: z.array(piProviderUsageReasonSchema).min(1),
  }),
]);
export type PiProviderUsage = z.infer<typeof piProviderUsageSchema>;

const piUsageSchema = z
  .strictObject({
    input: safeNonnegativeIntegerSchema,
    output: safeNonnegativeIntegerSchema,
    cacheRead: safeNonnegativeIntegerSchema,
    cacheWrite: safeNonnegativeIntegerSchema,
    cacheWrite1h: safeNonnegativeIntegerSchema.optional(),
    reasoning: safeNonnegativeIntegerSchema.optional(),
    totalTokens: safeNonnegativeIntegerSchema,
    cost: z.strictObject({
      input: safeNonnegativeNumberSchema,
      output: safeNonnegativeNumberSchema,
      cacheRead: safeNonnegativeNumberSchema,
      cacheWrite: safeNonnegativeNumberSchema,
      total: safeNonnegativeNumberSchema,
    }),
  })
  .superRefine((usage, context) => {
    if (usage.totalTokens !== usage.input + usage.output + usage.cacheRead + usage.cacheWrite) {
      context.addIssue({
        code: "custom",
        path: ["totalTokens"],
        message: "Pi Provider usage total does not match its token components",
      });
    }
    const componentCost =
      usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
    const tolerance = Math.max(1, Math.abs(componentCost), Math.abs(usage.cost.total)) * 1e-12;
    if (Math.abs(usage.cost.total - componentCost) > tolerance) {
      context.addIssue({
        code: "custom",
        path: ["cost", "total"],
        message: "Pi Provider usage total does not match its cost components",
      });
    }
  });

function notProven(reason: PiProviderUsageReason): PiProviderUsage {
  return piProviderUsageSchema.parse({
    status: "NOT_PROVEN",
    requestCount: null,
    tokenCount: null,
    costMinorUnits: null,
    reasons: [reason],
  });
}

function recordType(record: Record<string, unknown>): string | undefined {
  const value = Reflect.get(record, "type");
  return typeof value === "string" ? value : undefined;
}

/**
 * Accounts only final assistant message_end records. agent_end repeats messages,
 * so reading it would double count Provider requests and usage.
 */
export function accountPiProviderUsage(
  records: readonly Record<string, unknown>[],
  requestBoundary: "TRANSPORT_RETRIES_DISABLED" | "NOT_PROVEN" = "NOT_PROVEN",
): PiProviderUsage {
  if (requestBoundary !== "TRANSPORT_RETRIES_DISABLED") {
    return notProven("PROVIDER_RETRY_POLICY_NOT_PROVEN");
  }
  const terminalRecord = records.at(-1);
  if (terminalRecord === undefined || recordType(terminalRecord) !== "agent_end") {
    return notProven("EVENT_STREAM_INCOMPLETE");
  }

  const assistantMessageEnds = records.filter((record) => {
    if (recordType(record) !== "message_end") return false;
    const message = Reflect.get(record, "message");
    return (
      typeof message === "object" &&
      message !== null &&
      !Array.isArray(message) &&
      Reflect.get(message, "role") === "assistant"
    );
  });
  if (assistantMessageEnds.length === 0) {
    return notProven("ASSISTANT_USAGE_MISSING");
  }

  let tokenCount = 0;
  let cost = 0;
  for (const record of assistantMessageEnds) {
    const message = Reflect.get(record, "message") as Record<string, unknown>;
    const parsed = piUsageSchema.safeParse(Reflect.get(message, "usage"));
    if (!parsed.success) {
      const totalMismatch = parsed.error.issues.some((issue) => issue.path.includes("totalTokens"));
      const costMismatch = parsed.error.issues.some(
        (issue) => issue.path[0] === "cost" && issue.path.includes("total"),
      );
      return notProven(
        totalMismatch
          ? "USAGE_TOTAL_MISMATCH"
          : costMismatch
            ? "USAGE_COST_MISMATCH"
            : "ASSISTANT_USAGE_INVALID",
      );
    }
    tokenCount += parsed.data.totalTokens;
    cost += parsed.data.cost.total;
    if (!Number.isSafeInteger(tokenCount) || !Number.isFinite(cost)) {
      return notProven("USAGE_OVERFLOW");
    }
  }

  const costMinorUnits = Math.max(0, Math.ceil(cost * 100 - 1e-9));
  if (!Number.isSafeInteger(costMinorUnits) || costMinorUnits < 0) {
    return notProven("USAGE_OVERFLOW");
  }
  return piProviderUsageSchema.parse({
    status: "PASS",
    requestCount: assistantMessageEnds.length,
    tokenCount,
    costMinorUnits,
    reasons: [],
  });
}

export function unavailablePiProviderUsage(): PiProviderUsage {
  return notProven("EVENT_STREAM_INCOMPLETE");
}
