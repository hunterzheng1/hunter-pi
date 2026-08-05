import { z } from "zod";

import { fingerprintSchema, timestampSchema, type Fingerprint } from "@hunter-pi/domain";

import { processContainmentSchema, type ProcessContainment } from "./process-contracts.js";

export const driverSnapshotSchema = z.strictObject({
  phase: z.enum(["RUNNING", "EXITED", "TERMINATING", "TERMINAL", "UNRECONCILED"]),
  exitCode: z.number().int().nullable(),
  terminationCause: z.enum(["NONE", "CANCEL", "TIMEOUT"]),
  identityState: z.enum(["MATCH", "MISMATCH", "NOT_PROVEN"]),
  treeState: z.enum(["ACTIVE", "EMPTY", "NOT_PROVEN"]),
  stdoutState: z.enum(["OPEN", "CLOSED", "NOT_PROVEN"]),
  stderrState: z.enum(["OPEN", "CLOSED", "NOT_PROVEN"]),
  observedAt: timestampSchema,
});
export type DriverSnapshot = z.infer<typeof driverSnapshotSchema>;

export const driverCancelResultSchema = z.strictObject({
  outcome: z.enum(["ACKNOWLEDGED", "IDENTITY_MISMATCH", "NOT_PROVEN"]),
});
export type DriverCancelResult = z.infer<typeof driverCancelResultSchema>;

export interface ManagedProcessDriverStartRequest {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly onOutput: (stream: "STDOUT" | "STDERR", chunk: Buffer) => void;
}

export interface ManagedProcessDriverSession {
  readonly identityFingerprint: Fingerprint;
  readonly containment: ProcessContainment;
  snapshot(): Promise<DriverSnapshot>;
  cancel(
    expectedIdentity: Fingerprint,
    reason: "USER_REQUEST" | "POLICY" | "TIMEOUT",
  ): Promise<DriverCancelResult>;
  waitForSettlement(): Promise<DriverSnapshot>;
}

export interface ManagedProcessDriver {
  start(request: ManagedProcessDriverStartRequest): Promise<ManagedProcessDriverSession>;
}

export function parseDriverIdentity(value: unknown): Fingerprint {
  return fingerprintSchema.parse(value);
}

export function parseProcessContainment(value: unknown): ProcessContainment {
  return processContainmentSchema.parse(value);
}
