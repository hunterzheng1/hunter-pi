import {
  pilotEvidenceSchema,
  pilotExecutionPlanSchema,
  type PilotEvidence,
  type PilotExecutionPlan,
} from "./contracts.js";
import { deepFreeze } from "./immutability.js";
import { canonicalJson } from "./serialization.js";

const trustedCaptureToken = Symbol("trusted-pilot-live-capture");
const pilotRuntimeCapabilityKey = Symbol("pilot-runtime-capability-key");
const pilotRuntimeCapability = Symbol("pilot-runtime-capability");

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

/**
 * The complete Evidence shape without a caller-selectable capture provenance.
 * A production runtime supplies this draft after it has observed the pilot;
 * the finalizer is the only package boundary that adds live provenance.
 */
export type PilotEvidenceDraft = Omit<PilotEvidence, "captureProvenance">;

type PilotEvidenceCollector = () => PilotEvidenceDraft | Promise<PilotEvidenceDraft>;

export interface PilotEvidenceCaptureRuntime {
  readonly [pilotRuntimeCapabilityKey]: typeof pilotRuntimeCapability;
  readonly collectEvidence: PilotEvidenceCollector;
}

/** @internal Used by the product runtime; intentionally not re-exported from the package entry. */
export function createPilotEvidenceCaptureRuntime(
  collectEvidence: PilotEvidenceCollector,
): PilotEvidenceCaptureRuntime {
  if (typeof collectEvidence !== "function") {
    throw new PilotEvidenceCaptureError(
      "RUNTIME_INVALID",
      "pilot capture runtime must provide an Evidence collector",
    );
  }
  return Object.freeze({
    [pilotRuntimeCapabilityKey]: pilotRuntimeCapability,
    collectEvidence,
  }) as PilotEvidenceCaptureRuntime;
}

export interface PilotEvidenceCaptureFinalizerOptions {
  readonly plan: PilotExecutionPlan;
  readonly runtime: PilotEvidenceCaptureRuntime;
}

export type PilotEvidenceCaptureErrorCode =
  | "WINDOWS_REQUIRED"
  | "RUNTIME_INVALID"
  | "RUNTIME_PROVENANCE"
  | "PLAN_MISMATCH"
  | "ALREADY_CONSUMED";

export class PilotEvidenceCaptureError extends Error {
  readonly code: PilotEvidenceCaptureErrorCode;

  public constructor(code: PilotEvidenceCaptureErrorCode, message: string) {
    super(message);
    this.name = "PilotEvidenceCaptureError";
    this.code = code;
  }
}

/**
 * Performs the platform-independent, privacy-preserving Evidence validation.
 * It is kept separate so Ubuntu can exercise the exact contract without
 * pretending that an Ubuntu process is a live Windows pilot.
 * @internal Not re-exported from the package entry point.
 */
export function finalizePilotEvidenceDraft(
  plan: PilotExecutionPlan,
  draft: unknown,
): PilotEvidence {
  if (
    draft === null ||
    typeof draft !== "object" ||
    Array.isArray(draft) ||
    Object.prototype.hasOwnProperty.call(draft, "captureProvenance")
  ) {
    throw new PilotEvidenceCaptureError(
      "RUNTIME_PROVENANCE",
      "pilot runtime must not provide or choose Evidence capture provenance",
    );
  }

  let evidence: PilotEvidence;
  try {
    evidence = pilotEvidenceSchema.parse({
      ...(draft as Record<string, unknown>),
      captureProvenance: "LIVE_WINDOWS_PILOT",
    });
  } catch {
    throw new PilotEvidenceCaptureError(
      "RUNTIME_INVALID",
      "pilot capture runtime Evidence draft is invalid or contains unsupported data",
    );
  }

  if (
    evidence.planFingerprint !== plan.planFingerprint ||
    canonicalJson(evidence.operatorScope) !== canonicalJson(plan.operatorScope) ||
    canonicalJson(evidence.machine) !== canonicalJson(plan.machineProfile)
  ) {
    throw new PilotEvidenceCaptureError(
      "PLAN_MISMATCH",
      "pilot Evidence does not bind the exact frozen execution plan",
    );
  }

  return evidence;
}

/**
 * Converts one real Windows pilot runtime observation into the opaque capture
 * authority accepted by FilePilotArchiveStore. The runtime collector is
 * deliberately one-shot: a failed or completed collection cannot be replayed
 * into a second live capture with different facts.
 */
export class PilotEvidenceCaptureFinalizer {
  readonly #plan: PilotExecutionPlan;
  readonly #runtime: PilotEvidenceCaptureRuntime;
  #consumed = false;

  public constructor(options: PilotEvidenceCaptureFinalizerOptions) {
    try {
      this.#plan = deepFreeze(pilotExecutionPlanSchema.parse(options.plan));
    } catch {
      throw new PilotEvidenceCaptureError(
        "PLAN_MISMATCH",
        "pilot capture finalizer requires a valid frozen execution plan",
      );
    }
    const runtime: unknown = options.runtime;
    if (
      runtime === null ||
      typeof runtime !== "object" ||
      (runtime as { readonly [pilotRuntimeCapabilityKey]?: unknown })[pilotRuntimeCapabilityKey] !==
        pilotRuntimeCapability
    ) {
      throw new PilotEvidenceCaptureError(
        "RUNTIME_INVALID",
        "pilot capture runtime capability is invalid",
      );
    }
    this.#runtime = runtime as PilotEvidenceCaptureRuntime;
  }

  public async finalize(): Promise<TrustedPilotEvidenceCapture> {
    if (this.#consumed) {
      throw new PilotEvidenceCaptureError(
        "ALREADY_CONSUMED",
        "pilot capture finalizer has already been consumed",
      );
    }
    this.#consumed = true;
    if (process.platform !== "win32") {
      throw new PilotEvidenceCaptureError(
        "WINDOWS_REQUIRED",
        "live pilot capture finalization requires Windows",
      );
    }

    let draft: unknown;
    try {
      draft = await this.#runtime.collectEvidence();
    } catch {
      throw new PilotEvidenceCaptureError(
        "RUNTIME_INVALID",
        "pilot capture runtime did not produce a valid Evidence draft",
      );
    }
    const evidence = finalizePilotEvidenceDraft(this.#plan, draft);

    return TrustedPilotEvidenceCapture.fromRuntime(evidence, trustedCaptureToken);
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
