"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RuntimeOrchestrator = void 0;
const node_child_process_1 = require("node:child_process");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const EventBus_1 = require("../../event-bus/src/EventBus");
const ids_1 = require("../../shared/src/ids");
class RuntimeOrchestrator {
    eventBus = new EventBus_1.EventBus();
    orchestrationRoot;
    projectRoot;
    storageRoot;
    constructor(options = {}) {
        this.orchestrationRoot = options.orchestrationRoot ?? process.cwd();
        this.projectRoot = options.projectRoot ?? process.cwd();
        this.storageRoot = options.storageRoot ?? process.cwd();
    }
    events() {
        return this.eventBus;
    }
    async run(request, preplannedPlan, options = {}) {
        const taskId = (0, ids_1.createId)("task");
        await (0, promises_1.mkdir)((0, node_path_1.join)(this.storageRoot, "logs"), { recursive: true });
        await (0, promises_1.mkdir)((0, node_path_1.join)(this.storageRoot, "workspace", taskId), { recursive: true });
        this.eventBus.publish("TaskReceived", { taskId, request });
        const requestPath = (0, node_path_1.join)(this.storageRoot, "workspace", taskId, "request.txt");
        const eventsPath = (0, node_path_1.join)(this.storageRoot, "workspace", taskId, "events.jsonl");
        const summaryPath = (0, node_path_1.join)(this.storageRoot, "workspace", taskId, "summary.json");
        const clarificationPath = (0, node_path_1.join)(this.storageRoot, "workspace", taskId, "clarification.json");
        const planApprovalPath = (0, node_path_1.join)(this.storageRoot, "workspace", taskId, "plan-approval.json");
        const gitPublishApprovalPath = (0, node_path_1.join)(this.storageRoot, "workspace", taskId, "git-publish-approval.json");
        const preplannedPlanPath = (0, node_path_1.join)(this.storageRoot, "workspace", taskId, "preplanned-plan.json");
        await (0, promises_1.writeFile)(requestPath, request, "utf8");
        await (0, promises_1.writeFile)(eventsPath, "", "utf8");
        if (preplannedPlan)
            await (0, promises_1.writeFile)(preplannedPlanPath, JSON.stringify(preplannedPlan, null, 2), "utf8");
        const taskManagerLog = (0, node_path_1.join)(this.storageRoot, "logs", "task-manager.log");
        await ensureLogFile(taskManagerLog);
        const child = await this.spawnTaskManager(taskId, requestPath, eventsPath, summaryPath, clarificationPath, planApprovalPath, gitPublishApprovalPath, taskManagerLog, "execute", preplannedPlan ? preplannedPlanPath : undefined, options.skipPlanApproval);
        const completed = await this.replayEventsUntilSummary(eventsPath, summaryPath, child);
        if (!completed) {
            await (0, promises_1.writeFile)(summaryPath, JSON.stringify(crashedRunSummary(taskId, request, preplannedPlan), null, 2), "utf8");
            this.eventBus.publish("ApprovalRequired", { taskId, success: false, dashboard: "Orchestration process exited unexpectedly before writing summary." });
        }
        return JSON.parse(await (0, promises_1.readFile)(summaryPath, "utf8"));
    }
    async planOnly(request, options = {}) {
        const taskId = (0, ids_1.createId)("task");
        await (0, promises_1.mkdir)((0, node_path_1.join)(this.storageRoot, "logs"), { recursive: true });
        await (0, promises_1.mkdir)((0, node_path_1.join)(this.storageRoot, "workspace", taskId), { recursive: true });
        const requestPath = (0, node_path_1.join)(this.storageRoot, "workspace", taskId, "request.txt");
        const eventsPath = (0, node_path_1.join)(this.storageRoot, "workspace", taskId, "events.jsonl");
        const summaryPath = (0, node_path_1.join)(this.storageRoot, "workspace", taskId, "plan-summary.json");
        const clarificationPath = (0, node_path_1.join)(this.storageRoot, "workspace", taskId, "clarification.json");
        const planApprovalPath = (0, node_path_1.join)(this.storageRoot, "workspace", taskId, "plan-approval.json");
        const gitPublishApprovalPath = (0, node_path_1.join)(this.storageRoot, "workspace", taskId, "git-publish-approval.json");
        const revisionPath = (0, node_path_1.join)(this.storageRoot, "workspace", taskId, "revision.txt");
        const previousPlanPath = (0, node_path_1.join)(this.storageRoot, "workspace", taskId, "previous-plan.json");
        await (0, promises_1.writeFile)(requestPath, request, "utf8");
        await (0, promises_1.writeFile)(eventsPath, "", "utf8");
        if (options.revisionFeedback)
            await (0, promises_1.writeFile)(revisionPath, options.revisionFeedback, "utf8");
        if (options.previousPlan)
            await (0, promises_1.writeFile)(previousPlanPath, JSON.stringify(options.previousPlan, null, 2), "utf8");
        const taskManagerLog = (0, node_path_1.join)(this.storageRoot, "logs", `task-manager-${taskId}.log`);
        await ensureLogFile(taskManagerLog);
        const child = await this.spawnTaskManager(taskId, requestPath, eventsPath, summaryPath, clarificationPath, planApprovalPath, gitPublishApprovalPath, taskManagerLog, "plan-only", undefined, false, options.revisionFeedback ? revisionPath : undefined, options.previousPlan ? previousPlanPath : undefined);
        const completed = await this.replayEventsUntilSummary(eventsPath, summaryPath, child);
        if (!completed)
            throw new Error("Task Manager exited unexpectedly before producing a plan");
        return JSON.parse(await (0, promises_1.readFile)(summaryPath, "utf8"));
    }
    async spawnTaskManager(taskId, requestPath, eventsPath, summaryPath, clarificationPath, planApprovalPath, gitPublishApprovalPath, taskManagerLog, mode = "execute", preplannedPlanPath, skipPlanApproval = false, revisionPath, previousPlanPath) {
        const entry = (0, node_path_1.join)(this.orchestrationRoot, "dist", "apps", "pi-orchestrator", "src", "index.js");
        const args = [
            entry,
            "--agent",
            "task-manager",
            "--task-id",
            taskId,
            "--mode",
            mode,
            "--request",
            requestPath,
            "--events",
            eventsPath,
            "--summary",
            summaryPath,
            "--clarification",
            clarificationPath,
            "--plan-approval",
            planApprovalPath,
            "--git-publish-approval",
            gitPublishApprovalPath,
            "--orchestration-root",
            this.orchestrationRoot,
            "--project-root",
            this.projectRoot,
            "--storage-root",
            this.storageRoot
        ];
        if (preplannedPlanPath) {
            args.push("--preplanned-plan", preplannedPlanPath);
        }
        if (skipPlanApproval) {
            args.push("--skip-plan-approval", "true");
        }
        if (revisionPath) {
            args.push("--revision", revisionPath);
        }
        if (previousPlanPath) {
            args.push("--previous-plan", previousPlanPath);
        }
        const child = (0, node_child_process_1.spawn)(process.execPath, args, {
            cwd: this.projectRoot,
            env: {
                ...process.env,
                PI_ORCHESTRATION_ROOT: this.orchestrationRoot,
                PI_ORCHESTRATION_PROJECT_ROOT: this.projectRoot,
                PI_ORCHESTRATION_STORAGE_ROOT: this.storageRoot
            }
        });
        child.stdout.on("data", (chunk) => process.stdout.write(chunk));
        child.stderr.on("data", (chunk) => process.stderr.write(chunk));
        return child;
    }
    async replayEventsUntilSummary(eventsPath, summaryPath, child) {
        let offset = 0;
        let childExitCode;
        child?.on("exit", (code) => {
            childExitCode = code;
        });
        while (true) {
            offset = await this.replayNewEvents(eventsPath, offset);
            if (await fileExists(summaryPath)) {
                offset = await this.replayNewEvents(eventsPath, offset);
                return true;
            }
            if (childExitCode !== undefined && childExitCode !== 0) {
                return false;
            }
            await sleep(100);
        }
    }
    async replayNewEvents(eventsPath, offset) {
        const text = await (0, promises_1.readFile)(eventsPath, "utf8");
        if (text.length === offset)
            return offset;
        for (const line of text.slice(offset).split(/\r?\n/)) {
            if (!line.trim())
                continue;
            const event = JSON.parse(line);
            this.eventBus.publish(event.type, event.payload, event.workerId);
        }
        return text.length;
    }
}
exports.RuntimeOrchestrator = RuntimeOrchestrator;
function crashedRunSummary(taskId, request, plan) {
    return {
        taskId,
        success: false,
        plan: plan ?? {
            request,
            detectedTechnology: [],
            subtasks: [],
            executorCount: 0,
            acceptanceCriteria: []
        },
        workers: [],
        validationSummary: "Orchestration process exited unexpectedly before writing summary. Check worker logs for the last completed/failed pane.",
        approvalRequired: false
    };
}
async function ensureLogFile(path) {
    await (0, promises_1.writeFile)(path, "", { flag: "a" });
}
async function fileExists(path) {
    try {
        await (0, promises_1.readFile)(path, "utf8");
        return true;
    }
    catch {
        return false;
    }
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
