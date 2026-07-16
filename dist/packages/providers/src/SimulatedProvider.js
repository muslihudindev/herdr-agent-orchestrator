"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SimulatedProvider = void 0;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
class SimulatedProvider {
    config;
    name;
    running = new Set();
    constructor(name, config) {
        this.config = config;
        this.name = name;
    }
    async start() { }
    async stop() {
        this.running.clear();
    }
    async executeTask(task) {
        this.running.add(task.taskId);
        await (0, promises_1.mkdir)(task.workspacePath, { recursive: true });
        await (0, promises_1.appendFile)(task.logPath, `[${this.name}] starting ${task.workerId}\n${task.instruction}\n`);
        const artifact = (0, node_path_1.join)(task.workspacePath, `${task.workerId}-result.md`);
        await (0, promises_1.writeFile)(artifact, [
            `# ${task.workerId}`,
            "",
            `Role: ${task.role}`,
            "",
            "Instruction",
            "",
            task.instruction,
            "",
            "Result",
            "",
            "Simulated provider completed the assigned work. Replace the provider in config to run a real coding agent."
        ].join("\n"), "utf8");
        await (0, promises_1.appendFile)(task.logPath, `[${this.name}] completed ${task.workerId}\n`);
        this.running.delete(task.taskId);
        return {
            success: true,
            exitCode: 0,
            summary: `${task.workerId} completed by ${this.name}`,
            artifacts: [artifact]
        };
    }
    async streamLogs(_taskId, _onChunk) {
        return () => undefined;
    }
    async cancelTask(taskId) {
        this.running.delete(taskId);
    }
    async healthCheck() {
        return Boolean(this.config.command);
    }
    async getStatus() {
        return {
            name: this.name,
            healthy: await this.healthCheck(),
            runningTasks: this.running.size
        };
    }
}
exports.SimulatedProvider = SimulatedProvider;
