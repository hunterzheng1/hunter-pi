export type LeaseErrorCode =
  | "CLOCK_ROLLBACK"
  | "LEASE_EXPIRED"
  | "LEASE_NOT_FOUND"
  | "LEASE_NOT_ACTIVE"
  | "LEASE_OPERATION_CONFLICT"
  | "LEASE_OWNER_MISMATCH"
  | "LEASE_RENEWAL_NOT_MONOTONIC"
  | "LEASE_STORE_BUSY"
  | "LEASE_STORE_CORRUPT";

export class LeaseError extends Error {
  public override readonly name = "LeaseError";
  public readonly code: LeaseErrorCode;

  public constructor(code: LeaseErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
