import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { KILL_GRACE_MS, killGroup, track } from "./children.js";
import { cliNotFoundMessage } from "./prereq.js";

/** Per-stream cap on captured output, to bound memory. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

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

/** Called with stdout as it arrives, decoded as UTF-8, whether or not it fits under the capture cap. */
export type StdoutListener = (text: string) => void;

export type Runner = (
  bin: string,
  args: string[],
  timeoutMs: number,
  cwd: string,
  onStdout?: StdoutListener,
) => Promise<RunResult>;

/**
 * Spawns `bin` with an argv array (never a shell), stdin closed, and a hard
 * timeout. The child leads its own process group and is tracked so a cancel
 * or shutdown can stop it. `cwd` is the directory the CLI runs in. `onStdout` sees
 * stdout as it arrives. Resolves with the outcome
 * for any process that started; rejects with RunError only when the process
 * could not be started.
 */
export const runCli: Runner = (bin, args, timeoutMs, cwd, onStdout) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(bin, args, {
      shell: false,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
      windowsHide: true,
      detached: true,
    });
    track(child);

    const stdout = collector();
    const stderr = collector();
    const decoder = new StringDecoder("utf8");
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      onStdout?.(decoder.write(chunk));
    });
    child.stdout.once("end", () => {
      const rest = decoder.end();
      if (rest !== "") onStdout?.(rest);
    });
    child.stderr.on("data", stderr.push);

    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    }, timeoutMs);

    child.once("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (err.code === "ENOENT") {
        reject(new RunError("CLI_NOT_FOUND", cliNotFoundMessage(bin)));
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
