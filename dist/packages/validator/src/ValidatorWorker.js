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
    async validate(taskId, request, plan, workspacePath, baselineValidation, actualChangedFiles) {
        const packageJsonExists = await exists("package.json");
        const instruction = [
            "You are an independent Validator.",
            "You own final verification.",
            "Start from a fresh session.",
            "Do not trust Executor summaries without verifying them.",
            "",
            "Read the original request, approved plan, impact analysis, regression matrix, baseline results, base commit, and complete implementation diff.",
            "Inspect the actual Git diff.",
            packageJsonExists ? "Run the project's configured tests, lint, and build commands when available." : "No package.json found; perform repository-level validation.",
            "",
            "Validate requested behavior, regression-matrix scenarios, characterization tests, deleted/weakened tests, shared callers, roles, permissions, statuses, API/database/event contracts, null/empty/zero/missing data, side effects, transactions, scope creep, security, performance, and missing negative tests.",
            "Check that changes for the requested user role do not regress or unintentionally change behavior for other user roles.",
            "Critical and high findings block approval.",
            "A required test failure blocks completion.",
            "A required test that cannot run prevents fully_validated status.",
            "",
            "End with HERDR_VALIDATOR_JSON followed by one JSON object matching ValidatorResult.",
            "",
            "Original request:",
            request,
            "",
            "Acceptance criteria:",
            ...plan.acceptanceCriteria.map((item) => `- ${item}`),
            "",
            "Impact analysis:",
            JSON.stringify(plan.impactAnalysis ?? {}, null, 2),
            "",
            "Regression matrix:",
            JSON.stringify(plan.regressionMatrix ?? [], null, 2),
            "",
            "Baseline validation:",
            JSON.stringify(baselineValidation, null, 2),
            "",
            "Changed files:",
            ...actualChangedFiles.map((file) => `- ${file}`)
        ].join("\n");
        const providerTask = {
            taskId: (0, ids_1.createId)("provider"),
            role: "validator",
            workerId: this.id,
            instruction,
            workspacePath,
            logPath: this.logPath,
            metadata: { taskId, request, plan, baselineValidation, actualChangedFiles }
        };
        const providerResult = await this.executeProviderTask(providerTask);
        const validatorResult = await readValidatorResult(this.logPath)
            ?? (isSimulated(providerResult.summary) ? simulatedValidatorResult(actualChangedFiles, plan) : undefined);
        const result = await normalizeValidationResult(providerResult, this.logPath, validatorResult);
        this.eventBus.publish(result.success ? "ValidationPassed" : "ValidationFailed", { taskId, result }, this.id);
        return result;
    }
}
exports.ValidatorWorker = ValidatorWorker;
async function normalizeValidationResult(result, logPath, validatorResult) {
    if (!validatorResult && result.success && !isSimulated(result.summary)) {
        return { ...result, success: false, exitCode: result.exitCode || 1, summary: "Validator output missing HERDR_VALIDATOR_JSON.", validatorResult };
    }
    if (validatorResult) {
        const blocked = validatorResult.decision === "changes_requested" || validatorResult.decision === "blocked"
            || validatorResult.findings.some((finding) => finding.severity === "critical" || finding.severity === "high")
            || validatorResult.commands.some((command) => command.required && command.status === "failed");
        return {
            ...result,
            success: result.success && !blocked,
            exitCode: result.success && !blocked ? result.exitCode : result.exitCode || 1,
            summary: validatorSummary(validatorResult, result.summary),
            validatorResult
        };
    }
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
async function readValidatorResult(logPath) {
    try {
        const marker = "HERDR_VALIDATOR_JSON";
        const text = await (0, promises_1.readFile)(logPath, "utf8");
        const markerIndex = text.lastIndexOf(marker);
        if (markerIndex < 0)
            return undefined;
        const afterMarker = text.slice(markerIndex + marker.length);
        const start = afterMarker.indexOf("{");
        const end = afterMarker.lastIndexOf("}");
        if (start < 0 || end < start)
            return undefined;
        const parsed = JSON.parse(afterMarker.slice(start, end + 1));
        if (parsed.decision && parsed.validationStatus && Array.isArray(parsed.findings))
            return parsed;
    }
    catch {
        return undefined;
    }
    return undefined;
}
function simulatedValidatorResult(changedFiles, plan) {
    return {
        decision: "approved",
        validationStatus: "fully_validated",
        findings: [],
        commands: [{
                command: "simulated validation",
                category: "custom",
                required: false,
                status: "passed",
                outputSummary: "Simulated provider accepted the work."
            }],
        regressionMatrixResults: (plan.regressionMatrix ?? []).map((entry) => ({ ...entry, validationStatus: "passed" })),
        changedFiles,
        scopeViolations: [],
        remainingRisks: [],
        requiredRepairs: []
    };
}
function validatorSummary(result, fallback) {
    const findings = result.findings.length ? `; findings: ${result.findings.map((finding) => `${finding.severity}:${finding.id}`).join(", ")}` : "";
    return `Validator ${result.decision} (${result.validationStatus})${findings}` || fallback;
}
function isSimulated(summary) {
    return /completed by simulated/i.test(summary);
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
