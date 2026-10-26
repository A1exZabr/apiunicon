import type { JobKind, JobRecord, JobRepository } from "./repository.js";

export type JobHandlers = Record<JobKind, (subjectId: string) => Promise<void>>;

type RunnerOptions = {
  categorizeError?: (error: unknown) => string;
  // Called for each interrupted job that is failed instead of requeued, so its subject is not left waiting.
  onAbandoned?: (job: JobRecord) => void;
};

export class JobRunner {
  private active = false;
  private stopped = true;
  private readonly categorizeError: (error: unknown) => string;
  private readonly onAbandoned: (job: JobRecord) => void;

  constructor(
    private readonly jobs: JobRepository,
    private readonly handlers: JobHandlers,
    options: RunnerOptions = {},
  ) {
    this.categorizeError = options.categorizeError ?? (() => "job");
    this.onAbandoned = options.onAbandoned ?? (() => {});
  }

  start(): void {
    this.stopped = false;
    for (const job of this.jobs.failExhausted()) {
      try {
        this.onAbandoned(job);
      } catch {
        // The job is already failed. Its subject may be gone, and startup must not fail because of it.
      }
    }
    this.jobs.requeueInterrupted();
    this.wake();
  }

  stop(): void {
    this.stopped = true;
  }

  wake(): void {
    if (this.stopped || this.active) return;
    this.active = true;
    queueMicrotask(() => {
      void this.drain().finally(() => {
        this.active = false;
      });
    });
  }

  async runOne(): Promise<boolean> {
    const job = this.jobs.claimNext();
    if (!job) return false;
    try {
      await this.handlers[job.kind](job.subjectId);
      this.jobs.succeed(job.id);
    } catch (error) {
      this.jobs.fail(job.id, this.categorizeError(error));
    }
    return true;
  }

  private async drain(): Promise<void> {
    while (!this.stopped && (await this.runOne())) {
      // Drain persisted work serially to keep crawling bounded.
    }
  }
}
