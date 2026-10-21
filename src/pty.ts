import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunError, type RunResult } from "./runner.js";

/** Per-stream cap on captured output, to bound memory. Mirrors runner.ts. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Grace period between SIGTERM and SIGKILL after a timeout or trust refusal. */
const KILL_GRACE_MS = 5_000;
/**
 * Delay before answering the trust dialog. Claude Code switches the pty into
 * raw mode as it draws the prompt and may flush input queued before that;
 * a short wait lets the dialog install its key handler first.
 */
const TRUST_ACCEPT_DELAY_MS = 100;

export interface PtyRunResult extends RunResult {
  /**
   * `refused` when the workspace-trust dialog was shown and this run was told
   * not to answer it. `accepted` when it was shown and an Enter key was sent.
   */
  trustPrompt: "absent" | "accepted" | "refused";
}

export type PtyTrustDecision = "accept" | "refuse" | "wait";

export interface PtyRunOptions {
  /** Python interpreter used to allocate the pty. */
  pythonBin: string;
  /** Directory the CLI runs in. `claude --cloud` packages this tree. */
  cwd: string;
  /** Called with the raw output so far. Invoked again as more output arrives. */
  onOutput?: (output: string) => PtyTrustDecision;
}

/**
 * PTY allocator. Python's stdlib `pty` module is used instead of util-linux
 * `script` because `script` leaves the pty at 0×0 columns, which collapses
 * Claude Code's dialog, and because the helper can record the child pid for
 * a reliable timeout. The helper execs `bin` with `args` directly (no shell).
 * Stdout and stderr share the terminal, so both are returned in `stdout`.
 */
const PTY_HELPER_PY = String.raw`import errno, fcntl, json, os, pty, select, signal, struct, sys, termios

def write_all(fd, data):
    view = memoryview(data)
    while len(view):
        try:
            n = os.write(fd, view)
        except InterruptedError:
            continue
        if n <= 0:
            break
        view = view[n:]

def main():
    if len(sys.argv) != 2:
        sys.stderr.write("pty helper: expected a spec path\n")
        os._exit(2)
    with open(sys.argv[1], encoding="utf-8") as fh:
        spec = json.load(fh)
    bin_path = spec["bin"]
    args = spec["args"]
    pid_file = spec["pidFile"]
    rows = int(spec.get("rows", 40))
    cols = int(spec.get("cols", 120))
    if not isinstance(bin_path, str) or not isinstance(args, list) or not all(isinstance(a, str) for a in args):
        sys.stderr.write("pty helper: invalid spec\n")
        os._exit(2)

    pid, master = pty.fork()
    if pid == 0:
        try:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        except OSError:
            pass
        try:
            os.execvp(bin_path, [bin_path, *args])
        except OSError as exc:
            msg = (
                "claude binary not found: %s\n" % bin_path
                if exc.errno == errno.ENOENT
                else "failed to start %s: %s\n" % (bin_path, exc)
            )
            try:
                os.write(2, msg.encode())
            except OSError:
                pass
            os._exit(127)

    try:
        with open(pid_file, "w", encoding="utf-8") as fh:
            json.dump({"childPid": pid}, fh)
            fh.flush()
    except OSError:
        pass

    def stop_child(_signum, _frame):
        try:
            os.killpg(pid, signal.SIGTERM)
        except OSError:
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass

    signal.signal(signal.SIGTERM, stop_child)
    signal.signal(signal.SIGINT, stop_child)
    signal.signal(signal.SIGHUP, stop_child)

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    stdin_open = True
    child_done = False
    status = 1
    os.set_blocking(master, False)
    try:
        os.set_blocking(stdin_fd, False)
    except OSError:
        stdin_open = False

    def drain():
        while True:
            try:
                data = os.read(master, 65536)
            except OSError as exc:
                if exc.errno == errno.EAGAIN:
                    return
                return
            if not data:
                return
            try:
                write_all(stdout_fd, data)
            except OSError:
                return

    while not child_done:
        try:
            wpid, status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            child_done = True
            break
        if wpid == pid:
            child_done = True
            break
        watch = [master]
        if stdin_open:
            watch.append(stdin_fd)
        try:
            readable, _, _ = select.select(watch, [], [], 0.2)
        except InterruptedError:
            continue
        if master in readable:
            drain()
        if stdin_open and stdin_fd in readable:
            try:
                incoming = os.read(stdin_fd, 65536)
            except OSError:
                incoming = b""
            if incoming:
                try:
                    write_all(master, incoming)
                except OSError:
                    pass
            else:
                stdin_open = False
    drain()
    try:
        os.close(master)
    except OSError:
        pass
    if os.WIFEXITED(status):
        os._exit(os.WEXITSTATUS(status))
    if os.WIFSIGNALED(status):
        os._exit(128 + os.WTERMSIG(status))
    os._exit(1)

if __name__ == "__main__":
    main()
`;

/** Turn pty newlines (`\r\n` and bare `\r` from the line discipline) into `\n`. */
export function normalizePtyText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Run `bin` on a pseudo-terminal so `claude --cloud=<description>` sees an
 * interactive stdout. `shell` is never used. Rejects with RunError only when
 * Python itself cannot be started.
 */
export function runCliPty(bin: string, args: string[], timeoutMs: number, options: PtyRunOptions): Promise<PtyRunResult> {
  const dir = mkdtempSync(join(tmpdir(), "claude-mcp-pty-"));
  const helperPath = join(dir, "pty-helper.py");
  const specPath = join(dir, "spec.json");
  const pidPath = join(dir, "child.json");
  writeFileSync(helperPath, PTY_HELPER_PY, { mode: 0o600 });

  const columns = dimension(process.env.COLUMNS, 120);
  const rows = dimension(process.env.LINES, 40);
  writeFileSync(specPath, JSON.stringify({ bin, args, pidFile: pidPath, rows, cols: columns }), { mode: 0o600 });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NO_COLOR: "1",
    TERM: process.env.TERM || "xterm-256color",
    COLUMNS: String(columns),
    LINES: String(rows),
  };

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(options.pythonBin, ["-I", helperPath, specPath], {
      shell: false,
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env,
      windowsHide: true,
    });
    child.stdin.on("error", () => {
      // The helper may exit before a trust keystroke is written.
    });

    const stdout = collector();
    const stderr = collector();
    let trustPrompt: PtyRunResult["trustPrompt"] = "absent";
    let acceptTimer: NodeJS.Timeout | undefined;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const killTree = (signal: NodeJS.Signals) => {
      killRecordedChild(pidPath, signal);
      try {
        child.kill(signal);
      } catch {
        // already exited
      }
    };

    const armKill = () => {
      killTree("SIGTERM");
      killTimer = setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    };

    const consider = () => {
      if (trustPrompt !== "absent" || settled) return;
      const decision = options.onOutput?.(stdout.text()) ?? "wait";
      if (decision === "wait") return;
      if (decision === "refuse") {
        trustPrompt = "refused";
        armKill();
        return;
      }
      trustPrompt = "accepted";
      acceptTimer = setTimeout(() => {
        if (settled) return;
        try {
          child.stdin.write("\r");
        } catch {
          // stdin already closed
        }
      }, TRUST_ACCEPT_DELAY_MS);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      consider();
    });
    child.stderr.on("data", stderr.push);

    const timer = setTimeout(() => {
      timedOut = true;
      armKill();
    }, timeoutMs);

    const finish = (result: PtyRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (acceptTimer) clearTimeout(acceptTimer);
      if (killTimer) clearTimeout(killTimer);
      rmSync(dir, { recursive: true, force: true });
      resolve(result);
    };

    child.once("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (acceptTimer) clearTimeout(acceptTimer);
      if (killTimer) clearTimeout(killTimer);
      rmSync(dir, { recursive: true, force: true });
      if (err.code === "ENOENT") {
        reject(
          new RunError(
            "PTY_UNAVAILABLE",
            `python3 is required to allocate a pseudo-terminal for claude --cloud, and ${options.pythonBin} was not found (set CLAUDE_MCP_PYTHON)`,
          ),
        );
      } else {
        reject(new RunError("CLI_SPAWN_FAILED", `failed to start ${options.pythonBin}: ${err.message}`));
      }
    });

    child.once("close", (exitCode, signal) => {
      finish({
        exitCode,
        signal,
        stdout: normalizePtyText(stdout.text()),
        stderr: normalizePtyText(stderr.text()),
        timedOut,
        durationMs: Date.now() - started,
        trustPrompt,
      });
    });
  });
}

function dimension(raw: string | undefined, fallback: number): number {
  if (raw && /^[1-9][0-9]{0,2}$/.test(raw)) {
    const n = Number(raw);
    if (n >= 20 && n <= 500) return n;
  }
  return fallback;
}

function killRecordedChild(pidPath: string, signal: NodeJS.Signals) {
  let childPid: number | undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(pidPath, "utf8"));
    if (typeof parsed === "object" && parsed !== null && "childPid" in parsed) {
      const value = (parsed as { childPid?: unknown }).childPid;
      if (typeof value === "number" && value > 0) childPid = value;
    }
  } catch {
    return;
  }
  if (childPid === undefined) return;
  try {
    process.kill(-childPid, signal);
  } catch {
    try {
      process.kill(childPid, signal);
    } catch {
      // exited, or not a process group
    }
  }
}

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
