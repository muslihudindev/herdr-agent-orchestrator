"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseWorker = void 0;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
class BaseWorker {
    id;
    role;
    provider;
    eventBus;
    logPath;
    status = "pending";
    progress = 0;
    currentTask = "";
    constructor(id, role, provider, eventBus, logPath) {
        this.id = id;
        this.role = role;
        this.provider = provider;
        this.eventBus = eventBus;
        this.logPath = logPath;
    }
    snapshot() {
        return {
            id: this.id,
            role: this.role,
            status: this.status,
            currentTask: this.currentTask,
            progress: this.progress
        };
    }
    async executeProviderTask(task) {
        this.status = "running";
        this.currentTask = task.instruction.split("\n")[0] ?? "";
        this.progress = 10;
        this.eventBus.publish("WorkerStarted", this.snapshot(), this.id);
        this.eventBus.publish("ProgressUpdated", this.snapshot(), this.id);
        await (0, promises_1.mkdir)((0, node_path_1.dirname)(this.logPath), { recursive: true });
        await (0, promises_1.appendFile)(this.logPath, `worker ${this.id} started\n`);
        const result = await this.provider.executeTask(task);
        this.status = result.success ? "completed" : "failed";
        this.progress = result.success ? 100 : this.progress;
        await (0, promises_1.appendFile)(this.logPath, `${result.summary}\n`);
        this.eventBus.publish(result.success ? "WorkerFinished" : "WorkerFailed", { worker: this.snapshot(), result }, this.id);
        return result;
    }
}
exports.BaseWorker = BaseWorker;
