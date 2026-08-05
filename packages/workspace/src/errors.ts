export type WorkspaceErrorCode = "WORKSPACE_DESTINATION_EXISTS";

export class WorkspaceError extends Error {
  public override readonly name = "WorkspaceError";
  public readonly code: WorkspaceErrorCode;
  public readonly preservedState: "EXISTING_TARGET_UNCHANGED";

  public constructor(
    code: WorkspaceErrorCode,
    message: string,
    preservedState: "EXISTING_TARGET_UNCHANGED",
  ) {
    super(message);
    this.code = code;
    this.preservedState = preservedState;
  }
}
