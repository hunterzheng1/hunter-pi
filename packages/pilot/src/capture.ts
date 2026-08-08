import { pilotEvidenceSchema, type PilotEvidence } from "./contracts.js";

const trustedCaptureToken = Symbol("trusted-pilot-live-capture");

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

/**
 * An opaque hand-off from the real capture runtime to Archive persistence.
 * The constructor token is intentionally module-private; raw Evidence cannot
 * be relabeled as a live capture by callers of the public pilot package.
 */
export class TrustedPilotEvidenceCapture {
  readonly #evidence: PilotEvidence;

  private constructor(evidence: PilotEvidence, token: symbol) {
    if (token !== trustedCaptureToken) throw new Error("pilot capture authority is invalid");
    this.#evidence = deepFreeze(pilotEvidenceSchema.parse(evidence));
    Object.freeze(this);
  }

  public static fromRuntime(evidence: PilotEvidence, token: symbol): TrustedPilotEvidenceCapture {
    return new TrustedPilotEvidenceCapture(evidence, token);
  }

  public get evidence(): PilotEvidence {
    return this.#evidence;
  }
}

/** @internal Source-level test support; not re-exported from the package entry point. */
export function createTestPilotEvidenceCapture(
  evidence: PilotEvidence,
): TrustedPilotEvidenceCapture {
  if (evidence.captureProvenance !== "LIVE_WINDOWS_PILOT") {
    throw new Error("test pilot capture authority requires live-labeled Evidence");
  }
  return TrustedPilotEvidenceCapture.fromRuntime(evidence, trustedCaptureToken);
}
