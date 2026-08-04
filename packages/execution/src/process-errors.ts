export type ManagedProcessErrorCode =
  | "PROCESS_CWD_INVALID"
  | "PROCESS_LEASE_INVALID"
  | "PROCESS_LOG_CURSOR_INVALID"
  | "PROCESS_OPERATION_CONFLICT"
  | "PROCESS_PLATFORM_START_FAILED"
  | "PROCESS_PLATFORM_UNAVAILABLE"
  | "PROCESS_SESSION_CONFLICT"
  | "PROCESS_SESSION_NOT_FOUND";

export class ManagedProcessError extends Error {
  public override readonly name = "ManagedProcessError";
  public readonly code: ManagedProcessErrorCode;

  public constructor(code: ManagedProcessErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.code = code;
  }
}
