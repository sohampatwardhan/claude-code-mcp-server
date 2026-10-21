import { spawn } from "node:child_process";

/** Per-stream cap on captured output, to bound memory. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Grace period between SIGTERM and SIGKILL after a timeout. */
const KILL_GRACE_MS = 5_000;

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export type RunErrorCode = "CLI_NOT_FOUND" | "CLI_SPAWN_FAILED" | "PTY_UNAVAILABLE";

export class RunError extends Error {
  override name = "RunError";
  constructor(
    readonly code: RunErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type Runner = (bin: string, args: string[], timeoutMs: number, cwd: string) => Promise<RunResult>;

/**
 * Spawns `bin` with an argv array (never a shell), stdin closed, and a hard
 * timeout. `cwd` is the directory the CLI runs in. Resolves with the outcome
 * for any process that started; rejects with RunError only when the process
 * could not be started.
 */
export const runCli: Runner = (bin, args, timeoutMs, cwd) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(bin, args, {
      shell: false,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
      windowsHide: true,
    });

    const stdout = collector();
    const stderr = collector();
    child.stdout.on("data", stdout.push);
    child.stderr.on("data", stderr.push);

    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    }, timeoutMs);

    child.once("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (err.code === "ENOENT") {
        reject(new RunError("CLI_NOT_FOUND", `claude binary not found: ${bin} (set CLAUDE_BIN)`));
      } else {
        reject(new RunError("CLI_SPAWN_FAILED", `failed to start ${bin}: ${err.message}`));
      }
    });

    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        exitCode,
        signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        timedOut,
        durationMs: Date.now() - started,
      });
    });
  });

function collector() {
  const chunks: Buffer[] = [];
  let size = 0;
  return {
    push: (chunk: Buffer) => {
      if (size >= MAX_OUTPUT_BYTES) return;
      const room = MAX_OUTPUT_BYTES - size;
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
      chunks.push(piece);
      size += piece.length;
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}
