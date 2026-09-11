import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { Event } from "@aicommander/protocol";
import { JobRegistry, RING_SIZE } from "../src/jobs.js";

/** §6 guard 4: a timed-out command becomes a job, it is not killed. */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const registry = () => {
  const events: Event[] = [];
  return { events, jobs: new JobRegistry((e) => events.push(e)) };
};

describe("JobRegistry", () => {
  it("adopts a running child without killing it", async () => {
    const { jobs, events } = registry();
    const child = spawn("sh", ["-c", "echo alive; sleep 0.6; echo done"]);
    const jobId = jobs.adopt(child, "test", "s1", "");

    expect(events.find((e) => e.type === "job.start")).toMatchObject({ jobId, cmd: "test" });
    expect(jobs.get(jobId)?.running).toBe(true);

    await sleep(1200);
    // It ran to completion rather than being cut off.
    expect(jobs.get(jobId)).toMatchObject({ running: false, exitCode: 0, killed: false });
    expect(jobs.output(jobId)).toContain("done");
  }, 10000);

  it("seeds the buffer with output the tool already collected", () => {
    const { jobs } = registry();
    const child = spawn("sh", ["-c", "sleep 0.2"]);
    const jobId = jobs.adopt(child, "test", "s1", "earlier line\nsecond line");
    expect(jobs.output(jobId)).toContain("earlier line");
    jobs.kill(jobId);
  });

  it("streams output as job.output events", async () => {
    const { jobs, events } = registry();
    const child = spawn("sh", ["-c", "echo streamed"]);
    jobs.adopt(child, "test", "s1", "");
    await sleep(500);
    const out = events.filter((e) => e.type === "job.output") as { delta: string }[];
    expect(out.map((e) => e.delta).join("")).toContain("streamed");
  }, 10000);

  it("keeps only the last 200 lines", async () => {
    const { jobs } = registry();
    const child = spawn("sh", ["-c", "for i in $(seq 1 400); do echo line$i; done"]);
    const jobId = jobs.adopt(child, "test", "s1", "");
    await sleep(1200);
    const lines = (jobs.output(jobId) ?? "").split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(RING_SIZE);
    // The tail is what survives, which is what you want from a log.
    expect(lines.at(-1)).toBe("line400");
    expect(jobs.output(jobId)).not.toContain("line1\n");
  }, 10000);

  it("output(n) returns just the tail", async () => {
    const { jobs } = registry();
    const child = spawn("sh", ["-c", "for i in 1 2 3 4 5; do echo l$i; done"]);
    const jobId = jobs.adopt(child, "test", "s1", "");
    await sleep(800);
    expect((jobs.output(jobId, 2) ?? "").split("\n").filter(Boolean)).toEqual(["l4", "l5"]);
  }, 10000);

  it("kill sends SIGTERM and reports the job as killed", async () => {
    const { jobs, events } = registry();
    const child = spawn("sh", ["-c", "sleep 30"]);
    const jobId = jobs.adopt(child, "sleep 30", "s1", "");
    expect(jobs.kill(jobId)).toBe(true);
    await sleep(900);
    expect(jobs.get(jobId)?.running).toBe(false);
    expect(events.find((e) => e.type === "job.end")).toMatchObject({ jobId });
  }, 10000);

  it("killing a finished job says so", async () => {
    const { jobs } = registry();
    const child = spawn("sh", ["-c", "true"]);
    const jobId = jobs.adopt(child, "true", "s1", "");
    await sleep(500);
    expect(jobs.kill(jobId)).toBe(false);
  }, 10000);

  it("lists jobs and reports unknown ones as missing", async () => {
    const { jobs } = registry();
    const child = spawn("sh", ["-c", "sleep 0.2"]);
    const jobId = jobs.adopt(child, "test", "s1", "");
    expect(jobs.list().map((j) => j.jobId)).toEqual([jobId]);
    expect(jobs.get("nope")).toBeUndefined();
    expect(jobs.output("nope")).toBeUndefined();
    await sleep(400);
  }, 10000);

  it("killAll stops everything — jobs do not outlive the backend in v1", async () => {
    const { jobs } = registry();
    const a = jobs.adopt(spawn("sh", ["-c", "sleep 30"]), "a", "s1", "");
    jobs.adopt(spawn("sh", ["-c", "sleep 30"]), "b", "s1", "");
    jobs.killAll();
    await sleep(400);
    expect(jobs.list()).toEqual([]);
    expect(jobs.get(a)).toBeUndefined();
  }, 10000);
});
