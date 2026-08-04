export const posixProcessGroupHelperSource = String.raw`
import { readdir, readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const protocol = createWriteStream(null, { fd: 3, autoClose: false });
const send = (value) => {
  protocol.write(JSON.stringify(value) + "\n");
};

const parseProcessGroup = async (pid) => {
  const value = await readFile("/proc/" + String(pid) + "/stat", "utf8");
  const end = value.lastIndexOf(")");
  if (end < 0) throw new Error("PROC_STAT_INVALID");
  const fields = value.slice(end + 2).trim().split(/\s+/u);
  if (fields.length < 20) throw new Error("PROC_STAT_INVALID");
  return Number(fields[2]);
};

const groupMembers = async (groupId) => {
  const entries = await readdir("/proc", { withFileTypes: true });
  const members = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    const pid = Number(entry.name);
    try {
      if (await parseProcessGroup(pid) === groupId) members.push(pid);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ESRCH") throw error;
    }
  }
  return members;
};

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let request;
let target;
let finished = false;
let inputClosed = false;
let stdoutClosed = false;
let stderrClosed = false;
let targetExited = false;
let targetExitCode = null;
let targetSignal = null;
let lastState = "";

const killOwnGroup = () => {
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    process.exit(70);
  }
};

input.once("line", (line) => {
  try {
    request = JSON.parse(line);
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
      send({ type: "error", code: "TARGET_SPAWN_FAILED" });
      killOwnGroup();
    });
    target.once("exit", (code, signal) => {
      targetExited = true;
      targetExitCode = code;
      targetSignal = signal;
    });
  } catch {
    send({ type: "error", code: "REQUEST_INVALID" });
    process.exit(64);
  }
});

input.on("close", () => {
  inputClosed = true;
  if (!finished) killOwnGroup();
});

const poll = async () => {
  if (finished) return;
  if (target === undefined) {
    setTimeout(() => {
      void poll();
    }, 20).unref();
    return;
  }
  if (inputClosed) return;
  try {
    const members = (await groupMembers(process.pid)).filter((pid) => pid !== process.pid);
    const treeState = members.length === 0 ? "EMPTY" : "ACTIVE";
    const phase = targetExited ? "EXITED" : "RUNNING";
    const state = [phase, treeState, stdoutClosed, stderrClosed, targetExitCode, targetSignal].join("|");
    if (state !== lastState) {
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
      members.length === 0 &&
      stdoutClosed &&
      stderrClosed &&
      process.stdout.writableLength === 0 &&
      process.stderr.writableLength === 0
    ) {
      finished = true;
      send({
        type: "terminal",
        exitCode: targetExitCode,
        signal: targetSignal,
      });
      protocol.end(() => {
        input.close();
        process.exit(0);
      });
      return;
    }
  } catch {
    send({ type: "error", code: "GROUP_RECONCILIATION_FAILED" });
    killOwnGroup();
    return;
  }
  setTimeout(() => {
    void poll();
  }, 20).unref();
};

setTimeout(() => {
  void poll();
}, 0);
`;
