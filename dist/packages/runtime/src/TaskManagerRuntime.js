"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskManagerRuntime = void 0;
const node_child_process_1 = require("node:child_process");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const node_util_1 = require("node:util");
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
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
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
        const artifactsRoot = (0, node_path_1.join)(this.storageRoot, "tasks", taskId);
        await (0, promises_1.mkdir)(logRoot, { recursive: true });
        await (0, promises_1.mkdir)(artifactsRoot, { recursive: true });
        await writeArtifact(artifactsRoot, "request.md", request);
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
        this.eventBus.publish("task.investigation.started", { taskId }, "task-manager");
        plan = plan ?? await taskManager.plan(taskId, effectiveRequest, (0, node_path_1.join)(runWorkspace, "task-manager"), tribeManagerConfig);
        await persistPlanArtifacts(artifactsRoot, plan);
        this.eventBus.publish("task.investigation.completed", { taskId, summary: plan.summary }, "task-manager");
        this.eventBus.publish("task.impact.completed", { taskId, riskLevel: plan.riskLevel }, "task-manager");
        this.eventBus.publish("task.regression_matrix.completed", { taskId, count: plan.regressionMatrix?.length ?? 0 }, "task-manager");
        if (this.planApprovalPath && !this.skipPlanApproval) {
            let revisionCount = 0;
            while (true) {
                await clearDecisionFile(this.planApprovalPath);
                this.eventBus.publish("PlanApprovalRequired", { taskId, plan, approvalPath: this.planApprovalPath, revisionCount }, "task-manager");
                const approval = await waitForPlanApproval(this.planApprovalPath);
                if (approval.revision) {
                    revisionCount += 1;
                    plan = await taskManager.plan(taskId, effectiveRequest, (0, node_path_1.join)(runWorkspace, `task-manager-revision-${revisionCount}`), tribeManagerConfig, approval.revision, plan);
                    await persistPlanArtifacts(artifactsRoot, plan);
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
        const approvedFileScope = scopesForPlan(plan);
        const baselineValidation = await this.runBaselineIfRequired(taskId, effectiveRequest, plan, logRoot, roles, approvedFileScope, config);
        await writeArtifact(artifactsRoot, "baseline-validation.json", JSON.stringify(baselineValidation.records, null, 2));
        if (!baselineValidation.success) {
            const validationSummary = baselineValidation.summary;
            const tribeCompletionSync = await tribeSyncWorker.reportCompletion(taskId, effectiveRequest, false, validationSummary, (0, node_path_1.join)(runWorkspace, "tribe-manager-complete"), tribeManagerConfig, tribeTaskId);
            stopDashboard();
            return {
                taskId,
                success: false,
                phase: "blocked",
                plan,
                safetyAnalysis: plan.impactAnalysis,
                regressionMatrix: plan.regressionMatrix,
                baselineValidation: baselineValidation.records,
                approvedFileScope,
                workers: dashboard.snapshots(),
                validationSummary,
                approvalRequired: false,
                publishApproval: "not_required",
                tribeManagerSync: {
                    inProgress: tribeInProgressSync.summary,
                    completion: tribeCompletionSync,
                    taskId: tribeTaskId
                }
            };
        }
        const baseChangedFiles = await changedFiles(this.projectRoot);
        const implementationSubtasks = plan.subtasks.filter((task) => task.assignmentType !== "characterization_tests");
        const assignments = assignSubtasksByScope(implementationSubtasks, plan.executorCount);
        await writeArtifact(artifactsRoot, "executor-assignments.json", JSON.stringify(assignments, null, 2));
        const executorResults = [];
        let executorIndex = 0;
        for (const group of assignments) {
            executorResults.push(...await Promise.all(group.map(async (subtasks) => {
                executorIndex += 1;
                const workerId = `executor-${String(executorIndex).padStart(3, "0")}`;
                const logPath = (0, node_path_1.join)(logRoot, `${workerId}.log`);
                const workerPath = await this.workspaceManager.prepareWorker(taskId, workerId);
                await ensureLogFile(logPath);
                const worker = new ExecutorWorker_1.ExecutorWorker(workerId, this.providerRegistry.get(roles.providerFor("executor")), this.eventBus, logPath);
                return worker.run(taskId, effectiveRequest, subtasks, workerPath);
            })));
        }
        const actualChangedFiles = subtract(await changedFiles(this.projectRoot), baseChangedFiles);
        const scopeViolations = unapprovedFiles(actualChangedFiles, approvedFileScope);
        if (scopeViolations.length) {
            this.eventBus.publish("executor.scope_violation", { taskId, files: scopeViolations }, "runtime");
            await writeArtifact(artifactsRoot, "final-report.md", `Scope violation:\n${scopeViolations.map((file) => `- ${file}`).join("\n")}`);
            const validationSummary = `Executor scope violation:\n${scopeViolations.map((file) => `- ${file}`).join("\n")}`;
            const tribeCompletionSync = await tribeSyncWorker.reportCompletion(taskId, effectiveRequest, false, validationSummary, (0, node_path_1.join)(runWorkspace, "tribe-manager-complete"), tribeManagerConfig, tribeTaskId);
            stopDashboard();
            return {
                taskId,
                success: false,
                phase: "blocked",
                plan,
                safetyAnalysis: plan.impactAnalysis,
                regressionMatrix: plan.regressionMatrix,
                baselineValidation: baselineValidation.records,
                approvedFileScope,
                actualChangedFiles,
                workers: dashboard.snapshots(),
                validationSummary,
                approvalRequired: false,
                publishApproval: "not_required",
                tribeManagerSync: {
                    inProgress: tribeInProgressSync.summary,
                    completion: tribeCompletionSync,
                    taskId: tribeTaskId
                }
            };
        }
        const executorFailureSummary = executorFailure(executorResults);
        const validation = executorFailureSummary
            ? { success: false, exitCode: 1, summary: executorFailureSummary }
            : await this.validateWithRepair(taskId, effectiveRequest, plan, logRoot, roles, baselineValidation.records, actualChangedFiles, config);
        const workSucceeded = !executorFailureSummary && validation.success;
        await writeArtifact(artifactsRoot, "validator-results.json", JSON.stringify(validation.validatorResult ?? validation, null, 2));
        const gitPublish = workSucceeded ? await this.confirmAndPublishGitChanges(taskId, effectiveRequest, roles, logRoot, runWorkspace, config) : undefined;
        const success = workSucceeded;
        const gitFailed = Boolean(gitPublish?.attempted && (!gitPublish.committed || !gitPublish.pushed));
        const validationSummary = gitFailed ? `${validation.summary}\nGit note: ${gitPublish?.summary}` : validation.summary;
        const finalValidation = validation.validatorResult?.commands ?? [];
        await writeArtifact(artifactsRoot, "final-validation.json", JSON.stringify(finalValidation, null, 2));
        const tribeCompletionSync = await tribeSyncWorker.reportCompletion(taskId, effectiveRequest, success, validationSummary, (0, node_path_1.join)(runWorkspace, "tribe-manager-complete"), tribeManagerConfig, tribeTaskId);
        if (!success)
            this.eventBus.publish("ApprovalRequired", { taskId, success, dashboard: dashboard.render() });
        stopDashboard();
        return {
            taskId,
            success,
            phase: success ? "completed" : "failed",
            plan,
            safetyAnalysis: plan.impactAnalysis,
            regressionMatrix: validation.validatorResult?.regressionMatrixResults ?? plan.regressionMatrix,
            baselineValidation: baselineValidation.records,
            finalValidation,
            validatorDecision: validation.validatorResult,
            approvedFileScope,
            actualChangedFiles,
            workers: dashboard.snapshots(),
            validationSummary,
            approvalRequired: false,
            gitPublish,
            publishApproval: publishApprovalStatus(gitPublish),
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
    async validateWithRepair(taskId, request, plan, logRoot, roles, baselineValidation, actualChangedFiles, config) {
        let validation = await this.runValidator(taskId, request, plan, logRoot, roles, baselineValidation, actualChangedFiles);
        const maxAttempts = Number(process.env.PI_ORCHESTRATION_MAX_VALIDATION_REPAIRS ?? config.validation.maximumRepairAttempts);
        for (let attempt = 1; !validation.success && attempt <= maxAttempts; attempt += 1) {
            const workerId = `executor-repair-${String(attempt).padStart(3, "0")}`;
            const logPath = (0, node_path_1.join)(logRoot, `${workerId}.log`);
            const workerPath = await this.workspaceManager.prepareWorker(taskId, workerId);
            await ensureLogFile(logPath);
            const repairWorker = new ExecutorWorker_1.ExecutorWorker(workerId, this.providerRegistry.get(roles.providerFor("executor")), this.eventBus, logPath);
            const repairResult = await repairWorker.repairValidationFailure(taskId, request, plan, repairSummary(validation), workerPath);
            if (!repairResult.success) {
                return {
                    success: false,
                    exitCode: repairResult.exitCode,
                    summary: `Validation failed, repair executor failed: ${repairResult.summary}`
                };
            }
            validation = await this.runValidator(taskId, request, plan, logRoot, roles, baselineValidation, actualChangedFiles);
        }
        return validation;
    }
    async runValidator(taskId, request, plan, logRoot, roles, baselineValidation, actualChangedFiles) {
        const validatorPath = await this.workspaceManager.prepareWorker(taskId, "validator");
        const validatorLog = (0, node_path_1.join)(logRoot, "validator.log");
        await ensureLogFile(validatorLog);
        const validator = new ValidatorWorker_1.ValidatorWorker(this.providerRegistry.get(roles.providerFor("validator")), this.eventBus, validatorLog);
        this.eventBus.publish("validation.started", { taskId }, "validator");
        const result = await validator.validate(taskId, request, plan, validatorPath, baselineValidation, actualChangedFiles);
        this.eventBus.publish("validation.completed", { taskId, result }, "validator");
        for (const finding of result.validatorResult?.findings ?? []) {
            this.eventBus.publish("validator.finding.created", { taskId, finding }, "validator");
        }
        if (result.validatorResult?.decision === "changes_requested") {
            this.eventBus.publish("validator.changes_requested", { taskId, result: result.validatorResult }, "validator");
        }
        return result;
    }
    async confirmAndPublishGitChanges(taskId, request, roles, logRoot, runWorkspace, config) {
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
        if (config.git.publishMode === "disabled") {
            return {
                attempted: false,
                committed: false,
                pushed: false,
                remotes: [],
                repositories: [],
                summary: "git publish skipped: disabled by configuration"
            };
        }
        if (config.git.publishMode !== "automatic_after_validation") {
            if (!this.gitPublishApprovalPath) {
                return {
                    attempted: false,
                    committed: false,
                    pushed: false,
                    remotes: [],
                    repositories: [],
                    summary: "git publish skipped: approval path unavailable"
                };
            }
            await clearDecisionFile(this.gitPublishApprovalPath);
            this.eventBus.publish("task.publish_approval.requested", { taskId, preview }, "runtime");
            this.eventBus.publish("GitPublishApprovalRequired", { taskId, approvalPath: this.gitPublishApprovalPath, preview }, "runtime");
            const approval = await waitForGitPublishApproval(this.gitPublishApprovalPath);
            if (!approval.approved) {
                return {
                    attempted: false,
                    committed: false,
                    pushed: false,
                    remotes: [],
                    repositories: [],
                    summary: approval.reason ? `git publish rejected: ${approval.reason}` : "git publish rejected by user"
                };
            }
            this.eventBus.publish("task.publish_approval.received", { taskId }, "runtime");
        }
        this.eventBus.publish("git.publish.started", { taskId }, "runtime");
        const result = await (0, GitPublisher_1.publishTaskChanges)(this.projectRoot, taskId, request, {
            commitMessageProvider: this.providerRegistry.get(roles.providerFor("validator")),
            logPath: (0, node_path_1.join)(logRoot, "commit-message.log"),
            workspacePath: (0, node_path_1.join)(runWorkspace, "commit-message"),
            push: config.git.publishMode !== "commit_only_after_approval"
        });
        this.eventBus.publish(result.committed && result.pushed ? "git.publish.completed" : "git.publish.failed", { taskId, result }, "runtime");
        return result;
    }
    async runBaselineIfRequired(taskId, request, plan, logRoot, roles, approvedFileScope, config) {
        if (!requiresBaseline(plan, config))
            return { success: true, summary: plan.characterizationSkipReason ?? "baseline skipped", records: [] };
        this.eventBus.publish("task.baseline.started", { taskId }, "runtime");
        const workerId = "executor-characterization-001";
        const logPath = (0, node_path_1.join)(logRoot, `${workerId}.log`);
        const workerPath = await this.workspaceManager.prepareWorker(taskId, workerId);
        await ensureLogFile(logPath);
        const baselineSubtask = {
            id: "characterization-baseline",
            title: "Characterization tests",
            description: "Add tests for existing affected behavior before production implementation.",
            roleHint: "tests",
            dependsOn: [],
            filesHint: approvedFileScope.flatMap((scope) => [...scope.allowedFiles, ...scope.allowedDirectories]),
            assignmentType: "characterization_tests",
            fileScope: mergeScopes(approvedFileScope)
        };
        const before = await changedFiles(this.projectRoot);
        const worker = new ExecutorWorker_1.ExecutorWorker(workerId, this.providerRegistry.get(roles.providerFor("executor")), this.eventBus, logPath);
        const result = await worker.run(taskId, request, [baselineSubtask], workerPath);
        const changed = subtract(await changedFiles(this.projectRoot), before);
        const productionChanges = changed.filter((file) => !isTestPath(file));
        const record = {
            command: "characterization executor",
            category: "unit",
            required: true,
            status: result.success && productionChanges.length === 0 ? "passed" : "failed",
            exitCode: result.exitCode,
            outputSummary: productionChanges.length ? `production files changed: ${productionChanges.join(", ")}` : result.summary
        };
        const success = record.status === "passed";
        this.eventBus.publish(success ? "task.baseline.passed" : "task.baseline.failed", { taskId, record }, "runtime");
        return { success, summary: record.outputSummary ?? result.summary, records: [record] };
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
function assignSubtasksByScope(subtasks, executorCount) {
    const assignments = assignSubtasks(subtasks, executorCount);
    const groups = [];
    for (const assignment of assignments) {
        const group = groups.find((candidate) => candidate.every((existing) => !scopesOverlap(scopeForSubtasks(existing), scopeForSubtasks(assignment))));
        if (group) {
            group.push(assignment);
        }
        else {
            groups.push([assignment]);
        }
    }
    return groups;
}
function scopesForPlan(plan) {
    const scopes = [
        ...(plan.fileOwnership ?? []),
        ...plan.subtasks.map((task) => task.fileScope).filter((scope) => Boolean(scope))
    ];
    return scopes.length ? scopes : [{ allowedFiles: [], allowedDirectories: ["."] }];
}
function scopeForSubtasks(subtasks) {
    return mergeScopes(subtasks.map((task) => task.fileScope).filter((scope) => Boolean(scope)));
}
function mergeScopes(scopes) {
    return {
        allowedFiles: unique(scopes.flatMap((scope) => scope.allowedFiles)),
        allowedDirectories: unique(scopes.flatMap((scope) => scope.allowedDirectories)),
        readOnlyFiles: unique(scopes.flatMap((scope) => scope.readOnlyFiles ?? [])),
        forbiddenFiles: unique(scopes.flatMap((scope) => scope.forbiddenFiles ?? []))
    };
}
function scopesOverlap(left, right) {
    const leftWritable = [...left.allowedFiles, ...left.allowedDirectories];
    const rightWritable = [...right.allowedFiles, ...right.allowedDirectories];
    if (!leftWritable.length || !rightWritable.length)
        return true;
    return leftWritable.some((item) => rightWritable.some((other) => pathOverlaps(item, other)));
}
function pathOverlaps(left, right) {
    const a = normalizePath(left);
    const b = normalizePath(right);
    return a === "." || b === "." || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
function executorFailure(results) {
    const failed = results.filter((result) => !result.success);
    if (!failed.length)
        return undefined;
    return `Executor failed before validation:\n${failed.map((result) => `- ${result.summary}`).join("\n")}`;
}
function publishApprovalStatus(gitPublish) {
    if (!gitPublish)
        return "not_required";
    if (/rejected/.test(gitPublish.summary))
        return "rejected";
    return gitPublish.attempted ? "approved" : "not_required";
}
function requiresBaseline(plan, config) {
    if (plan.nonCodeTask)
        return false;
    if (plan.characterizationRequired)
        return true;
    if (!config.safety.requireCharacterizationTestsForLegacyChanges)
        return false;
    if (plan.riskLevel === "high" || plan.riskLevel === "critical")
        return true;
    return Boolean(plan.impactAnalysis?.testCoverageGaps.length || plan.impactAnalysis?.sharedCallers.length);
}
async function persistPlanArtifacts(root, plan) {
    await writeArtifact(root, "plan.md", [
        `# Plan`,
        "",
        plan.summary ?? plan.request,
        "",
        "## Implementation",
        ...(plan.implementationPlan?.length ? plan.implementationPlan.map((item) => `- ${item}`) : ["- Not listed."])
    ].join("\n"));
    await writeArtifact(root, "impact-analysis.md", JSON.stringify(plan.impactAnalysis ?? {}, null, 2));
    await writeArtifact(root, "regression-matrix.json", JSON.stringify(plan.regressionMatrix ?? [], null, 2));
    await writeArtifact(root, "executor-assignments.json", JSON.stringify(plan.subtasks, null, 2));
}
async function writeArtifact(root, name, content) {
    await (0, promises_1.mkdir)(root, { recursive: true });
    const path = (0, node_path_1.join)(root, name);
    await (0, promises_1.writeFile)(`${path}.tmp`, content, "utf8");
    await (0, promises_1.rename)(`${path}.tmp`, path);
}
async function changedFiles(projectRoot) {
    try {
        const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd: projectRoot });
        return stdout
            .split(/\r?\n/)
            .map((line) => line.slice(3).trim())
            .filter(Boolean)
            .map((line) => normalizePath(line.split(" -> ").at(-1) ?? line));
    }
    catch {
        return [];
    }
}
function unapprovedFiles(files, scopes) {
    return files.filter((file) => !scopes.some((scope) => isInScope(file, scope)));
}
function isInScope(file, scope) {
    const normalized = normalizePath(file);
    if (scope.forbiddenFiles?.map(normalizePath).includes(normalized))
        return false;
    if (scope.readOnlyFiles?.map(normalizePath).includes(normalized))
        return false;
    return scope.allowedFiles.map(normalizePath).includes(normalized)
        || scope.allowedDirectories.map(normalizePath).some((directory) => directory === "." || normalized === directory || normalized.startsWith(`${directory}/`));
}
function subtract(values, existing) {
    const old = new Set(existing);
    return values.filter((value) => !old.has(value));
}
function isTestPath(path) {
    return /(^|\/)(__tests__|tests?|e2e)\//.test(path) || /\.spec\./.test(path) || /\.test\./.test(path);
}
function normalizePath(path) {
    return path.replace(/\\/g, "/").replace(/^\.\//, "");
}
function repairSummary(validation) {
    const repairs = validation.validatorResult?.requiredRepairs ?? [];
    if (!repairs.length)
        return validation.summary;
    return repairs.map((repair) => [
        `Repair ${repair.id}`,
        `Findings: ${repair.findingIds.join(", ")}`,
        `Severity: ${repair.severity}`,
        `Expected correction: ${repair.expectedCorrection}`,
        `Regression scenarios: ${repair.regressionScenarioIds.join(", ")}`
    ].join("\n")).join("\n\n");
}
async function waitForGitPublishApproval(path) {
    if (process.env.PI_ORCHESTRATION_AUTO_APPROVE_GIT === "true")
        return { approved: true };
    while (true) {
        try {
            const parsed = JSON.parse(await (0, promises_1.readFile)(path, "utf8"));
            if (typeof parsed.approved === "boolean")
                return { approved: parsed.approved, reason: parsed.reason };
        }
        catch {
            // Wait for Pi to approve or reject publishing.
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
}
function unique(values) {
    return [...new Set(values.filter(Boolean))];
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
