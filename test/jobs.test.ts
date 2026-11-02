import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { JOB_ID_PATTERN, JOB_TTL_MS, JobStore, MAX_FINISHED_JOBS, settleWithin } from "../src/jobs.js";

const okResult: CallToolResult = { content: [], structuredContent: {} };
const errorResult: CallToolResult = { isError: true, content: [] };

function clock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("JobStore", () => {
  it("issues unique job ids that match the schema pattern", () => {
    const store = new JobStore<null>();
    const a = store.start(null, "starting", async () => okResult);
    const b = store.start(null, "starting", async () => okResult);
    assert.match(a.id, JOB_ID_PATTERN);
    assert.match(b.id, JOB_ID_PATTERN);
    assert.notEqual(a.id, b.id);
  });

  it("marks a successful job done and keeps its result", async () => {
    const time = clock();
    const store = new JobStore<null>(time.now);
    const job = store.start(null, "cloning", async (started) => {
      started.status = "starting";
      time.advance(250);
      return okResult;
    });
    await job.settled;
    assert.equal(job.status, "done");
    assert.equal(job.result, okResult);
    assert.equal(job.failure, null);
    assert.equal(store.elapsedMs(job), 250);
    time.advance(10_000);
    assert.equal(store.elapsedMs(job), 250, "elapsed time stops when the job settles");
  });

  it("keeps a tool error as the result without marking the job done", async () => {
    const store = new JobStore<null>();
    const job = store.start(null, "starting", async () => errorResult);
    await job.settled;
    assert.equal(job.status, "starting");
    assert.equal(job.result, errorResult);
  });

  it("captures a thrown error instead of rejecting", async () => {
    const store = new JobStore<null>();
    const boom = new Error("boom");
    const job = store.start(null, "starting", async () => {
      throw boom;
    });
    await job.settled;
    assert.equal(job.result, null);
    assert.equal(job.failure?.error, boom);
    assert.notEqual(job.finishedAt, null);
  });

  it("drops finished jobs after the TTL and keeps running ones", async () => {
    const time = clock();
    const store = new JobStore<null>(time.now);
    const finished = store.start(null, "starting", async () => okResult);
    let release: (value: CallToolResult) => void = () => undefined;
    const running = store.start(null, "starting", () => new Promise((resolvePromise) => (release = resolvePromise)));
    await finished.settled;
    time.advance(JOB_TTL_MS + 1);
    assert.equal(store.get(finished.id), null);
    assert.equal(store.get(running.id), running);
    release(okResult);
    await running.settled;
  });

  it("keeps at most MAX_FINISHED_JOBS finished jobs, dropping the oldest", async () => {
    const time = clock();
    const store = new JobStore<null>(time.now);
    const ids: string[] = [];
    for (let i = 0; i <= MAX_FINISHED_JOBS; i++) {
      const job = store.start(null, "starting", async () => okResult);
      await job.settled;
      ids.push(job.id);
      time.advance(1);
    }
    assert.equal(store.get(ids[0] ?? ""), null);
    assert.notEqual(store.get(ids[1] ?? ""), null);
    assert.notEqual(store.get(ids.at(-1) ?? ""), null);
  });
});

describe("settleWithin", () => {
  it("returns true when the job settles in time and false when it does not", async () => {
    const store = new JobStore<null>();
    const fast = store.start(null, "starting", async () => okResult);
    assert.equal(await settleWithin(fast, 1_000), true);
    let release: (value: CallToolResult) => void = () => undefined;
    const slow = store.start(null, "starting", () => new Promise((resolvePromise) => (release = resolvePromise)));
    assert.equal(await settleWithin(slow, 20), false);
    release(okResult);
    await slow.settled;
  });
});
