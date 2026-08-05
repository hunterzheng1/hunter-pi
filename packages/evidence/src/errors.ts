export type DurableStoreErrorCode =
  | "CURSOR_CONFLICT"
  | "FAULT_INJECTED"
  | "IDENTITY_CONFLICT"
  | "INVALID_TARGET"
  | "NOT_FOUND"
  | "RESERVE_CORRUPT"
  | "RESERVE_REQUIRED"
  | "STORAGE_EXHAUSTED"
  | "STORE_BUSY"
  | "STORE_CORRUPT";

export class DurableStoreError extends Error {
  public readonly code: DurableStoreErrorCode;

  public constructor(code: DurableStoreErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DurableStoreError";
    this.code = code;
  }
}

export function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function storeErrorFrom(
  error: unknown,
  fallbackCode: DurableStoreErrorCode,
): DurableStoreError {
  if (error instanceof DurableStoreError) {
    return error;
  }
  if (isErrnoException(error) && (error.code === "ENOSPC" || error.code === "EDQUOT")) {
    return new DurableStoreError(
      "STORAGE_EXHAUSTED",
      "The durable state write ran out of reserved storage; prior state was preserved.",
      error,
    );
  }
  if (isErrnoException(error) && error.code === "EEXIST") {
    return new DurableStoreError(
      "IDENTITY_CONFLICT",
      "The immutable durable-write target already exists.",
      error,
    );
  }
  return new DurableStoreError(
    fallbackCode,
    fallbackCode === "FAULT_INJECTED"
      ? "The injected durable-write fault interrupted the operation; replay is required."
      : "The durable store rejected invalid or unreadable state.",
    error,
  );
}
