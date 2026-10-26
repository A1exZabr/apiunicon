import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { Worker } from "node:worker_threads";

export type WorkerWatch = { started: Worker[]; stop: () => void };

// Node announces every new worker on this channel, so a test sees the workers that a call starts.
export function watchWorkers(): WorkerWatch {
  const started: Worker[] = [];
  const onWorker = (message: unknown): void => {
    started.push((message as { worker: Worker }).worker);
  };
  subscribe("worker_threads", onWorker);
  return { started, stop: () => unsubscribe("worker_threads", onWorker) };
}
