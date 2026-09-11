import { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Event } from "@aicommander/protocol";

/**
 * Guard 4: a shell command that outruns its timeout is not killed — it becomes a
 * background job.
 *
 * Killing `npm run dev` because it took more than two minutes is the wrong answer: it
 * was supposed to keep running. The tool returns a jobId and a tail, output keeps
 * streaming to a log tab, and the model can poll with the `job` tool.
 *
 * v1 keeps no persistence: jobs are children of this process and die with it. The log
 * view says so rather than implying a job will be there after a restart.
 */

/** Lines kept per job. Enough to see what happened, bounded so a chatty server
 *  cannot grow the backend's memory without limit. */
const RING_SIZE = 200;

/** A killed process gets SIGTERM first, then SIGKILL if it ignores it. */
const SIGKILL_AFTER_MS = 5000;

export interface JobSummary {
  jobId: string;
  cmd: string;
  running: boolean;
  exitCode: number | null;
  killed: boolean;
  startedAt: number;
  endedAt?: number;
  /** Lines currently in the ring buffer. */
  lines: number;
}

interface Job extends JobSummary {
  child: ChildProcess;
  /** Ring buffer of the last RING_SIZE lines. */
  ring: string[];
  /** Partial line waiting for its newline. */
  pending: string;
}

export class JobRegistry {
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly emit: (event: Event) => void) {}

  /**
   * Adopt a running child as a job. Called when a shell tool times out, so the
   * process is never interrupted — only re-parented.
   */
  adopt(child: ChildProcess, cmd: string, sessionId: string, existing: string): string {
    const jobId = randomUUID().slice(0, 8);
    const job: Job = {
      jobId, cmd, child,
      running: true, exitCode: null, killed: false,
      startedAt: Date.now(),
      ring: [], pending: "", lines: 0,
    };
    this.jobs.set(jobId, job);

    // Whatever the tool already collected seeds the buffer, so the log is continuous.
    for (const line of existing.split("\n")) this.push(job, line);

    const collect = (d: Buffer): void => {
      const text = d.toString();
      this.emit({ id: randomUUID(), type: "job.output", jobId, delta: text });
      job.pending += text;
      const parts = job.pending.split("\n");
      job.pending = parts.pop() ?? "";
      for (const line of parts) this.push(job, line);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    child.on("close", (code, signal) => {
      if (job.pending) {
        this.push(job, job.pending);
        job.pending = "";
      }
      job.running = false;
      job.exitCode = code;
      job.endedAt = Date.now();
      if (signal) job.killed = true;
      this.emit({ id: randomUUID(), type: "job.end", jobId, code, killed: job.killed });
    });

    this.emit({ id: randomUUID(), type: "job.start", jobId, sessionId, cmd });
    return jobId;
  }

  private push(job: Job, line: string): void {
    if (line === "" && job.ring.length === 0) return;
    job.ring.push(line);
    if (job.ring.length > RING_SIZE) job.ring.shift();
    job.lines = job.ring.length;
  }

  get(jobId: string): JobSummary | undefined {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;
    const { child, ring, pending, ...summary } = job;
    return summary;
  }

  list(): JobSummary[] {
    return [...this.jobs.values()].map(({ child, ring, pending, ...s }) => s);
  }

  /** The tail of a job's output — at most `lines` of the ring buffer. */
  output(jobId: string, lines = RING_SIZE): string | undefined {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;
    const tail = job.ring.slice(-lines);
    return job.pending ? [...tail, job.pending].join("\n") : tail.join("\n");
  }

  /** SIGTERM, then SIGKILL if the process is still there five seconds later. */
  kill(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || !job.running) return false;
    job.killed = true;
    job.child.kill("SIGTERM");
    setTimeout(() => {
      if (job.running) job.child.kill("SIGKILL");
    }, SIGKILL_AFTER_MS).unref?.();
    return true;
  }

  /** Kill everything on shutdown: jobs do not outlive the backend in v1. */
  killAll(): void {
    for (const job of this.jobs.values()) {
      if (job.running) job.child.kill("SIGKILL");
    }
    this.jobs.clear();
  }
}

export { RING_SIZE, SIGKILL_AFTER_MS };
