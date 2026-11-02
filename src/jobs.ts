import { randomBytes } from "node:crypto";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * In-memory background jobs for `claude_create_cloud_session`.
 *
 * A create can take minutes on a large repository (clone, then `claude
 * --cloud` packaging the tree), longer than an MCP client waits for one
 * request. The tool starts a job, returns its id, and callers poll
 * `claude_get_session` with that id. Jobs are never written to disk and are
 * lost when the server exits.
 */

/** Ids handed to callers: `job_` and 24 lowercase hex characters. */
export const JOB_ID_PATTERN = /^job_[0-9a-f]{24}$/;

/** Finished jobs are kept this long after they settle. */
export const JOB_TTL_MS = 60 * 60_000;
/** At most this many finished jobs are kept; the oldest go first. */
export const MAX_FINISHED_JOBS = 100;

/**
 * Phase a job reports. `done` is set only on success; a failed job reports
 * its tool error instead. `cancelled` is final and wins over a later result.
 */
export type JobStatus = "cloning" | "starting" | "running" | "done" | "cancelled";

export interface Job<T> {
  readonly id: string;
  readonly startedAt: number;
  /** Caller-owned fields describing the job; the work function may update them. */
  readonly details: T;
  status: JobStatus;
  /** Raw CLI output so far, as the pty delivered it. */
  output: string;
  finishedAt: number | null;
  /** Tool result once the job settled: the final success result or a tool error. */
  result: CallToolResult | null;
  /** Set when the work threw instead of returning a result. */
  failure: { error: unknown } | null;
  /** Resolves when the job settles. Never rejects. */
  readonly settled: Promise<void>;
}

export class JobStore<T> {
  private readonly jobs = new Map<string, Job<T>>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Start `work` in the background. `work` sets `status` as it moves between phases. */
  start(details: T, status: JobStatus, work: (job: Job<T>) => Promise<CallToolResult>): Job<T> {
    this.prune();
    const job: { -readonly [K in keyof Job<T>]: Job<T>[K] } = {
      id: `job_${randomBytes(12).toString("hex")}`,
      startedAt: this.now(),
      details,
      status,
      output: "",
      finishedAt: null,
      result: null,
      failure: null,
      settled: Promise.resolve(),
    };
    job.settled = Promise.resolve()
      .then(() => work(job))
      .then(
        (result) => {
          job.result = result;
          if (result.isError !== true && job.status !== "cancelled") job.status = "done";
        },
        (error: unknown) => {
          job.failure = { error };
        },
      )
      .finally(() => {
        job.finishedAt = this.now();
      });
    this.jobs.set(job.id, job);
    return job;
  }

  get(id: string): Job<T> | null {
    this.prune();
    return this.jobs.get(id) ?? null;
  }

  /** Jobs that have not settled yet, oldest first. */
  unfinished(): Job<T>[] {
    return [...this.jobs.values()].filter((job) => job.finishedAt === null);
  }

  /** Move a running job to another phase. A cancelled or finished job keeps its phase. */
  advance(job: Job<T>, status: JobStatus): void {
    if (job.finishedAt === null && job.status !== "cancelled") job.status = status;
  }

  /**
   * Mark a running job cancelled. Returns false when it already finished or
   * was already cancelled. The caller stops the job's processes.
   */
  cancel(job: Job<T>): boolean {
    if (job.finishedAt !== null || job.status === "cancelled") return false;
    job.status = "cancelled";
    return true;
  }

  elapsedMs(job: Job<T>): number {
    return (job.finishedAt ?? this.now()) - job.startedAt;
  }

  /** Drop expired finished jobs, then the oldest finished ones beyond the cap. Running jobs are kept. */
  private prune(): void {
    const now = this.now();
    const finished: Job<T>[] = [];
    for (const job of this.jobs.values()) {
      if (job.finishedAt === null) continue;
      if (now - job.finishedAt > JOB_TTL_MS) this.jobs.delete(job.id);
      else finished.push(job);
    }
    finished.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    for (const job of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_JOBS))) {
      this.jobs.delete(job.id);
    }
  }
}

/**
 * Wait for `job` to settle, for at most `ms`. Returns true when it settled.
 * The timer is cleared as soon as the job settles.
 */
export async function settleWithin(job: Job<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolvePromise) => {
    timer = setTimeout(() => resolvePromise(false), ms);
  });
  try {
    return await Promise.race([job.settled.then(() => true as const), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
