"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ValidatorWorker = void 0;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const ids_1 = require("../../shared/src/ids");
const BaseWorker_1 = require("../../workers/src/BaseWorker");
class ValidatorWorker extends BaseWorker_1.BaseWorker {
    constructor(provider, eventBus, logPath) {
        super("validator", "validator", provider, eventBus, logPath);
    }
    async validate(taskId, plan, workspacePath) {
        const packageJsonExists = await exists("package.json");
        const instruction = [
            "You are the Validator. Review completed work, run available checks, and verify acceptance criteria.",
            "Task Manager must not run tests. Executors may add or update tests. You own final verification.",
            "Check that changes for the requested user role do not regress or unintentionally change behavior for other user roles.",
            packageJsonExists ? "Run the project's configured tests, lint, and build commands when available." : "No package.json found; perform repository-level validation.",
            "",
            "Acceptance criteria:",
            ...plan.acceptanceCriteria.map((item) => `- ${item}`)
        ].join("\n");
        const providerTask = {
            taskId: (0, ids_1.createId)("provider"),
            role: "validator",
            workerId: this.id,
            instruction,
            workspacePath,
            logPath: this.logPath,
            metadata: { taskId, plan }
        };
        const result = await normalizeValidationResult(await this.executeProviderTask(providerTask), this.logPath);
        this.eventBus.publish(result.success ? "ValidationPassed" : "ValidationFailed", { taskId, result }, this.id);
        return result;
    }
}
exports.ValidatorWorker = ValidatorWorker;
async function normalizeValidationResult(result, logPath) {
    if (!result.success)
        return result;
    try {
        const text = await (0, promises_1.readFile)(logPath, "utf8");
        const lastValidation = text.slice(Math.max(0, text.lastIndexOf("Validation result:")));
        if (/\bnot accepted\b|\bvalidation failed\b|Validation Failed/i.test(lastValidation)) {
            return { ...result, success: false, exitCode: result.exitCode || 1, summary: summarizeValidatorRejection(lastValidation) };
        }
    }
    catch {
        return result;
    }
    return result;
}
function summarizeValidatorRejection(text) {
    const clean = text
        .replace(/\x1b\[[0-9;]*m/g, "")
        .split(/\n\[codex\] exited with|\nworker validator started/)[0]
        .trim();
    const lines = clean.split(/\r?\n/).filter((line) => line.trim()).slice(0, 14);
    return `Validator rejected work:\n${lines.join("\n")}`;
}
async function exists(path) {
    try {
        await (0, promises_1.access)((0, node_path_1.join)(".", path));
        return true;
    }
    catch {
        return false;
    }
}
