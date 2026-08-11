import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { fingerprintSchema, timestampSchema, type Fingerprint } from "@hunter-pi/domain";
import { z } from "zod";

import { ManagedProcessError } from "./process-errors.js";
import {
  driverSnapshotSchema,
  type DriverCancelResult,
  type DriverSnapshot,
  type ManagedProcessDriver,
  type ManagedProcessDriverSession,
  type ManagedProcessDriverStartRequest,
} from "./process-platform.js";
import { windowsJobHelperSource } from "./windows-job-helper-source.js";

const helperEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("ready"),
    pid: z.number().int().positive(),
    creationTime: z.string().regex(/^\d+$/u),
  }),
  z.strictObject({
    type: z.literal("output"),
    stream: z.enum(["STDOUT", "STDERR"]),
    dataBase64: z
      .string()
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
  }),
  z.strictObject({
    type: z.literal("state"),
    phase: z.enum(["RUNNING", "EXITED", "TERMINATING"]),
    terminationCause: z.enum(["NONE", "CANCEL", "TIMEOUT"]),
    exitCode: z.number().int().nullable(),
    treeState: z.enum(["ACTIVE", "EMPTY"]),
    stdoutState: z.enum(["OPEN", "CLOSED"]),
    stderrState: z.enum(["OPEN", "CLOSED"]),
  }),
  z.strictObject({
    type: z.literal("terminationAcknowledged"),
    cause: z.enum(["CANCEL", "TIMEOUT"]),
  }),
  z.strictObject({
    type: z.literal("terminal"),
    terminationCause: z.enum(["NONE", "CANCEL", "TIMEOUT"]),
    exitCode: z.number().int(),
  }),
  z.strictObject({
    type: z.literal("error"),
    code: z.string().regex(/^[A-Z0-9_]{1,64}$/u),
  }),
]);

type HelperEvent = z.infer<typeof helperEventSchema>;

function sha256(value: string): Fingerprint {
  return fingerprintSchema.parse(`sha256:${createHash("sha256").update(value).digest("hex")}`);
}

function now(): string {
  return timestampSchema.parse(new Date().toISOString());
}

function helperEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    POWERSHELL_TELEMETRY_OPTOUT: "1",
  };
  const allowed = [
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "Path",
    "PATHEXT",
    "PSModulePath",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramData",
  ];
  for (const name of allowed) {
    const value = process.env[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function normalizeWindowsEnvironment(
  environment: Readonly<Record<string, string>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  const observedNames = new Set<string>();
  for (const name of Object.keys(environment).sort()) {
    const foldedName = name.toUpperCase();
    if (observedNames.has(foldedName)) continue;
    const value = environment[name];
    if (value === undefined) continue;
    observedNames.add(foldedName);
    result[name] = value;
  }
  return result;
}

async function resolvePowerShell(): Promise<string> {
  const programFiles = process.env["ProgramFiles"];
  const systemRoot = process.env["SystemRoot"] ?? process.env["WINDIR"];
  const candidates = [
    programFiles === undefined ? undefined : join(programFiles, "PowerShell", "7", "pwsh.exe"),
    systemRoot === undefined
      ? undefined
      : join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  ].filter((value): value is string => value !== undefined);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue to the next exact system-owned candidate.
    }
  }
  throw new ManagedProcessError(
    "PROCESS_PLATFORM_UNAVAILABLE",
    "Windows PowerShell is unavailable for Job Object containment",
  );
}

function unreconciledSnapshot(): DriverSnapshot {
  return driverSnapshotSchema.parse({
    phase: "UNRECONCILED",
    exitCode: null,
    terminationCause: "NONE",
    identityState: "NOT_PROVEN",
    treeState: "NOT_PROVEN",
    stdoutState: "NOT_PROVEN",
    stderrState: "NOT_PROVEN",
    observedAt: now(),
  });
}

class WindowsJobObjectSession implements ManagedProcessDriverSession {
  public readonly containment = "WINDOWS_JOB_OBJECT" as const;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #helperRoot: string;
  readonly #onOutput: ManagedProcessDriverStartRequest["onOutput"];
  readonly #readyPromise: Promise<void>;
  readonly #settlementPromise: Promise<DriverSnapshot>;
  readonly #ackWaiters: ((cause: "CANCEL" | "TIMEOUT" | undefined) => void)[] = [];
  #resolveReady: (() => void) | undefined;
  #rejectReady: ((error: Error) => void) | undefined;
  #resolveSettlement: ((snapshot: DriverSnapshot) => void) | undefined;
  #identityFingerprint: Fingerprint | undefined;
  #snapshot: DriverSnapshot = unreconciledSnapshot();
  #ready = false;
  #terminalSeen = false;
  #protocolFailed = false;
  #lastAcknowledgedCause: "CANCEL" | "TIMEOUT" | undefined;
  #lineBuffer = "";
  readonly #decoder = new StringDecoder("utf8");

  private constructor(
    child: ChildProcessWithoutNullStreams,
    helperRoot: string,
    onOutput: ManagedProcessDriverStartRequest["onOutput"],
  ) {
    this.#child = child;
    this.#helperRoot = helperRoot;
    this.#onOutput = onOutput;
    this.#readyPromise = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.#settlementPromise = new Promise<DriverSnapshot>((resolve) => {
      this.#resolveSettlement = resolve;
    });
    child.stdout.on("data", (chunk: Buffer) => {
      this.#receive(chunk);
    });
    child.stdout.on("end", () => {
      const tail = this.#decoder.end();
      if (tail.length > 0) this.#lineBuffer += tail;
      if (this.#lineBuffer.trim().length > 0) this.#failProtocol();
    });
    child.on("error", () => {
      this.#failProtocol();
    });
    child.on("close", (code) => {
      void this.#handleClose(code);
    });
  }

  public static async launch(
    request: ManagedProcessDriverStartRequest,
  ): Promise<WindowsJobObjectSession> {
    const powerShell = await resolvePowerShell();
    const helperRoot = await mkdtemp(join(tmpdir(), "hpi-process-host-"));
    const helperPath = join(helperRoot, "windows-job-host.ps1");
    await writeFile(helperPath, windowsJobHelperSource, { encoding: "utf8", flag: "wx" });
    const child = spawn(
      powerShell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", helperPath],
      {
        cwd: helperRoot,
        env: helperEnvironment(),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const session = new WindowsJobObjectSession(child, helperRoot, request.onOutput);
    child.stdin.write(
      `${JSON.stringify({
        executable: request.executable,
        argv: request.argv,
        cwd: request.cwd,
        environment: normalizeWindowsEnvironment(request.environment),
        timeoutMs: request.timeoutMs,
      })}\n`,
      "utf8",
    );
    let startTimer: NodeJS.Timeout | undefined;
    const startTimeout = new Promise<never>((_, reject) => {
      startTimer = setTimeout(() => {
        reject(
          new ManagedProcessError(
            "PROCESS_PLATFORM_START_FAILED",
            "Windows Job Object helper did not establish containment",
          ),
        );
      }, 30_000);
      startTimer.unref();
    });
    try {
      await Promise.race([session.#readyPromise, startTimeout]);
      if (startTimer !== undefined) clearTimeout(startTimer);
      return session;
    } catch (error) {
      if (startTimer !== undefined) clearTimeout(startTimer);
      child.stdin.destroy();
      child.kill();
      await session.#settlementPromise;
      throw error;
    }
  }

  public get identityFingerprint(): Fingerprint {
    if (this.#identityFingerprint === undefined) {
      throw new ManagedProcessError(
        "PROCESS_PLATFORM_START_FAILED",
        "Windows process identity was not established",
      );
    }
    return this.#identityFingerprint;
  }

  public snapshot(): Promise<DriverSnapshot> {
    return Promise.resolve(driverSnapshotSchema.parse(this.#snapshot));
  }

  public async cancel(
    expectedIdentity: Fingerprint,
    reason: "USER_REQUEST" | "POLICY" | "TIMEOUT",
  ): Promise<DriverCancelResult> {
    if (expectedIdentity !== this.identityFingerprint) {
      return { outcome: "IDENTITY_MISMATCH" };
    }
    if (this.#snapshot.phase === "TERMINAL" || this.#snapshot.phase === "UNRECONCILED") {
      return { outcome: "NOT_PROVEN" };
    }
    const expectedCause = reason === "TIMEOUT" ? "TIMEOUT" : "CANCEL";
    if (this.#lastAcknowledgedCause !== undefined) {
      return this.#lastAcknowledgedCause === expectedCause
        ? { outcome: "ACKNOWLEDGED" }
        : { outcome: "NOT_PROVEN" };
    }
    const acknowledgement = new Promise<"CANCEL" | "TIMEOUT" | undefined>((resolve) => {
      this.#ackWaiters.push(resolve);
    });
    const written = await new Promise<boolean>((resolve) => {
      this.#child.stdin.write(`${expectedCause}\n`, "utf8", (error) => {
        resolve(error === null || error === undefined);
      });
    });
    if (!written) return { outcome: "NOT_PROVEN" };
    const timeout = new Promise<undefined>((resolve) => {
      const timer = setTimeout(() => {
        resolve(undefined);
      }, 5_000);
      timer.unref();
    });
    const cause = await Promise.race([acknowledgement, timeout]);
    return cause === expectedCause ? { outcome: "ACKNOWLEDGED" } : { outcome: "NOT_PROVEN" };
  }

  public waitForSettlement(): Promise<DriverSnapshot> {
    return this.#settlementPromise;
  }

  #receive(chunk: Buffer): void {
    this.#lineBuffer += this.#decoder.write(chunk);
    for (;;) {
      const end = this.#lineBuffer.indexOf("\n");
      if (end < 0) return;
      const line = this.#lineBuffer.slice(0, end).trimEnd();
      this.#lineBuffer = this.#lineBuffer.slice(end + 1);
      if (line.length === 0) continue;
      try {
        this.#handleEvent(helperEventSchema.parse(JSON.parse(line)));
      } catch {
        this.#failProtocol();
      }
    }
  }

  #handleEvent(event: HelperEvent): void {
    if (this.#protocolFailed) return;
    if (event.type === "ready") {
      if (this.#ready) {
        this.#failProtocol();
        return;
      }
      this.#identityFingerprint = sha256(
        `windows-job-object\0${String(event.pid)}\0${event.creationTime}`,
      );
      this.#snapshot = driverSnapshotSchema.parse({
        phase: "RUNNING",
        exitCode: null,
        terminationCause: "NONE",
        identityState: "MATCH",
        treeState: "ACTIVE",
        stdoutState: "OPEN",
        stderrState: "OPEN",
        observedAt: now(),
      });
      this.#ready = true;
      this.#resolveReady?.();
      return;
    }
    if (event.type === "output") {
      this.#onOutput(event.stream, Buffer.from(event.dataBase64, "base64"));
      return;
    }
    if (event.type === "state") {
      if (!this.#ready) {
        this.#failProtocol();
        return;
      }
      this.#snapshot = driverSnapshotSchema.parse({
        phase: event.phase,
        exitCode: event.exitCode,
        terminationCause: event.terminationCause,
        identityState: "MATCH",
        treeState: event.treeState,
        stdoutState: event.stdoutState,
        stderrState: event.stderrState,
        observedAt: now(),
      });
      return;
    }
    if (event.type === "terminationAcknowledged") {
      this.#lastAcknowledgedCause = event.cause;
      for (const resolve of this.#ackWaiters.splice(0)) resolve(event.cause);
      return;
    }
    if (event.type === "terminal") {
      if (!this.#ready || this.#terminalSeen) {
        this.#failProtocol();
        return;
      }
      this.#terminalSeen = true;
      this.#snapshot = driverSnapshotSchema.parse({
        phase: "TERMINAL",
        exitCode: event.exitCode,
        terminationCause: event.terminationCause,
        identityState: "MATCH",
        treeState: "EMPTY",
        stdoutState: "CLOSED",
        stderrState: "CLOSED",
        observedAt: now(),
      });
      return;
    }
    this.#failProtocol(event.code);
  }

  #failProtocol(helperCode = "PROTOCOL"): void {
    if (this.#protocolFailed) return;
    this.#protocolFailed = true;
    this.#snapshot = unreconciledSnapshot();
    this.#child.stdin.destroy();
    const error = new ManagedProcessError(
      "PROCESS_PLATFORM_START_FAILED",
      `Windows Job Object helper returned unreconciled code ${helperCode}`,
    );
    if (!this.#ready) this.#rejectReady?.(error);
    for (const resolve of this.#ackWaiters.splice(0)) resolve(undefined);
  }

  async #handleClose(code: number | null): Promise<void> {
    await rm(this.#helperRoot, { force: true, recursive: true }).catch(() => undefined);
    if (!this.#terminalSeen || code !== 0 || this.#protocolFailed) {
      this.#snapshot = unreconciledSnapshot();
      if (!this.#ready) {
        this.#rejectReady?.(
          new ManagedProcessError(
            "PROCESS_PLATFORM_START_FAILED",
            "Windows Job Object containment was not established",
          ),
        );
      }
    }
    for (const resolve of this.#ackWaiters.splice(0)) resolve(undefined);
    this.#resolveSettlement?.(driverSnapshotSchema.parse(this.#snapshot));
  }
}

export class WindowsJobObjectDriver implements ManagedProcessDriver {
  public start(request: ManagedProcessDriverStartRequest): Promise<ManagedProcessDriverSession> {
    return WindowsJobObjectSession.launch(request);
  }
}
