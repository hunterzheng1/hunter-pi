export type HpiPluginOperationErrorCode =
  | "SOURCE_INVALID"
  | "SOURCE_CHANGED"
  | "SRI_MISMATCH"
  | "RESOURCE_LIMIT"
  | "INSTALL_TIMEOUT"
  | "INSTALL_FAILED"
  | "JOURNAL_INCOMPATIBLE"
  | "BINDING_TAMPERED";

const NEXT_ACTIONS: Readonly<Record<HpiPluginOperationErrorCode, string>> = {
  SOURCE_INVALID: "Use an exact documented LOCAL, NPM, GIT, or PI source and retry.",
  SOURCE_CHANGED: "Reinspect the source, approve its new exact fingerprint, and retry.",
  SRI_MISMATCH: "Obtain the exact registry SRI for the approved package version and retry.",
  RESOURCE_LIMIT: "Reduce the package size or dependency tree, then retry the clean install.",
  INSTALL_TIMEOUT: "Check network and registry availability, then retry the clean install.",
  INSTALL_FAILED: "Run `hpi plugin doctor`, repair the reported prerequisite, and retry.",
  JOURNAL_INCOMPATIBLE:
    "Run `hpi plugin doctor`; preserve the journal and restore a compatible Hunter Pi version if needed.",
  BINDING_TAMPERED:
    "Disable or remove the Plugin, then reinstall it from an approved exact source.",
};

export class HpiPluginOperationError extends Error {
  public readonly code: HpiPluginOperationErrorCode;
  public readonly nextAction: string;

  public constructor(code: HpiPluginOperationErrorCode, options?: { readonly cause?: unknown }) {
    super(`Plugin operation blocked: ${code}`, options);
    this.name = "HpiPluginOperationError";
    this.code = code;
    this.nextAction = NEXT_ACTIONS[code];
  }
}

export function hpiPluginOperationError(
  code: HpiPluginOperationErrorCode,
  cause?: unknown,
): HpiPluginOperationError {
  return new HpiPluginOperationError(code, cause === undefined ? undefined : { cause });
}
