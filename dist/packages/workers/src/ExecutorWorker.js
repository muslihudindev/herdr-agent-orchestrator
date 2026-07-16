"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExecutorWorker = void 0;
const ids_1 = require("../../shared/src/ids");
const BaseWorker_1 = require("./BaseWorker");
class ExecutorWorker extends BaseWorker_1.BaseWorker {
    constructor(id, provider, eventBus, logPath) {
        super(id, "executor", provider, eventBus, logPath);
    }
    async run(taskId, request, subtasks, workspacePath) {
        const instruction = [
            "You are an Executor. Implement only the assigned work.",
            "Do not coordinate directly with other workers.",
            "If assigned test implementation, create or update test files only for the assigned behavior.",
            "Do not run final validation for the full project; Validator owns final test/lint/build verification.",
            "",
            "Original user request:",
            request,
            "",
            "Assigned subtasks:",
            "",
            ...subtasks.map((task) => `- ${task.id}: ${task.title}\n  ${task.description}`)
        ].join("\n");
        const providerTask = {
            taskId: (0, ids_1.createId)("provider"),
            role: "executor",
            workerId: this.id,
            instruction,
            workspacePath,
            logPath: this.logPath,
            metadata: { taskId, request, subtasks }
        };
        this.eventBus.publish("TaskAssigned", { workerId: this.id, subtasks }, this.id);
        return this.executeProviderTask(providerTask);
    }
    async repairValidationFailure(taskId, request, plan, validationSummary, workspacePath) {
        const instruction = [
            "You are an Executor assigned to repair a failed validation run.",
            "Fix only the issue reported by Validator.",
            "Prefer the smallest code or test change that makes the existing acceptance criteria pass.",
            "Do not run final validation for the full project; Validator owns final test/lint/build verification.",
            "Do not coordinate directly with other workers.",
            "",
            "Original user request:",
            request,
            "",
            "Validator failure summary:",
            validationSummary,
            "",
            "Original approved plan:",
            ...plan.subtasks.map((task) => `- ${task.id}: ${task.title}\n  ${task.description}`)
        ].join("\n");
        const repairSubtask = {
            id: "repair-validation",
            title: "Repair validation failure",
            description: validationSummary,
            roleHint: "repair",
            dependsOn: [],
            filesHint: []
        };
        const providerTask = {
            taskId: (0, ids_1.createId)("provider"),
            role: "executor",
            workerId: this.id,
            instruction,
            workspacePath,
            logPath: this.logPath,
            metadata: { taskId, request, plan, validationSummary, repair: true }
        };
        this.eventBus.publish("RetryRequested", { taskId, workerId: this.id, validationSummary }, this.id);
        this.eventBus.publish("TaskAssigned", { workerId: this.id, subtasks: [repairSubtask] }, this.id);
        return this.executeProviderTask(providerTask);
    }
}
exports.ExecutorWorker = ExecutorWorker;
