import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";

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
import {
  linuxPidfdSignalSource,
  linuxSubreaperProcessTreeHelperSource,
  linuxSubreaperShimSource,
} from "./posix-process-group-helper-source.js";

const protocolEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("ready"),
    targetPid: z.number().int().positive(),
  }),
  z.strictObject({
    type: z.literal("state"),
    phase: z.enum(["RUNNING", "EXITED"]),
    exitCode: z.number().int().nullable(),
    treeState: z.enum(["ACTIVE", "EMPTY"]),
    stdoutState: z.enum(["OPEN", "CLOSED"]),
    stderrState: z.enum(["OPEN", "CLOSED"]),
  }),
  z.strictObject({
    type: z.literal("terminal"),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
  }),
  z.strictObject({
    type: z.literal("terminationAcknowledged"),
    cause: z.enum(["CANCEL", "TIMEOUT"]),
  }),
  z.strictObject({
    type: z.literal("terminationNotApplied"),
    cause: z.enum(["CANCEL", "TIMEOUT"]),
  }),
  z.strictObject({
    type: z.literal("error"),
    code: z.string().regex(/^[A-Z0-9_]{1,64}$/u),
  }),
]);

interface ProcIdentity {
  readonly processGroupId: number;
  readonly sessionId: number;
  readonly startTime: string;
}

function now(): string {
  return timestampSchema.parse(new Date().toISOString());
}

function sha256(value: string): Fingerprint {
  return fingerprintSchema.parse(`sha256:${createHash("sha256").update(value).digest("hex")}`);
}

function infrastructureEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ["LANG", "LC_ALL", "TMPDIR"]) {
    const value = process.env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

async function resolvePython(): Promise<string> {
  try {
    const resolved = await realpath("/usr/bin/python3");
    await access(resolved, constants.X_OK);
    return resolved;
  } catch (error) {
    throw new ManagedProcessError(
      "PROCESS_PLATFORM_UNAVAILABLE",
      "Linux subreaper containment requires the system-owned /usr/bin/python3 runtime",
      error,
    );
  }
}

async function readProcIdentity(pid: number): Promise<ProcIdentity> {
  const value = await readFile(`/proc/${String(pid)}/stat`, "utf8");
  const end = value.lastIndexOf(")");
  if (end < 0) throw new Error("invalid proc identity");
  const fields = value
    .slice(end + 2)
    .trim()
    .split(/\s+/u);
  if (fields.length < 20) throw new Error("incomplete proc identity");
  const processGroupId = Number(fields[2]);
  const sessionId = Number(fields[3]);
  const startTime = fields[19];
  if (
    !Number.isSafeInteger(processGroupId) ||
    !Number.isSafeInteger(sessionId) ||
    startTime === undefined ||
    !/^\d+$/u.test(startTime)
  ) {
    throw new Error("unusable proc identity");
  }
  return { processGroupId, sessionId, startTime };
}

function unreconciledSnapshot(cause: "NONE" | "CANCEL" | "TIMEOUT" = "NONE"): DriverSnapshot {
  return driverSnapshotSchema.parse({
    phase: "UNRECONCILED",
    exitCode: null,
    terminationCause: cause,
    identityState: "NOT_PROVEN",
    treeState: "NOT_PROVEN",
    stdoutState: "NOT_PROVEN",
    stderrState: "NOT_PROVEN",
    observedAt: now(),
  });
}

function requirePipe<T extends Readable | Writable>(value: T | null | undefined, name: string): T {
  if (value === null || value === undefined) {
    throw new ManagedProcessError(
      "PROCESS_PLATFORM_START_FAILED",
      `POSIX helper ${name} pipe is unavailable`,
    );
  }
  return value;
}

class LinuxSubreaperProcessTreeSession implements ManagedProcessDriverSession {
  public readonly containment = "LINUX_SUBREAPER_PROCESS_TREE" as const;
  readonly #child: ChildProcess;
  readonly #stdin: Writable;
  readonly #protocol: Readable;
  readonly #helperRoot: string;
  readonly #timeoutMs: number;
  readonly #readyPromise: Promise<void>;
  readonly #settlementPromise: Promise<DriverSnapshot>;
  readonly #ackWaiters: ((cause: "CANCEL" | "TIMEOUT" | undefined) => void)[] = [];
  readonly #decoder = new StringDecoder("utf8");
  #resolveReady: (() => void) | undefined;
  #rejectReady: ((error: Error) => void) | undefined;
  #resolveSettlement: ((snapshot: DriverSnapshot) => void) | undefined;
  #identityFingerprint: Fingerprint | undefined;
  #identity: ProcIdentity | undefined;
  #snapshot = unreconciledSnapshot();
  #lineBuffer = "";
  #ready = false;
  #protocolTerminal = false;
  #protocolFailed = false;
  #terminationCause: "NONE" | "CANCEL" | "TIMEOUT" = "NONE";
  #terminationAcknowledged = false;
  #targetExitCode: number | null = null;
  #stdoutClosed = false;
  #stderrClosed = false;
  #timeout: NodeJS.Timeout | undefined;

  private constructor(
    child: ChildProcess,
    helperRoot: string,
    request: ManagedProcessDriverStartRequest,
  ) {
    this.#child = child;
    this.#helperRoot = helperRoot;
    this.#timeoutMs = request.timeoutMs;
    this.#stdin = requirePipe(child.stdin, "stdin");
    const stdout = requirePipe(child.stdout, "stdout");
    const stderr = requirePipe(child.stderr, "stderr");
    this.#protocol = requirePipe(child.stdio[3] as Readable | null, "protocol");
    this.#readyPromise = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.#settlementPromise = new Promise<DriverSnapshot>((resolve) => {
      this.#resolveSettlement = resolve;
    });
    stdout.on("data", (chunk: Buffer) => {
      request.onOutput("STDOUT", chunk);
    });
    stderr.on("data", (chunk: Buffer) => {
      request.onOutput("STDERR", chunk);
    });
    stdout.on("close", () => {
      this.#stdoutClosed = true;
    });
    stderr.on("close", () => {
      this.#stderrClosed = true;
    });
    this.#protocol.on("data", (chunk: Buffer) => {
      this.#receive(chunk);
    });
    this.#protocol.on("end", () => {
      const tail = this.#decoder.end();
      if (tail.length > 0) this.#lineBuffer += tail;
      if (this.#lineBuffer.trim().length > 0) this.#failProtocol("PROTOCOL_TAIL");
    });
    child.on("error", () => {
      this.#failProtocol("HELPER_PROCESS_ERROR");
    });
    child.on("close", (code) => {
      void this.#handleClose(code);
    });
    this.#stdin.write(
      `${JSON.stringify({
        executable: request.executable,
        argv: request.argv,
        cwd: request.cwd,
        environment: request.environment,
      })}\n`,
      "utf8",
    );
  }

  public static async launch(
    request: ManagedProcessDriverStartRequest,
  ): Promise<LinuxSubreaperProcessTreeSession> {
    if (process.platform !== "linux") {
      throw new ManagedProcessError(
        "PROCESS_PLATFORM_UNAVAILABLE",
        "Linux subreaper process-tree containment requires Linux procfs",
      );
    }
    const python = await resolvePython();
    const helperRoot = await mkdtemp(join(tmpdir(), "hpi-process-host-"));
    const shimPath = join(helperRoot, "linux-subreaper-shim.py");
    const helperPath = join(helperRoot, "linux-subreaper-process-tree-host.mjs");
    const pidfdSignalerPath = join(helperRoot, "linux-pidfd-signal.py");
    await Promise.all([
      writeFile(shimPath, linuxSubreaperShimSource, { encoding: "utf8", flag: "wx" }),
      writeFile(pidfdSignalerPath, linuxPidfdSignalSource, { encoding: "utf8", flag: "wx" }),
      writeFile(helperPath, linuxSubreaperProcessTreeHelperSource, {
        encoding: "utf8",
        flag: "wx",
      }),
    ]);
    const child = spawn(python, [shimPath, process.execPath, helperPath, pidfdSignalerPath], {
      cwd: helperRoot,
      detached: true,
      env: infrastructureEnvironment(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    const session = new LinuxSubreaperProcessTreeSession(child, helperRoot, request);
    let startTimer: NodeJS.Timeout | undefined;
    const startTimeout = new Promise<never>((_, reject) => {
      startTimer = setTimeout(() => {
        reject(
          new ManagedProcessError(
            "PROCESS_PLATFORM_START_FAILED",
            "Linux subreaper helper did not establish containment",
          ),
        );
      }, 15_000);
      startTimer.unref();
    });
    try {
      await Promise.race([session.#readyPromise, startTimeout]);
      if (startTimer !== undefined) clearTimeout(startTimer);
      return session;
    } catch (error) {
      if (startTimer !== undefined) clearTimeout(startTimer);
      session.#stdin.destroy();
      await session.#settlementPromise;
      throw error;
    }
  }

  public get identityFingerprint(): Fingerprint {
    if (this.#identityFingerprint === undefined) {
      throw new ManagedProcessError(
        "PROCESS_PLATFORM_START_FAILED",
        "Linux subreaper process-tree identity was not established",
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
    const cause = reason === "TIMEOUT" ? "TIMEOUT" : "CANCEL";
    if (this.#terminationAcknowledged) {
      return this.#terminationCause === cause
        ? { outcome: "ACKNOWLEDGED" }
        : { outcome: "NOT_PROVEN" };
    }
    return (await this.#requestTermination(cause))
      ? { outcome: "ACKNOWLEDGED" }
      : { outcome: "NOT_PROVEN" };
  }

  public waitForSettlement(): Promise<DriverSnapshot> {
    return this.#settlementPromise;
  }

  async #requestTermination(cause: "CANCEL" | "TIMEOUT"): Promise<boolean> {
    if (!this.#ready || this.#identity === undefined || this.#child.pid === undefined) return false;
    if (this.#snapshot.phase === "TERMINAL" || this.#snapshot.phase === "UNRECONCILED") {
      return false;
    }
    try {
      const current = await readProcIdentity(this.#child.pid);
      if (
        current.startTime !== this.#identity.startTime ||
        current.processGroupId !== this.#child.pid ||
        current.sessionId !== this.#child.pid
      ) {
        return false;
      }
      const acknowledgement = new Promise<"CANCEL" | "TIMEOUT" | undefined>((resolve) => {
        this.#ackWaiters.push(resolve);
      });
      const written = await new Promise<boolean>((resolve) => {
        this.#stdin.write(`${JSON.stringify({ type: "terminate", cause })}\n`, "utf8", (error) => {
          resolve(error === null || error === undefined);
        });
      });
      if (!written) {
        this.#failProtocol("TERMINATION_WRITE_FAILED");
        return false;
      }
      const acknowledgementTimeout = new Promise<undefined>((resolve) => {
        const timer = setTimeout(() => {
          resolve(undefined);
        }, 5_000);
        timer.unref();
      });
      const acknowledgedCause = await Promise.race([acknowledgement, acknowledgementTimeout]);
      if (acknowledgedCause !== cause) {
        if (acknowledgedCause === undefined && !this.#protocolFailed) {
          this.#failProtocol("TERMINATION_NOT_ACKNOWLEDGED");
        }
        return false;
      }
      return true;
    } catch {
      return false;
    }
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
        this.#handleEvent(protocolEventSchema.parse(JSON.parse(line)));
      } catch {
        this.#failProtocol("PROTOCOL_INVALID");
      }
    }
  }

  #handleEvent(event: z.infer<typeof protocolEventSchema>): void {
    if (event.type === "ready") {
      if (this.#ready || this.#child.pid === undefined) {
        this.#failProtocol("READY_INVALID");
        return;
      }
      void this.#establishIdentity(this.#child.pid);
      return;
    }
    if (event.type === "state") {
      if (!this.#ready) {
        this.#failProtocol("STATE_BEFORE_READY");
        return;
      }
      this.#snapshot = driverSnapshotSchema.parse({
        phase: event.phase,
        exitCode: event.exitCode,
        terminationCause: this.#terminationCause,
        identityState: "MATCH",
        treeState: event.treeState,
        stdoutState: event.stdoutState,
        stderrState: event.stderrState,
        observedAt: now(),
      });
      return;
    }
    if (event.type === "terminal") {
      this.#protocolTerminal = true;
      this.#targetExitCode = event.exitCode;
      return;
    }
    if (event.type === "terminationAcknowledged") {
      this.#terminationCause = event.cause;
      this.#terminationAcknowledged = true;
      this.#snapshot = driverSnapshotSchema.parse({
        phase: "TERMINATING",
        exitCode: null,
        terminationCause: event.cause,
        identityState: "MATCH",
        treeState: "ACTIVE",
        stdoutState: this.#stdoutClosed ? "CLOSED" : "OPEN",
        stderrState: this.#stderrClosed ? "CLOSED" : "OPEN",
        observedAt: now(),
      });
      for (const resolve of this.#ackWaiters.splice(0)) resolve(event.cause);
      return;
    }
    if (event.type === "terminationNotApplied") {
      for (const resolve of this.#ackWaiters.splice(0)) resolve(undefined);
      return;
    }
    this.#failProtocol(event.code);
  }

  async #establishIdentity(pid: number): Promise<void> {
    try {
      const identity = await readProcIdentity(pid);
      if (identity.processGroupId !== pid || identity.sessionId !== pid) {
        throw new Error("helper is not the exact process-group and session leader");
      }
      this.#identity = identity;
      this.#identityFingerprint = sha256(
        `linux-subreaper-process-tree\0${String(pid)}\0${identity.startTime}`,
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
      this.#timeout = setTimeout(() => {
        void this.#requestTermination("TIMEOUT");
      }, this.#timeoutMs);
      this.#timeout.unref();
      this.#resolveReady?.();
    } catch {
      this.#failProtocol("IDENTITY_NOT_PROVEN");
    }
  }

  #failProtocol(code: string): void {
    if (this.#protocolFailed) return;
    this.#protocolFailed = true;
    this.#snapshot = unreconciledSnapshot(this.#terminationCause);
    this.#stdin.destroy();
    if (!this.#ready) {
      this.#rejectReady?.(
        new ManagedProcessError(
          "PROCESS_PLATFORM_START_FAILED",
          `Linux subreaper helper returned unreconciled code ${code}`,
        ),
      );
    }
    for (const resolve of this.#ackWaiters.splice(0)) resolve(undefined);
  }

  #groupIsEmpty(): boolean | undefined {
    if (this.#child.pid === undefined) return undefined;
    try {
      process.kill(-this.#child.pid, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      return undefined;
    }
  }

  async #handleClose(code: number | null): Promise<void> {
    if (this.#timeout !== undefined) clearTimeout(this.#timeout);
    await rm(this.#helperRoot, { force: true, recursive: true }).catch(() => undefined);
    let empty = this.#groupIsEmpty();
    for (let attempt = 0; empty === false && attempt < 200; attempt += 1) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 20);
        timer.unref();
      });
      empty = this.#groupIsEmpty();
    }
    if (
      !this.#protocolFailed &&
      empty === true &&
      this.#stdoutClosed &&
      this.#stderrClosed &&
      this.#protocolTerminal &&
      code === 0
    ) {
      this.#snapshot = driverSnapshotSchema.parse({
        phase: "TERMINAL",
        exitCode: this.#terminationAcknowledged ? null : this.#targetExitCode,
        terminationCause: this.#terminationCause,
        identityState: "MATCH",
        treeState: "EMPTY",
        stdoutState: "CLOSED",
        stderrState: "CLOSED",
        observedAt: now(),
      });
    } else {
      this.#snapshot = unreconciledSnapshot(this.#terminationCause);
      if (!this.#ready) {
        this.#rejectReady?.(
          new ManagedProcessError(
            "PROCESS_PLATFORM_START_FAILED",
            "Linux subreaper process-tree containment was not established",
          ),
        );
      }
    }
    for (const resolve of this.#ackWaiters.splice(0)) resolve(undefined);
    this.#resolveSettlement?.(driverSnapshotSchema.parse(this.#snapshot));
  }
}

export class LinuxSubreaperProcessTreeDriver implements ManagedProcessDriver {
  public start(request: ManagedProcessDriverStartRequest): Promise<ManagedProcessDriverSession> {
    return LinuxSubreaperProcessTreeSession.launch(request);
  }
}
