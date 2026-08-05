import { spawn } from "node:child_process";

export interface CapturedProcessOptions {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly inputLine?: string;
  readonly label?: string;
  readonly closeInputAfterStdoutIncludes?: string;
  readonly timeoutMs: number;
}

export interface CapturedProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function runCapturedProcess(
  options: CapturedProcessOptions,
): Promise<CapturedProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(options.executable, [...options.arguments], {
      cwd: options.cwd,
      env: options.environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let inputClosed = options.inputLine === undefined;
    let timedOut = false;
    let settled = false;
    let processError: Error | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const timeout = setTimeout(() => {
      timedOut = true;
      if (child.exitCode === null && child.signalCode === null) child.kill();
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 1_000);
    }, options.timeoutMs);

    const clearTimers = (): void => {
      clearTimeout(timeout);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (
        !inputClosed &&
        options.closeInputAfterStdoutIncludes !== undefined &&
        stdout.includes(options.closeInputAfterStdoutIncludes)
      ) {
        inputClosed = true;
        child.stdin.end();
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      processError = error;
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (timedOut) {
        const suffix = options.label === undefined ? "" : `: ${options.label}`;
        reject(new Error(`fixture process timed out${suffix}`));
        return;
      }
      if (processError !== undefined) {
        reject(processError);
        return;
      }
      resolvePromise({ exitCode: signal === null ? (code ?? 1) : 1, stdout, stderr });
    });

    if (options.inputLine === undefined) {
      child.stdin.end();
    } else {
      child.stdin.write(options.inputLine);
    }
  });
}

export function runCapturedRpcCommand(
  options: Omit<CapturedProcessOptions, "closeInputAfterStdoutIncludes" | "inputLine">,
  command: Readonly<Record<string, unknown>>,
): Promise<CapturedProcessResult> {
  const commandId = command["id"];
  if (typeof commandId !== "string") throw new Error("RPC fixture command id is required");
  return runCapturedProcess({
    ...options,
    closeInputAfterStdoutIncludes: `"id":"${commandId}"`,
    inputLine: `${JSON.stringify(command)}\n`,
  });
}
