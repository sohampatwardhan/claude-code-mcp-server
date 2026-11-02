import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { describe, it } from "node:test";

import { Scope, abortOnSignal, killGroup, liveChildren, runInScope, stopAll, track } from "../src/children.js";

/** A detached node process that starts a sleeping grandchild and prints its pid. */
function spawnParentOfSleeper(): { child: ChildProcess; grandchild: Promise<number> } {
  const code =
    "const { spawn } = require('node:child_process');" +
    "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });" +
    "process.stdout.write(String(g.pid) + '\\n');" +
    "setInterval(() => {}, 1000);";
  const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "ignore"], detached: true });
  const grandchild = new Promise<number>((resolvePromise) => {
    child.stdout?.once("data", (chunk: Buffer) => resolvePromise(Number(chunk.toString("utf8").trim())));
  });
  return { child, grandchild };
}

function spawnSleeper(): ChildProcess {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  return check();
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null || child.signalCode !== null) resolvePromise();
    else child.once("exit", () => resolvePromise());
  });
}

describe("process registry", () => {
  it("signals the whole process group, including grandchildren", async () => {
    const { child, grandchild } = spawnParentOfSleeper();
    track(child);
    const grandPid = await grandchild;
    assert.ok(alive(grandPid));
    killGroup(child, "SIGTERM");
    await exited(child);
    assert.ok(await waitFor(() => !alive(grandPid)), "grandchild should exit with its group");
  });

  it("aborting a scope stops its children and any started in it later", async () => {
    const scope = new Scope();
    const first = await runInScope(scope, async () => {
      const child = spawnSleeper();
      track(child);
      return child;
    });
    const other = spawnSleeper();
    track(other);
    assert.equal(scope.idle, false);
    scope.abort();
    await exited(first);
    assert.equal(scope.idle, true);
    assert.equal(other.exitCode === null && other.signalCode === null, true, "a child outside the scope keeps running");

    const late = await runInScope(scope, async () => {
      const child = spawnSleeper();
      track(child);
      return child;
    });
    await exited(late);
    killGroup(other, "SIGKILL");
    await exited(other);
  });

  it("aborts a scope when the request signal aborts", async () => {
    const scope = new Scope();
    const controller = new AbortController();
    const detach = abortOnSignal(scope, controller.signal);
    const child = await runInScope(scope, async () => {
      const spawned = spawnSleeper();
      track(spawned);
      return spawned;
    });
    controller.abort();
    await exited(child);
    assert.equal(scope.aborted, true);
    detach();
  });

  it("stopAll stops every tracked child", async () => {
    const a = spawnSleeper();
    const b = spawnSleeper();
    track(a);
    track(b);
    assert.ok(liveChildren() >= 2);
    await stopAll(2_000);
    assert.equal(liveChildren(), 0);
    assert.notEqual(a.exitCode ?? a.signalCode, null);
    assert.notEqual(b.exitCode ?? b.signalCode, null);
  });
});
