"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Dashboard = void 0;
class Dashboard {
    eventBus;
    workers = new Map();
    startedAt = Date.now();
    currentStep = "Idle";
    constructor(eventBus) {
        this.eventBus = eventBus;
    }
    start() {
        this.startedAt = Date.now();
        return this.eventBus.subscribe("*", (event) => {
            if (event.type === "WorkerStarted" || event.type === "ProgressUpdated") {
                this.upsert(event.payload);
            }
            if (event.type === "WorkerFinished" || event.type === "WorkerFailed") {
                const payload = event.payload;
                if (payload.worker)
                    this.upsert(payload.worker);
            }
            this.currentStep = event.type;
        });
    }
    render() {
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
    snapshots() {
        return [...this.workers.values()];
    }
    upsert(worker) {
        this.workers.set(worker.id, worker);
    }
}
exports.Dashboard = Dashboard;
function bar(progress) {
    const total = 18;
    const filled = Math.round((progress / 100) * total);
    return `${"#".repeat(filled)}${"-".repeat(total - filled)} ${progress}%`;
}
