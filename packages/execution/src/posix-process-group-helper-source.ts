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

export const linuxPidfdSignalSource = String.raw`
import os
import signal
import sys

EXIT_GONE = 3
EXIT_IDENTITY_CHANGED = 42
EXIT_UNAVAILABLE = 70

try:
    pid = int(sys.argv[1])
    expected_start_time = sys.argv[2]
    if pid <= 0 or not expected_start_time.isdigit():
        raise ValueError("invalid identity")
except (IndexError, ValueError):
    sys.exit(EXIT_UNAVAILABLE)

try:
    pidfd = os.pidfd_open(pid, 0)
except ProcessLookupError:
    sys.exit(EXIT_GONE)
except (AttributeError, OSError):
    sys.exit(EXIT_UNAVAILABLE)

try:
    try:
        with open(f"/proc/{pid}/stat", "r", encoding="utf-8") as proc_stat:
            value = proc_stat.read()
    except FileNotFoundError:
        sys.exit(EXIT_GONE)
    end = value.rfind(")")
    fields = value[end + 2:].strip().split() if end >= 0 else []
    if len(fields) < 20 or fields[19] != expected_start_time:
        sys.exit(EXIT_IDENTITY_CHANGED)
    try:
        signal.pidfd_send_signal(pidfd, signal.SIGKILL)
    except ProcessLookupError:
        sys.exit(EXIT_GONE)
    except (AttributeError, OSError):
        sys.exit(EXIT_UNAVAILABLE)
finally:
    os.close(pidfd)
`;

export type LinuxTreeFinalityEvent = "ACTIVE" | "CONTROL_BOUNDARY" | "EMPTY";

export function nextLinuxCompleteEmptyScanCount(
  current: number,
  event: LinuxTreeFinalityEvent,
): number {
  if (event !== "EMPTY") return 0;
  return Math.min(current + 1, 2);
}

const linuxCompleteEmptyScanTransitionSource = nextLinuxCompleteEmptyScanCount.toString();

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
const infrastructurePids = new Set();
const nextLinuxCompleteEmptyScanCount = (${linuxCompleteEmptyScanTransitionSource});
const pidfdSignalerPath = process.argv[2];
if (typeof pidfdSignalerPath !== "string" || pidfdSignalerPath.length === 0) {
  throw new Error("PIDFD_SIGNALER_UNAVAILABLE");
}

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
      if (
        identity.state !== "Z" &&
        identity.state !== "X" &&
        !infrastructurePids.has(identity.pid)
      ) {
        descendants.push(identity);
      }
    }
  }
  return descendants;
};

const readDirectLiveChildPids = async () => {
  const taskEntries = await readdir("/proc/" + String(process.pid) + "/task", {
    withFileTypes: true,
  });
  const directLiveChildPids = new Set();
  for (const taskEntry of taskEntries) {
    if (!taskEntry.isDirectory() || !/^\d+$/u.test(taskEntry.name)) continue;
    let value;
    try {
      value = await readFile(
        "/proc/" + String(process.pid) + "/task/" + taskEntry.name + "/children",
        "utf8",
      );
    } catch (error) {
      if (ignoredProcErrors.has(error?.code)) continue;
      throw error;
    }
    for (const token of value.trim().split(/\s+/u)) {
      if (!/^\d+$/u.test(token)) continue;
      const pid = Number(token);
      if (infrastructurePids.has(pid)) continue;
      try {
        const identity = await parseProcIdentity(pid);
        if (identity.state !== "Z" && identity.state !== "X") {
          directLiveChildPids.add(pid);
        }
      } catch (error) {
        if (!ignoredProcErrors.has(error?.code)) throw error;
        // The kernel listed this child during the scan. Treat a concurrent
        // disappearance as active for this observation so it invalidates any
        // earlier empty candidate.
        directLiveChildPids.add(pid);
      }
    }
  }
  return directLiveChildPids;
};

const scanOwnedTree = async () => {
  const directChildrenBefore = await readDirectLiveChildPids();
  const descendants = await liveDescendants();
  const directChildrenAfter = await readDirectLiveChildPids();
  return {
    descendants,
    active:
      descendants.length > 0 ||
      directChildrenBefore.size > 0 ||
      directChildrenAfter.size > 0,
  };
};

const signalIdentityWithPidfd = (identity) =>
  new Promise((resolve, reject) => {
    const signaler = spawn(
      "/usr/bin/python3",
      [pidfdSignalerPath, String(identity.pid), identity.startTime],
      { shell: false, stdio: "ignore" },
    );
    if (signaler.pid !== undefined) infrastructurePids.add(signaler.pid);
    signaler.once("error", reject);
    signaler.once("close", (code) => {
      if (signaler.pid !== undefined) infrastructurePids.delete(signaler.pid);
      if (code === 0) {
        resolve(true);
        return;
      }
      if (code === 3) {
        resolve(false);
        return;
      }
      reject(new Error(code === 42 ? "PROCESS_IDENTITY_CHANGED" : "PIDFD_SIGNAL_FAILED"));
    });
  });

const killIdentified = async (identities) => {
  let signaled = false;
  for (const identity of identities) {
    signaled = (await signalIdentityWithPidfd(identity)) || signaled;
  }
  return signaled;
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
let lastState = "";
let consecutiveCompleteEmptyScans = 0;

const fail = (code) => {
  if (fatal) return;
  fatal = true;
  try {
    send({ type: "error", code });
  } catch {
    // The parent may already be gone. Cleanup continues without a PASS receipt.
  }
};

const requestTermination = (cause) => {
  if (fatal || finished) return;
  if (terminationCause !== "NONE" && terminationCause !== cause) {
    fail("TERMINATION_CAUSE_CONFLICT");
    return;
  }
  if (terminationAcknowledged) {
    send({ type: "terminationAcknowledged", cause });
    return;
  }
  if (terminationCause === cause) return;
  terminationCause = cause;
  consecutiveCompleteEmptyScans = nextLinuxCompleteEmptyScanCount(
    consecutiveCompleteEmptyScans,
    "CONTROL_BOUNDARY",
  );
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
    await scanOwnedTree();
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
    requestTermination(command.cause);
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
    let treeScan = await scanOwnedTree();
    consecutiveCompleteEmptyScans = nextLinuxCompleteEmptyScanCount(
      consecutiveCompleteEmptyScans,
      treeScan.active ? "ACTIVE" : "EMPTY",
    );
    let treeEmpty = consecutiveCompleteEmptyScans >= 2;
    const terminationPending = terminationCause !== "NONE" && !terminationAcknowledged;
    if (
      (fatal || inputClosed || terminationPending || terminationAcknowledged) &&
      treeScan.descendants.length > 0
    ) {
      const signaled = await killIdentified(treeScan.descendants);
      if (terminationPending && signaled) {
        terminationAcknowledged = true;
        consecutiveCompleteEmptyScans = nextLinuxCompleteEmptyScanCount(
          consecutiveCompleteEmptyScans,
          "CONTROL_BOUNDARY",
        );
        send({ type: "terminationAcknowledged", cause: terminationCause });
      }
      treeScan = await scanOwnedTree();
      consecutiveCompleteEmptyScans = nextLinuxCompleteEmptyScanCount(
        consecutiveCompleteEmptyScans,
        treeScan.active ? "ACTIVE" : "EMPTY",
      );
      treeEmpty = consecutiveCompleteEmptyScans >= 2;
    }
    if (terminationPending && !terminationAcknowledged && treeEmpty) {
      const notAppliedCause = terminationCause;
      terminationCause = "NONE";
      send({ type: "terminationNotApplied", cause: notAppliedCause });
    }
    // Every complete scan, including the pre-signal scan, participates in the
    // same serialized sequence. A direct-child snapshot sandwiches the
    // non-atomic whole-/proc traversal, and any active observation or control
    // boundary invalidates the earlier empty candidate.
    const treeState = treeEmpty ? "EMPTY" : "ACTIVE";
    const phase =
      terminationAcknowledged && !treeEmpty
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
      treeEmpty &&
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
