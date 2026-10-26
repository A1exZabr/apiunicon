import { afterEach, describe, expect, it } from "vitest";

import { migrateDatabase, openDatabase } from "../../src/db/database.js";
import { JobRepository, MAX_JOB_ATTEMPTS } from "../../src/jobs/repository.js";
import { JobRunner } from "../../src/jobs/runner.js";

const databases: ReturnType<typeof openDatabase>[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function createJobs() {
  const database = openDatabase(":memory:");
  databases.push(database);
  migrateDatabase(database);
  let now = new Date("2026-08-23T06:00:00.000Z");
  const jobs = new JobRepository(database, () => now);
  return {
    database,
    jobs,
    advance(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds);
    },
  };
}

describe("persisted background jobs", () => {
  it("claims and completes one queued crawl job", async () => {
    const { jobs, advance } = createJobs();
    const handled: string[] = [];
    const runner = new JobRunner(jobs, {
      crawl_documentation: async (subjectId) => {
        handled.push(subjectId);
        advance(250);
      },
    });
    const queued = jobs.enqueue("crawl_documentation", "source-1");

    expect(queued.status).toBe("queued");
    expect(await runner.runOne()).toBe(true);

    expect(handled).toEqual(["source-1"]);
    expect(jobs.get(queued.id)).toMatchObject({
      status: "succeeded",
      attempts: 1,
      errorCategory: null,
    });
  });

  it("records a categorized failure and permits a retry", async () => {
    const { jobs } = createJobs();
    let fail = true;
    const runner = new JobRunner(
      jobs,
      {
        crawl_documentation: async () => {
          if (fail) throw new Error("fixture crawl failed");
        },
      },
      { categorizeError: () => "crawl" },
    );
    const first = jobs.enqueue("crawl_documentation", "source-1");

    await runner.runOne();
    expect(jobs.get(first.id)).toMatchObject({ status: "failed", errorCategory: "crawl" });

    fail = false;
    const retry = jobs.enqueue("crawl_documentation", "source-1");
    expect(retry.id).not.toBe(first.id);
    await runner.runOne();
    expect(jobs.get(retry.id).status).toBe("succeeded");
    expect(jobs.latest("crawl_documentation", "source-1")?.id).toBe(retry.id);
  });

  it("does not enqueue duplicate work while the same subject is active", () => {
    const { jobs } = createJobs();
    const first = jobs.enqueue("crawl_documentation", "source-1");
    const duplicate = jobs.enqueue("crawl_documentation", "source-1");

    expect(duplicate.id).toBe(first.id);
  });

  it("requeues work interrupted by a process restart", () => {
    const { jobs } = createJobs();
    const queued = jobs.enqueue("crawl_documentation", "source-1");
    expect(jobs.claimNext()?.id).toBe(queued.id);
    expect(jobs.get(queued.id).status).toBe("running");

    expect(jobs.requeueInterrupted()).toBe(1);
    expect(jobs.get(queued.id)).toMatchObject({ status: "queued", errorCategory: null });
  });

  it("fails a job interrupted on every attempt instead of requeueing it again", () => {
    const { jobs } = createJobs();
    const poisoned = jobs.enqueue("crawl_documentation", "source-1");
    const healthy = jobs.enqueue("crawl_documentation", "source-2");
    for (let attempt = 1; attempt < MAX_JOB_ATTEMPTS; attempt += 1) {
      expect(jobs.claimNext()?.id).toBe(poisoned.id);
      expect(jobs.requeueInterrupted()).toBe(1);
    }
    expect(jobs.claimNext()).toMatchObject({ id: poisoned.id, attempts: MAX_JOB_ATTEMPTS });
    expect(jobs.claimNext()).toMatchObject({ id: healthy.id, attempts: 1 });

    expect(jobs.requeueInterrupted()).toBe(1);

    expect(jobs.get(poisoned.id)).toMatchObject({ status: "failed", errorCategory: "interrupted" });
    expect(jobs.get(healthy.id).status).toBe("queued");
  });

  it("reports each abandoned job when the runner starts", () => {
    const { jobs } = createJobs();
    const poisoned = jobs.enqueue("crawl_documentation", "source-1");
    for (let attempt = 1; attempt < MAX_JOB_ATTEMPTS; attempt += 1) {
      jobs.claimNext();
      jobs.requeueInterrupted();
    }
    jobs.claimNext();
    const abandoned: string[] = [];
    const runner = new JobRunner(jobs, { crawl_documentation: async () => {} }, {
      onAbandoned: (job) => abandoned.push(job.subjectId),
    });

    runner.start();
    runner.stop();

    expect(abandoned).toEqual(["source-1"]);
    expect(jobs.get(poisoned.id).status).toBe("failed");
  });
});
