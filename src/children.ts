import { AsyncLocalStorage } from "node:async_hooks";
import type { ChildProcess } from "node:child_process";

/**
 * Registry of every child process this server starts, so a cancel or a
 * shutdown can stop it.
 *
 * Children are spawned with `detached: true`, so each one leads its own
 * process group and a signal reaches everything it started. A `Scope` groups
 * the children of one create job or one tool request; spawn sites find the
 * current scope through AsyncLocalStorage, so cancellation needs no extra
 * parameters threaded through git and CLI helpers.
 */

/** Grace period between SIGTERM and SIGKILL. */
export const KILL_GRACE_MS = 5_000;

export type Killer = (signal: NodeJS.Signals) => void;

interface Entry {
  child: ChildProcess;
  kill: Killer;
  exited: boolean;
  killTimer: NodeJS.Timeout | undefined;
}

export class Scope {
  private abortedFlag = false;
  readonly entries = new Set<Entry>();

  get aborted(): boolean {
    return this.abortedFlag;
  }

  /** Stop every child in this scope, and any started in it later. Idempotent. */
  abort(): void {
    if (this.abortedFlag) return;
    this.abortedFlag = true;
    for (const entry of this.entries) terminate(entry);
  }

  /** True when no child started in this scope is still running. */
  get idle(): boolean {
    for (const entry of this.entries) if (!entry.exited) return false;
    return true;
  }
}

const storage = new AsyncLocalStorage<Scope>();
const live = new Set<Entry>();

/** Run `fn` with `scope` as the current scope for every child it starts. */
export function runInScope<T>(scope: Scope, fn: () => Promise<T>): Promise<T> {
  return storage.run(scope, fn);
}

/** The scope of the job or request this code runs for, if any. */
export function currentScope(): Scope | undefined {
  return storage.getStore();
}

/**
 * Abort `scope` when `signal` aborts (an MCP request the client cancelled).
 * Returns a function that removes the listener.
 */
export function abortOnSignal(scope: Scope, signal: AbortSignal | undefined): () => void {
  if (signal === undefined) return () => undefined;
  if (signal.aborted) {
    scope.abort();
    return () => undefined;
  }
  const onAbort = () => scope.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/** Signal the process group `child` leads, falling back to the child alone. */
export function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // not a group leader, or already gone
    }
  }
  try {
    child.kill(signal);
  } catch {
    // already exited
  }
}

/**
 * Record `child` in the registry and the current scope. `kill` signals it and
 * everything it started; the default signals its process group. A child
 * started in an aborted scope is stopped at once.
 */
export function track(child: ChildProcess, kill: Killer = (signal) => killGroup(child, signal)): void {
  const entry: Entry = { child, kill, exited: false, killTimer: undefined };
  const scope = currentScope();
  live.add(entry);
  scope?.entries.add(entry);
  const done = () => {
    entry.exited = true;
    if (entry.killTimer) clearTimeout(entry.killTimer);
    live.delete(entry);
  };
  child.once("exit", done);
  child.once("error", done);
  if (scope?.aborted === true) terminate(entry);
}

/** Number of tracked children still running. */
export function liveChildren(): number {
  return live.size;
}

/**
 * Stop every tracked child: SIGTERM now, SIGKILL to any still running after
 * `graceMs`. Resolves once all have exited or shortly after the SIGKILL.
 */
export async function stopAll(graceMs: number = KILL_GRACE_MS): Promise<void> {
  const entries = [...live];
  for (const entry of entries) entry.kill("SIGTERM");
  const deadline = Date.now() + graceMs;
  while (live.size > 0 && Date.now() < deadline) await sleep(25);
  for (const entry of [...live]) entry.kill("SIGKILL");
  const after = Date.now() + 500;
  while (live.size > 0 && Date.now() < after) await sleep(25);
}

function terminate(entry: Entry): void {
  if (entry.exited) return;
  entry.kill("SIGTERM");
  if (entry.killTimer) return;
  entry.killTimer = setTimeout(() => {
    if (!entry.exited) entry.kill("SIGKILL");
  }, KILL_GRACE_MS);
  entry.killTimer.unref();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
