export const linuxSubreaperShimSource = String.raw`
import ctypes
import os
import sys

PR_SET_CHILD_SUBREAPER = 36
PR_GET_CHILD_SUBREAPER = 37
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), "PR_SET_CHILD_SUBREAPER")
value = ctypes.c_int(0)
if libc.prctl(PR_GET_CHILD_SUBREAPER, ctypes.byref(value), 0, 0, 0) != 0 or value.value != 1:
    raise OSError(ctypes.get_errno(), "PR_GET_CHILD_SUBREAPER")
os.environ["HPI_SUBREAPER_ESTABLISHED"] = "1"
os.execv(sys.argv[1], sys.argv[1:])
`;

export const linuxSubreaperProcessTreeHelperSource = String.raw`
import { readdir, readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const protocol = createWriteStream(null, { fd: 3, autoClose: false });
const send = (value) => {
  protocol.write(JSON.stringify(value) + "\n");
};

const ignoredProcErrors = new Set(["ENOENT", "ESRCH"]);

const parseProcIdentity = async (pid) => {
  const value = await readFile("/proc/" + String(pid) + "/stat", "utf8");
  const end = value.lastIndexOf(")");
  if (end < 0) throw new Error("PROC_STAT_INVALID");
  const fields = value.slice(end + 2).trim().split(/\s+/u);
  if (fields.length < 20) throw new Error("PROC_STAT_INVALID");
  const state = fields[0];
  const parentPid = Number(fields[1]);
  const processGroupId = Number(fields[2]);
  const sessionId = Number(fields[3]);
  const startTime = fields[19];
  if (
    typeof state !== "string" ||
    !Number.isSafeInteger(parentPid) ||
    !Number.isSafeInteger(processGroupId) ||
    !Number.isSafeInteger(sessionId) ||
    typeof startTime !== "string" ||
    !/^\d+$/u.test(startTime)
  ) {
    throw new Error("PROC_STAT_INVALID");
  }
  return { pid, state, parentPid, processGroupId, sessionId, startTime };
};

const readProcTable = async () => {
  const entries = await readdir("/proc", { withFileTypes: true });
  const table = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    const pid = Number(entry.name);
    try {
      table.set(pid, await parseProcIdentity(pid));
    } catch (error) {
      if (!ignoredProcErrors.has(error?.code)) throw error;
    }
  }
  return table;
};

const liveDescendants = async () => {
  const table = await readProcTable();
  const children = new Map();
  for (const identity of table.values()) {
    const values = children.get(identity.parentPid) ?? [];
    values.push(identity);
    children.set(identity.parentPid, values);
  }
  const descendants = [];
  const pending = [process.pid];
  const visited = new Set(pending);
  while (pending.length > 0) {
    const parentPid = pending.pop();
    for (const identity of children.get(parentPid) ?? []) {
      if (visited.has(identity.pid)) continue;
      visited.add(identity.pid);
      pending.push(identity.pid);
      if (identity.state !== "Z" && identity.state !== "X") descendants.push(identity);
    }
  }
  return descendants;
};

const killIdentified = async (identities) => {
  for (const identity of identities) {
    try {
      const current = await parseProcIdentity(identity.pid);
      if (current.startTime !== identity.startTime) throw new Error("PROCESS_IDENTITY_CHANGED");
      process.kill(identity.pid, "SIGKILL");
    } catch (error) {
      if (!ignoredProcErrors.has(error?.code)) throw error;
    }
  }
};

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let target;
let requestSeen = false;
let finished = false;
let fatal = false;
let inputClosed = false;
let stdoutClosed = false;
let stderrClosed = false;
let targetExited = false;
let targetExitCode = null;
let targetSignal = null;
let terminationCause = "NONE";
let terminationAcknowledged = false;
let terminationInFlight = false;
let lastState = "";

const fail = (code) => {
  if (fatal) return;
  fatal = true;
  try {
    send({ type: "error", code });
  } catch {
    // The parent may already be gone. Cleanup continues without a PASS receipt.
  }
};

const beginTermination = async (cause) => {
  if (fatal || finished) return;
  if (terminationCause !== "NONE" && terminationCause !== cause) {
    fail("TERMINATION_CAUSE_CONFLICT");
    return;
  }
  terminationCause = cause;
  if (terminationAcknowledged || terminationInFlight) {
    if (terminationAcknowledged) send({ type: "terminationAcknowledged", cause });
    return;
  }
  terminationInFlight = true;
  try {
    const descendants = await liveDescendants();
    if (descendants.length === 0) {
      terminationCause = "NONE";
      send({ type: "terminationNotApplied", cause });
      return;
    }
    await killIdentified(descendants);
    terminationAcknowledged = true;
    send({ type: "terminationAcknowledged", cause });
  } catch {
    fail("TREE_TERMINATION_FAILED");
  } finally {
    terminationInFlight = false;
  }
};

const startTarget = async (line) => {
  try {
    const self = await parseProcIdentity(process.pid);
    if (
      process.env.HPI_SUBREAPER_ESTABLISHED !== "1" ||
      self.processGroupId !== process.pid ||
      self.sessionId !== process.pid
    ) {
      throw new Error("SUBREAPER_NOT_ESTABLISHED");
    }
    await liveDescendants();
    const request = JSON.parse(line);
    target = spawn(request.executable, request.argv, {
      cwd: request.cwd,
      env: request.environment,
      detached: false,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    target.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
    });
    target.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
    });
    target.stdout.on("end", () => {
      stdoutClosed = true;
    });
    target.stderr.on("end", () => {
      stderrClosed = true;
    });
    target.once("spawn", () => {
      send({ type: "ready", targetPid: target.pid });
    });
    target.once("error", () => {
      fail("TARGET_SPAWN_FAILED");
    });
    target.once("exit", (code, signal) => {
      targetExited = true;
      targetExitCode = code;
      targetSignal = signal;
    });
  } catch {
    fail("REQUEST_OR_CONTAINMENT_INVALID");
  }
};

input.on("line", (line) => {
  if (!requestSeen) {
    requestSeen = true;
    void startTarget(line);
    return;
  }
  try {
    const command = JSON.parse(line);
    if (
      command?.type !== "terminate" ||
      (command.cause !== "CANCEL" && command.cause !== "TIMEOUT")
    ) {
      throw new Error("CONTROL_INVALID");
    }
    void beginTermination(command.cause);
  } catch {
    fail("CONTROL_INVALID");
  }
});

input.on("close", () => {
  inputClosed = true;
});

const poll = async () => {
  if (finished) return;
  try {
    if (!requestSeen || target === undefined) {
      if (fatal || inputClosed) {
        process.exitCode = 70;
        finished = true;
        protocol.end(() => process.exit(70));
        return;
      }
      setTimeout(() => void poll(), 20).unref();
      return;
    }
    let descendants = await liveDescendants();
    if (fatal || inputClosed || terminationAcknowledged) {
      await killIdentified(descendants);
      descendants = await liveDescendants();
    }
    const treeState = descendants.length === 0 ? "EMPTY" : "ACTIVE";
    const phase =
      terminationAcknowledged && descendants.length > 0
        ? "TERMINATING"
        : targetExited
          ? "EXITED"
          : "RUNNING";
    const state = [
      phase,
      treeState,
      stdoutClosed,
      stderrClosed,
      targetExitCode,
      targetSignal,
      terminationCause,
    ].join("|");
    if (!fatal && state !== lastState) {
      send({
        type: "state",
        phase,
        exitCode: targetExitCode,
        treeState,
        stdoutState: stdoutClosed ? "CLOSED" : "OPEN",
        stderrState: stderrClosed ? "CLOSED" : "OPEN",
      });
      lastState = state;
    }
    if (
      targetExited &&
      descendants.length === 0 &&
      stdoutClosed &&
      stderrClosed &&
      process.stdout.writableLength === 0 &&
      process.stderr.writableLength === 0
    ) {
      finished = true;
      if (fatal || inputClosed) {
        protocol.end(() => process.exit(70));
      } else {
        send({ type: "terminal", exitCode: targetExitCode, signal: targetSignal });
        protocol.end(() => {
          input.close();
          process.exit(0);
        });
      }
      return;
    }
  } catch {
    fail("TREE_RECONCILIATION_FAILED");
  }
  setTimeout(() => void poll(), 20).unref();
};

setTimeout(() => void poll(), 0);
`;
