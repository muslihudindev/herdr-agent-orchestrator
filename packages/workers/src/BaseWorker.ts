import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { EventBus } from "../../event-bus/src/EventBus";
import { Provider } from "../../providers/src/Provider";
import { ProviderTask, RoleName, WorkerSnapshot, WorkerStatus } from "../../shared/src/types";

export abstract class BaseWorker {
  protected status: WorkerStatus = "pending";
  protected progress = 0;
  protected currentTask = "";

  constructor(
    readonly id: string,
    readonly role: RoleName,
    protected readonly provider: Provider,
    protected readonly eventBus: EventBus,
    protected readonly logPath: string
  ) {}

  snapshot(): WorkerSnapshot {
    return {
      id: this.id,
      role: this.role,
      status: this.status,
      currentTask: this.currentTask,
      progress: this.progress
    };
  }

  protected async executeProviderTask(task: ProviderTask) {
    this.status = "running";
    this.currentTask = task.instruction.split("\n")[0] ?? "";
    this.progress = 10;
    this.eventBus.publish("WorkerStarted", this.snapshot(), this.id);
    this.eventBus.publish("ProgressUpdated", this.snapshot(), this.id);
    await mkdir(dirname(this.logPath), { recursive: true });
    await appendFile(this.logPath, `worker ${this.id} started\n`);

    const result = await this.provider.executeTask(task);
    this.status = result.success ? "completed" : "failed";
    this.progress = result.success ? 100 : this.progress;
    await appendFile(this.logPath, `${result.summary}\n`);
    this.eventBus.publish(result.success ? "WorkerFinished" : "WorkerFailed", { worker: this.snapshot(), result }, this.id);
    return result;
  }
}
