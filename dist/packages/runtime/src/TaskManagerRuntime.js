"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskManagerRuntime = void 0;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const ConfigLoader_1 = require("../../config/src/ConfigLoader");
const TribeManagerConfigLoader_1 = require("../../config/src/TribeManagerConfigLoader");
const Dashboard_1 = require("../../dashboard/src/Dashboard");
const ProviderRegistry_1 = require("../../providers/src/ProviderRegistry");
const RoleRegistry_1 = require("../../registry/src/RoleRegistry");
const TaskManagerWorker_1 = require("../../task-manager/src/TaskManagerWorker");
const ValidatorWorker_1 = require("../../validator/src/ValidatorWorker");
const ExecutorWorker_1 = require("../../workers/src/ExecutorWorker");
const WorkspaceManager_1 = require("../../workspace/src/WorkspaceManager");
const GitPublisher_1 = require("./GitPublisher");
class TaskManagerRuntime {
    eventBus;
    maxValidationRepairAttempts = Number(process.env.PI_ORCHESTRATION_MAX_VALIDATION_REPAIRS ?? 1);
    providerRegistry = new ProviderRegistry_1.ProviderRegistry();
    orchestrationRoot;
    projectRoot;
    storageRoot;
    clarificationPath;
    planApprovalPath;
    gitPublishApprovalPath;
    preplannedPlanPath;
    skipPlanApproval;
    workspaceManager;
    constructor(eventBus, options = {}) {
        this.eventBus = eventBus;
        this.orchestrationRoot = options.orchestrationRoot ?? process.env.PI_ORCHESTRATION_ROOT ?? process.cwd();
        this.projectRoot = options.projectRoot ?? process.env.PI_ORCHESTRATION_PROJECT_ROOT ?? process.cwd();
        this.storageRoot = options.storageRoot ?? process.env.PI_ORCHESTRATION_STORAGE_ROOT ?? process.cwd();
        this.clarificationPath = options.clarificationPath;
        this.planApprovalPath = options.planApprovalPath;
        this.gitPublishApprovalPath = options.gitPublishApprovalPath;
        this.preplannedPlanPath = options.preplannedPlanPath;
        this.skipPlanApproval = options.skipPlanApproval ?? false;
        this.workspaceManager = new WorkspaceManager_1.WorkspaceManager((0, node_path_1.join)(this.storageRoot, "workspace"));
    }
    async execute(taskId, request) {
        process.env.PI_ORCHESTRATION_ROOT = this.orchestrationRoot;
        process.env.PI_ORCHESTRATION_PROJECT_ROOT = this.projectRoot;
        process.env.PI_ORCHESTRATION_STORAGE_ROOT = this.storageRoot;
        const configLoader = new ConfigLoader_1.ConfigLoader(process.env.PI_ORCHESTRATION_ROLES_PATH ?? (0, node_path_1.join)(this.orchestrationRoot, "config", "roles.yaml"), process.env.PI_ORCHESTRATION_PROVIDERS_PATH ?? (0, node_path_1.join)(this.orchestrationRoot, "config", "providers.yaml"));
        const config = await configLoader.load();
        const tribeManagerConfig = await new TribeManagerConfigLoader_1.TribeManagerConfigLoader(process.env.PI_ORCHESTRATION_TRIBE_MANAGER_PATH ?? (0, node_path_1.join)(this.orchestrationRoot, "config", "tribe-manager.yaml")).configForProject(this.projectRoot);
        const roles = new RoleRegistry_1.RoleRegistry(config);
        this.providerRegistry.configure(config.providers);
        const logRoot = (0, node_path_1.join)(this.storageRoot, "logs");
        await (0, promises_1.mkdir)(logRoot, { recursive: true });
        const dashboard = new Dashboard_1.Dashboard(this.eventBus);
        const stopDashboard = dashboard.start();
        const runWorkspace = await this.workspaceManager.prepareRun(taskId);
        const taskManager = new TaskManagerWorker_1.TaskManagerWorker(this.providerRegistry.get(roles.providerFor("task_manager")), this.eventBus, (0, node_path_1.join)(logRoot, "task-manager.log"), roles.replicasFor("executor"));
        const tribeSyncWorker = new TaskManagerWorker_1.TaskManagerWorker(this.providerRegistry.get(providerForTribeSync(config.providers, roles.providerFor("executor"))), this.eventBus, (0, node_path_1.join)(logRoot, "tribe-manager-sync.log"), roles.replicasFor("executor"));
        const taskManagerLog = (0, node_path_1.join)(logRoot, "task-manager.log");
        await ensureLogFile(taskManagerLog);
        let effectiveRequest = request;
        let plan = this.preplannedPlanPath ? await readPreplannedPlan(this.preplannedPlanPath) : undefined;
        if (!plan && this.clarificationPath) {
            const questions = await taskManager.clarify(taskId, request, (0, node_path_1.join)(runWorkspace, "task-manager-clarify"));
            if (questions.length) {
                this.eventBus.publish("ClarificationRequired", { taskId, questions, answerPath: this.clarificationPath }, "task-manager");
                const answer = await waitForClarification(this.clarificationPath);
                effectiveRequest = `${request}\n\nUser clarification:\n${answer}`;
            }
        }
        plan = plan ?? await taskManager.plan(taskId, effectiveRequest, (0, node_path_1.join)(runWorkspace, "task-manager"), tribeManagerConfig);
        if (this.planApprovalPath && !this.skipPlanApproval) {
            let revisionCount = 0;
            while (true) {
                await clearDecisionFile(this.planApprovalPath);
                this.eventBus.publish("PlanApprovalRequired", { taskId, plan, approvalPath: this.planApprovalPath, revisionCount }, "task-manager");
                const approval = await waitForPlanApproval(this.planApprovalPath);
                if (approval.revision) {
                    revisionCount += 1;
                    plan = await taskManager.plan(taskId, effectiveRequest, (0, node_path_1.join)(runWorkspace, `task-manager-revision-${revisionCount}`), tribeManagerConfig, approval.revision, plan);
                    continue;
                }
                if (!approval.approved) {
                    stopDashboard();
                    return {
                        taskId,
                        success: false,
                        plan,
                        workers: dashboard.snapshots(),
                        validationSummary: approval.reason ? `Plan rejected: ${approval.reason}` : "Plan rejected by user",
                        approvalRequired: false
                    };
                }
                break;
            }
        }
        const tribeInProgressSync = await tribeSyncWorker.reportApprovedTask(taskId, effectiveRequest, plan, (0, node_path_1.join)(runWorkspace, "tribe-manager-approved"), tribeManagerConfig);
        if (tribeInProgressSync.taskId)
            await writeStoredTribeTaskId(this.storageRoot, taskId, tribeInProgressSync.taskId);
        const tribeTaskId = tribeInProgressSync.taskId ?? await readStoredTribeTaskId(this.storageRoot, taskId);
        const assignments = assignSubtasks(plan.subtasks, plan.executorCount);
        const executorResults = await Promise.all(assignments.map(async (subtasks, index) => {
            const workerId = `executor-${String(index + 1).padStart(3, "0")}`;
            const logPath = (0, node_path_1.join)(logRoot, `${workerId}.log`);
            const workerPath = await this.workspaceManager.prepareWorker(taskId, workerId);
            await ensureLogFile(logPath);
            const worker = new ExecutorWorker_1.ExecutorWorker(workerId, this.providerRegistry.get(roles.providerFor("executor")), this.eventBus, logPath);
            return worker.run(taskId, effectiveRequest, subtasks, workerPath);
        }));
        const executorFailureSummary = executorFailure(executorResults);
        const validation = executorFailureSummary
            ? { success: false, summary: executorFailureSummary }
            : await this.validateWithRepair(taskId, effectiveRequest, plan, logRoot, roles);
        const workSucceeded = !executorFailureSummary && validation.success;
        const gitPublish = workSucceeded ? await this.confirmAndPublishGitChanges(taskId, effectiveRequest, roles, logRoot, runWorkspace) : undefined;
        const success = workSucceeded && (!gitPublish?.attempted || (gitPublish.committed && gitPublish.pushed));
        const validationSummary = success || !gitPublish?.attempted ? validation.summary : `${validation.summary}\n${gitPublish.summary}`;
        const tribeCompletionSync = await tribeSyncWorker.reportCompletion(taskId, effectiveRequest, success, validationSummary, (0, node_path_1.join)(runWorkspace, "tribe-manager-complete"), tribeManagerConfig, tribeTaskId);
        if (!success)
            this.eventBus.publish("ApprovalRequired", { taskId, success, dashboard: dashboard.render() });
        stopDashboard();
        return {
            taskId,
            success,
            plan,
            workers: dashboard.snapshots(),
            validationSummary,
            approvalRequired: false,
            gitPublish,
            tribeManagerSync: {
                inProgress: tribeInProgressSync.summary,
                completion: tribeCompletionSync,
                taskId: tribeTaskId
            }
        };
    }
    async planOnly(taskId, request, revisionFeedback, previousPlan) {
        process.env.PI_ORCHESTRATION_ROOT = this.orchestrationRoot;
        process.env.PI_ORCHESTRATION_PROJECT_ROOT = this.projectRoot;
        process.env.PI_ORCHESTRATION_STORAGE_ROOT = this.storageRoot;
        const configLoader = new ConfigLoader_1.ConfigLoader(process.env.PI_ORCHESTRATION_ROLES_PATH ?? (0, node_path_1.join)(this.orchestrationRoot, "config", "roles.yaml"), process.env.PI_ORCHESTRATION_PROVIDERS_PATH ?? (0, node_path_1.join)(this.orchestrationRoot, "config", "providers.yaml"));
        const config = await configLoader.load();
        const tribeManagerConfig = await new TribeManagerConfigLoader_1.TribeManagerConfigLoader(process.env.PI_ORCHESTRATION_TRIBE_MANAGER_PATH ?? (0, node_path_1.join)(this.orchestrationRoot, "config", "tribe-manager.yaml")).configForProject(this.projectRoot);
        const roles = new RoleRegistry_1.RoleRegistry(config);
        this.providerRegistry.configure(config.providers);
        const logRoot = (0, node_path_1.join)(this.storageRoot, "logs");
        await (0, promises_1.mkdir)(logRoot, { recursive: true });
        const runWorkspace = await this.workspaceManager.prepareRun(taskId);
        const taskManagerLog = (0, node_path_1.join)(logRoot, `task-manager-${taskId}.log`);
        await ensureLogFile(taskManagerLog);
        const taskManager = new TaskManagerWorker_1.TaskManagerWorker(this.providerRegistry.get(roles.providerFor("task_manager")), this.eventBus, taskManagerLog, roles.replicasFor("executor"));
        return taskManager.plan(taskId, request, (0, node_path_1.join)(runWorkspace, "task-manager-preplan"), tribeManagerConfig, revisionFeedback, previousPlan);
    }
    async validateWithRepair(taskId, request, plan, logRoot, roles) {
        let validation = await this.runValidator(taskId, plan, logRoot, roles);
        for (let attempt = 1; !validation.success && attempt <= this.maxValidationRepairAttempts; attempt += 1) {
            const workerId = `executor-repair-${String(attempt).padStart(3, "0")}`;
            const logPath = (0, node_path_1.join)(logRoot, `${workerId}.log`);
            const workerPath = await this.workspaceManager.prepareWorker(taskId, workerId);
            await ensureLogFile(logPath);
            const repairWorker = new ExecutorWorker_1.ExecutorWorker(workerId, this.providerRegistry.get(roles.providerFor("executor")), this.eventBus, logPath);
            const repairResult = await repairWorker.repairValidationFailure(taskId, request, plan, validation.summary, workerPath);
            if (!repairResult.success) {
                return {
                    success: false,
                    exitCode: repairResult.exitCode,
                    summary: `Validation failed, repair executor failed: ${repairResult.summary}`
                };
            }
            validation = await this.runValidator(taskId, plan, logRoot, roles);
        }
        return validation;
    }
    async runValidator(taskId, plan, logRoot, roles) {
        const validatorPath = await this.workspaceManager.prepareWorker(taskId, "validator");
        const validatorLog = (0, node_path_1.join)(logRoot, "validator.log");
        await ensureLogFile(validatorLog);
        const validator = new ValidatorWorker_1.ValidatorWorker(this.providerRegistry.get(roles.providerFor("validator")), this.eventBus, validatorLog);
        return validator.validate(taskId, plan, validatorPath);
    }
    async confirmAndPublishGitChanges(taskId, request, roles, logRoot, runWorkspace) {
        const preview = await (0, GitPublisher_1.previewTaskChanges)(this.projectRoot);
        if (preview.changedRepositories === 0) {
            return {
                attempted: false,
                committed: false,
                pushed: false,
                remotes: [],
                repositories: [],
                summary: `git publish skipped: ${preview.summary}`
            };
        }
        return (0, GitPublisher_1.publishTaskChanges)(this.projectRoot, taskId, request, {
            commitMessageProvider: this.providerRegistry.get(roles.providerFor("validator")),
            logPath: (0, node_path_1.join)(logRoot, "commit-message.log"),
            workspacePath: (0, node_path_1.join)(runWorkspace, "commit-message")
        });
    }
}
exports.TaskManagerRuntime = TaskManagerRuntime;
function assignSubtasks(subtasks, executorCount) {
    const buckets = Array.from({ length: executorCount }, () => []);
    subtasks.forEach((task, index) => {
        buckets[index % executorCount].push(task);
    });
    return buckets.filter((bucket) => bucket.length > 0);
}
function executorFailure(results) {
    const failed = results.filter((result) => !result.success);
    if (!failed.length)
        return undefined;
    return `Executor failed before validation:\n${failed.map((result) => `- ${result.summary}`).join("\n")}`;
}
async function ensureLogFile(path) {
    await (0, promises_1.writeFile)(path, "", { flag: "a" });
}
async function waitForPlanApproval(path) {
    if (process.env.PI_ORCHESTRATION_AUTO_APPROVE_PLAN === "true") {
        return { approved: true };
    }
    while (true) {
        try {
            const parsed = JSON.parse(await (0, promises_1.readFile)(path, "utf8"));
            if (typeof parsed.revision === "string" && parsed.revision.trim()) {
                return { approved: false, revision: parsed.revision.trim() };
            }
            if (typeof parsed.approved === "boolean") {
                return { approved: parsed.approved, reason: parsed.reason };
            }
        }
        catch {
            // Wait for Pi to confirm or reject the Task Manager plan.
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
}
async function clearDecisionFile(path) {
    await (0, promises_1.writeFile)(path, "", "utf8");
}
async function waitForClarification(path) {
    if (process.env.PI_ORCHESTRATION_AUTO_CLARIFY)
        return process.env.PI_ORCHESTRATION_AUTO_CLARIFY;
    while (true) {
        try {
            const parsed = JSON.parse(await (0, promises_1.readFile)(path, "utf8"));
            if (typeof parsed.answer === "string" && parsed.answer.trim())
                return parsed.answer.trim();
        }
        catch {
            // Wait for Pi to write the clarification answer.
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
}
async function readPreplannedPlan(path) {
    try {
        return JSON.parse(await (0, promises_1.readFile)(path, "utf8"));
    }
    catch {
        return undefined;
    }
}
async function writeStoredTribeTaskId(storageRoot, taskId, tribeTaskId) {
    const path = (0, node_path_1.join)(storageRoot, "tribe-task-ids.json");
    const ids = await readStoredTribeTaskIds(path);
    ids[taskId] = tribeTaskId;
    await (0, promises_1.writeFile)(path, JSON.stringify(ids, null, 2), "utf8");
}
async function readStoredTribeTaskId(storageRoot, taskId) {
    return (await readStoredTribeTaskIds((0, node_path_1.join)(storageRoot, "tribe-task-ids.json")))[taskId];
}
async function readStoredTribeTaskIds(path) {
    try {
        const parsed = JSON.parse(await (0, promises_1.readFile)(path, "utf8"));
        return Object.fromEntries(Object.entries(parsed).filter((entry) => typeof entry[1] === "number"));
    }
    catch {
        return {};
    }
}
function providerForTribeSync(providers, fallback) {
    return Object.hasOwn(providers, "claude-code") ? "claude-code" : fallback;
}
