import { lstat, realpath } from "node:fs/promises";
import { posix, win32 } from "node:path";

export const HPI_CORE_EXTENSION_ID = "hunter-pi/core" as const;
export const HPI_CORE_EXTENSION_VERSION = "0.1.0-dev.0" as const;

export type HunterPermissionProfile = "SAFE" | "BALANCED" | "FULL_ACCESS";

export interface HunterToolCall {
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface HunterToolPolicyContext {
  readonly cwd: string;
  readonly permissionProfile: HunterPermissionProfile;
  readonly safeMode: boolean;
}

export type HunterToolDecision =
  | { readonly decision: "ALLOW" }
  | { readonly decision: "ASK"; readonly reason: string }
  | { readonly decision: "BLOCK"; readonly reason: string };

interface CoreExtensionContext {
  readonly cwd: string;
  readonly hasUI: boolean;
  readonly model:
    { readonly provider: string; readonly id: string; readonly baseUrl?: string } | undefined;
  shutdown(): void;
  readonly ui: {
    confirm(title: string, message: string): Promise<boolean>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setStatus(key: string, text: string | undefined): void;
    setWidget?(key: string, content: string[], options?: { placement: "aboveEditor" }): void;
  };
}

interface CoreExtensionApi {
  on(event: string, handler: (event: unknown, context: unknown) => unknown): void;
  registerCommand(
    name: string,
    options: {
      readonly description: string;
      readonly handler: (arguments_: string, context: unknown) => Promise<void> | void;
    },
  ): void;
}

function inputPath(call: HunterToolCall): string | undefined {
  const value = call.input["path"];
  return typeof value === "string" ? value : undefined;
}

function pathModuleFor(path: string) {
  return /^[a-z]:[\\/]/iu.test(path) || path.includes("\\") ? win32 : posix;
}

function pathEscapesWorkspace(cwd: string, candidate: string): boolean {
  const path = pathModuleFor(cwd);
  const resolvedCandidate = path.resolve(cwd, candidate);
  const relativeCandidate = path.relative(path.resolve(cwd), resolvedCandidate);
  return (
    relativeCandidate === ".." ||
    relativeCandidate.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeCandidate)
  );
}

function isCredentialSensitivePath(candidate: string): boolean {
  const normalized = candidate.replaceAll("\\", "/").toLowerCase();
  return [
    /(^|\/)\.env(?:\.|$)/u,
    /(^|\/)\.envrc$/u,
    /(^|\/)auth\.json$/u,
    /(^|\/)credentials?(?:\.|\/|$)/u,
    /(^|\/)(?:secrets?|tokens?|service[-_.]?accounts?|api[-_.]?keys?|access[-_.]?tokens?|refresh[-_.]?tokens?)(?:[._-][^/]*)*(?:\/|$)/u,
    /(^|\/)\.ssh(?:\/|$)/u,
    /(^|\/)\.aws(?:\/|$)/u,
    /(^|\/)\.azure(?:\/|$)/u,
    /(^|\/)\.kube\/config$/u,
    /(^|\/)\.docker\/config\.json$/u,
    /(^|\/)\.config\/gh\/hosts\.yml$/u,
    /(^|\/)\.npmrc$/u,
    /(^|\/)\.pypirc$/u,
    /(^|\/)\.netrc$/u,
    /(^|\/)_netrc$/u,
    /(^|\/)\.git-credentials$/u,
    /(^|\/)\.gitconfig$/u,
    /(^|\/)\.git\/config$/u,
    /(^|\/)\.gitmodules$/u,
    /(^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/u,
    /(^|\/)[^/]+\.(?:key|pem|p12|pfx)$/u,
  ].some((pattern) => pattern.test(normalized));
}

type HunterPathBoundary = "CONTAINED" | "LINK" | "ESCAPED" | "NOT_PROVEN";

async function inspectHunterPathBoundary(
  cwd: string,
  candidate: string,
): Promise<HunterPathBoundary> {
  const path = pathModuleFor(cwd);
  const workspace = path.resolve(cwd);
  const resolvedCandidate = path.resolve(workspace, candidate);
  const relativeCandidate = path.relative(workspace, resolvedCandidate);
  if (
    relativeCandidate === ".." ||
    relativeCandidate.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeCandidate)
  ) {
    return "ESCAPED";
  }

  try {
    let cursor = workspace;
    for (const segment of relativeCandidate.split(path.sep).filter((entry) => entry.length > 0)) {
      cursor = path.join(cursor, segment);
      try {
        const status = await lstat(cursor);
        if (status.isSymbolicLink() || (status.isFile() && status.nlink > 1)) {
          return "LINK";
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return "CONTAINED";
        }
        return "NOT_PROVEN";
      }
    }

    const canonicalWorkspace = await realpath(workspace);
    const canonicalCandidate = await realpath(resolvedCandidate);
    const canonicalRelative = path.relative(canonicalWorkspace, canonicalCandidate);
    return canonicalRelative === ".." ||
      canonicalRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(canonicalRelative)
      ? "ESCAPED"
      : "CONTAINED";
  } catch {
    return "NOT_PROVEN";
  }
}

function pathDecision(
  call: HunterToolCall,
  context: HunterToolPolicyContext,
): HunterToolDecision | undefined {
  const candidate = inputPath(call);
  if (candidate === undefined) {
    return undefined;
  }
  if (isCredentialSensitivePath(candidate)) {
    return context.safeMode
      ? { decision: "BLOCK", reason: "Safe Mode blocks credential-sensitive paths." }
      : { decision: "ASK", reason: "Tool access targets a credential-sensitive path." };
  }
  if (pathEscapesWorkspace(context.cwd, candidate)) {
    return call.toolName === "read" || call.toolName === "grep" || call.toolName === "find"
      ? { decision: "ASK", reason: "Tool access resolves outside the current repository." }
      : { decision: "BLOCK", reason: "Repository write escaped the current workspace." };
  }
  return undefined;
}

export function evaluateHunterToolCall(
  call: HunterToolCall,
  context: HunterToolPolicyContext,
): HunterToolDecision {
  const fileDecision = pathDecision(call, context);
  if (fileDecision !== undefined) {
    return fileDecision;
  }

  const readOnlyTools = new Set(["read", "grep", "find", "ls"]);
  if (context.safeMode) {
    return readOnlyTools.has(call.toolName)
      ? { decision: "ALLOW" }
      : { decision: "BLOCK", reason: "Safe Mode permits only bundled read-only tools." };
  }

  if (readOnlyTools.has(call.toolName)) {
    return { decision: "ALLOW" };
  }
  if (call.toolName === "bash") {
    return {
      decision: "ASK",
      reason:
        "Shell commands run with the Hunter Pi process authority; review the exact command before execution.",
    };
  }
  if (call.toolName === "write" || call.toolName === "edit") {
    return context.permissionProfile === "SAFE"
      ? {
          decision: "ASK",
          reason: "Safe permission profile requires confirmation for repository writes.",
        }
      : { decision: "ALLOW" };
  }
  return {
    decision: "ASK",
    reason: "An unclassified tool requires explicit confirmation in this developer preview.",
  };
}

export async function evaluateHunterToolCallWithFilesystem(
  call: HunterToolCall,
  context: HunterToolPolicyContext,
): Promise<HunterToolDecision> {
  const decision = evaluateHunterToolCall(call, context);
  const candidate = inputPath(call);
  if (decision.decision === "BLOCK" || candidate === undefined) {
    return decision;
  }

  const boundary = await inspectHunterPathBoundary(context.cwd, candidate);
  if (boundary === "CONTAINED") {
    return decision;
  }

  const reason =
    boundary === "LINK"
      ? "Repository file access traverses a symbolic link, junction, or hard link."
      : boundary === "ESCAPED"
        ? "Repository file access resolves outside the current workspace."
        : "Repository file access boundary could not be proven.";
  const readOnlyTools = new Set(["read", "grep", "find", "ls"]);
  return context.safeMode || !readOnlyTools.has(call.toolName)
    ? { decision: "BLOCK", reason }
    : { decision: "ASK", reason };
}

function environmentFlag(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): boolean {
  return environment[name] === "1";
}

function permissionProfile(
  environment: Readonly<Record<string, string | undefined>>,
): HunterPermissionProfile {
  const value = environment["HUNTER_PI_PERMISSION_PROFILE"];
  return value === "SAFE" || value === "FULL_ACCESS" ? value : "BALANCED";
}

export function createHunterCoreExtension(
  options: {
    readonly environment?: Readonly<Record<string, string | undefined>>;
  } = {},
): (api: CoreExtensionApi) => void {
  const environment = options.environment ?? process.env;
  const mode = environment["HUNTER_PI_MODE"] === "LOGIN" ? "LOGIN" : "QUICK";
  const profile = permissionProfile(environment);
  const safeMode = environmentFlag(environment, "HUNTER_PI_SAFE_MODE");
  const blockPromptInput = environmentFlag(environment, "HUNTER_PI_BLOCK_PROMPT_INPUT");
  const pinnedProvider = environment["HUNTER_PI_PINNED_PROVIDER"];
  const pinnedModel = environment["HUNTER_PI_PINNED_MODEL"];
  const pinnedOrigin = environment["HUNTER_PI_PINNED_ORIGIN"];
  const credentialBoundary = "CredentialGuard=NAMED_PATHS_ONLY ContentDetection=NOT_PROVEN";
  const status = `${mode}/${profile} Core=UNVERIFIED Trust=BUNDLED Isolation=PROCESS_AUTHORITY PromptInput=${blockPromptInput ? "BLOCKED" : "ENABLED"} ProviderRequests=NOT_PROVEN ${credentialBoundary}`;
  const header = environment["HUNTER_PI_HEADER"];

  return (api: CoreExtensionApi): void => {
    let terminationRequested = false;
    const selectedModelMatches = (
      model:
        { readonly provider: string; readonly id: string; readonly baseUrl?: string } | undefined,
    ): boolean => {
      let selectedOrigin: string | undefined;
      try {
        selectedOrigin = model?.baseUrl === undefined ? undefined : new URL(model.baseUrl).origin;
      } catch {
        return false;
      }
      return (
        pinnedProvider !== undefined &&
        pinnedModel !== undefined &&
        pinnedOrigin !== undefined &&
        model?.provider === pinnedProvider &&
        model.id === pinnedModel &&
        selectedOrigin === pinnedOrigin
      );
    };
    const terminateForModelDrift = (context: CoreExtensionContext): void => {
      if (!terminationRequested) {
        terminationRequested = true;
        try {
          context.shutdown();
        } catch {
          // Input and direct-shell handlers still return a blocking result below.
        }
      }
      try {
        context.ui.notify(
          "Hunter Pi model selection changed outside the acknowledged Provider/model scope; the session is closing.",
          "error",
        );
      } catch {
        // Notification is best-effort and must never weaken the gate.
      }
    };
    const blockedBashResult = () => ({
      result: {
        output: "Hunter Pi blocked direct shell execution in Safe Mode.\n",
        exitCode: 126,
        cancelled: true,
        truncated: false,
      },
    });

    api.on("model_select", (rawEvent, rawContext) => {
      const event = rawEvent as {
        readonly model?: {
          readonly provider: string;
          readonly id: string;
          readonly baseUrl?: string;
        };
      };
      const context = rawContext as CoreExtensionContext;
      if (!selectedModelMatches(event.model)) terminateForModelDrift(context);
    });

    api.on("input", (_rawEvent, rawContext) => {
      const context = rawContext as CoreExtensionContext;
      if (!selectedModelMatches(context.model)) {
        terminateForModelDrift(context);
        return { action: "handled" };
      }
      if (blockPromptInput) {
        try {
          context.ui.notify(
            "Provider prompts are disabled for this Hunter Pi launch mode.",
            "warning",
          );
        } catch {
          // A UI failure cannot turn a blocked prompt into an allowed prompt.
        }
        return { action: "handled" };
      }
      return undefined;
    });

    api.on("user_bash", async (_rawEvent, rawContext) => {
      const context = rawContext as CoreExtensionContext;
      if (!selectedModelMatches(context.model)) {
        terminateForModelDrift(context);
        return blockedBashResult();
      }
      if (safeMode || blockPromptInput) return blockedBashResult();
      if (profile === "FULL_ACCESS") return undefined;
      if (!context.hasUI) return blockedBashResult();
      try {
        const approved = await context.ui.confirm(
          "Hunter Pi direct shell",
          "Run the exact shell command you entered with the Hunter Pi process authority?",
        );
        return approved ? undefined : blockedBashResult();
      } catch {
        return blockedBashResult();
      }
    });
    api.on("session_start", (_event, rawContext) => {
      const context = rawContext as CoreExtensionContext;
      if (!selectedModelMatches(context.model)) {
        terminateForModelDrift(context);
      }
      context.ui.setStatus(HPI_CORE_EXTENSION_ID, status);
      if (header !== undefined && header.length > 0) {
        context.ui.setWidget?.(HPI_CORE_EXTENSION_ID, header.split("\n"), {
          placement: "aboveEditor",
        });
      }
    });

    api.on("tool_call", async (rawEvent, rawContext) => {
      const context = rawContext as CoreExtensionContext;
      const event = rawEvent as HunterToolCall;
      const result = await evaluateHunterToolCallWithFilesystem(event, {
        cwd: context.cwd,
        permissionProfile: profile,
        safeMode,
      });
      if (result.decision === "ALLOW") {
        return undefined;
      }
      if (result.decision === "BLOCK") {
        return { block: true, reason: result.reason };
      }
      if (!context.hasUI) {
        return { block: true, reason: `${result.reason} No interactive approval UI is available.` };
      }
      try {
        const approved = await context.ui.confirm("Hunter Pi permission", result.reason);
        return approved
          ? undefined
          : { block: true, reason: "User did not approve this tool call." };
      } catch {
        return { block: true, reason: "The interactive approval UI failed closed." };
      }
    });

    api.registerCommand("hunter-status", {
      description: "Show Hunter Pi mode, policy, and claim boundaries",
      handler: (_arguments, rawContext) => {
        const context = rawContext as CoreExtensionContext;
        context.ui.notify(
          [
            "HunterStatus=DETECTED Command=/hunter-status",
            `Core=${HPI_CORE_EXTENSION_ID}@${HPI_CORE_EXTENSION_VERSION}`,
            `Mode=${mode} Permission=${profile} SafeMode=${safeMode ? "ON" : "OFF"}`,
            `PromptInput=${blockPromptInput ? "BLOCKED" : "ENABLED"} ProviderRequests=NOT_PROVEN`,
            credentialBoundary,
            "PiBuiltins=USER_DIRECTED CoreMediation=NOT_GLOBAL",
            "ShareCommand=NOT_MEDIATED RemoteWriteGuarantee=NOT_PROVEN",
            "Compatibility=UNVERIFIED Trust=BUNDLED Isolation=PROCESS_AUTHORITY",
            "VerifiedChange=NOT_CLAIMED",
          ].join(" | "),
          "info",
        );
      },
    });
  };
}

export default createHunterCoreExtension();
