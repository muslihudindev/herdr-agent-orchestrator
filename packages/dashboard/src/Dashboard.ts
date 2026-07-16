import { EventBus } from "../../event-bus/src/EventBus";
import { WorkerSnapshot } from "../../shared/src/types";

export class Dashboard {
  private readonly workers = new Map<string, WorkerSnapshot>();
  private startedAt = Date.now();
  private currentStep = "Idle";

  constructor(private readonly eventBus: EventBus) {}

  start(): () => void {
    this.startedAt = Date.now();
    return this.eventBus.subscribe("*", (event) => {
      if (event.type === "WorkerStarted" || event.type === "ProgressUpdated") {
        this.upsert(event.payload as WorkerSnapshot);
      }

      if (event.type === "WorkerFinished" || event.type === "WorkerFailed") {
        const payload = event.payload as { worker?: WorkerSnapshot };
        if (payload.worker) this.upsert(payload.worker);
      }

      this.currentStep = event.type;
    });
  }

  render(): string {
    const workers = [...this.workers.values()];
    const completed = workers.filter((worker) => worker.status === "completed").length;
    const failed = workers.filter((worker) => worker.status === "failed").length;
    const active = workers.filter((worker) => worker.status === "running").length;
    const progress = workers.length
      ? Math.round(workers.reduce((sum, worker) => sum + worker.progress, 0) / workers.length)
      : 0;
    const elapsed = Math.round((Date.now() - this.startedAt) / 1000);

    return [
      "Progress",
      bar(progress),
      "",
      `Active: ${active}`,
      `Completed: ${completed}`,
      `Failed: ${failed}`,
      `Elapsed: ${elapsed}s`,
      `Current step: ${this.currentStep}`,
      "",
      ...workers.map((worker) => `${worker.id} ${worker.status} ${worker.progress}% ${worker.currentTask ?? ""}`)
    ].join("\n");
  }

  snapshots(): WorkerSnapshot[] {
    return [...this.workers.values()];
  }

  private upsert(worker: WorkerSnapshot): void {
    this.workers.set(worker.id, worker);
  }
}

function bar(progress: number): string {
  const total = 18;
  const filled = Math.round((progress / 100) * total);
  return `${"#".repeat(filled)}${"-".repeat(total - filled)} ${progress}%`;
}
