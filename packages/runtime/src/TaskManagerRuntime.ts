import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConfigLoader } from "../../config/src/ConfigLoader";
import { TribeManagerConfigLoader } from "../../config/src/TribeManagerConfigLoader";
import { Dashboard } from "../../dashboard/src/Dashboard";
import { EventBus } from "../../event-bus/src/EventBus";
import { ProviderRegistry } from "../../providers/src/ProviderRegistry";
import { RoleRegistry } from "../../registry/src/RoleRegistry";
import { RunSummary, Subtask } from "../../shared/src/types";
import { TaskManagerWorker } from "../../task-manager/src/TaskManagerWorker";
import { ValidatorWorker } from "../../validator/src/ValidatorWorker";
import { ExecutorWorker } from "../../workers/src/ExecutorWorker";
import { WorkspaceManager } from "../../workspace/src/WorkspaceManager";
import { GitPublishResult, previewTaskChanges, publishTaskChanges } from "./GitPublisher";

export interface TaskManagerRuntimeOptions {
  orchestrationRoot?: string;
  projectRoot?: string;
  storageRoot?: string;
  clarificationPath?: string;
  planApprovalPath?: string;
  gitPublishApprovalPath?: string;
  preplannedPlanPath?: string;
  skipPlanApproval?: boolean;
}

export class TaskManagerRuntime {
  private readonly maxValidationRepairAttempts = Number(process.env.PI_ORCHESTRATION_MAX_VALIDATION_REPAIRS ?? 1);
  private readonly providerRegistry = new ProviderRegistry();
  private readonly orchestrationRoot: string;
  private readonly projectRoot: string;
  private readonly storageRoot: string;
  private readonly clarificationPath?: string;
  private readonly planApprovalPath?: string;
  private readonly gitPublishApprovalPath?: string;
  private readonly preplannedPlanPath?: string;
  private readonly skipPlanApproval: boolean;
  private readonly workspaceManager: WorkspaceManager;

  constructor(
    private readonly eventBus: EventBus,
    options: TaskManagerRuntimeOptions = {}
  ) {
    this.orchestrationRoot = options.orchestrationRoot ?? process.env.PI_ORCHESTRATION_ROOT ?? process.cwd();
    this.projectRoot = options.projectRoot ?? process.env.PI_ORCHESTRATION_PROJECT_ROOT ?? process.cwd();
    this.storageRoot = options.storageRoot ?? process.env.PI_ORCHESTRATION_STORAGE_ROOT ?? process.cwd();
    this.clarificationPath = options.clarificationPath;
    this.planApprovalPath = options.planApprovalPath;
    this.gitPublishApprovalPath = options.gitPublishApprovalPath;
    this.preplannedPlanPath = options.preplannedPlanPath;
    this.skipPlanApproval = options.skipPlanApproval ?? false;
    this.workspaceManager = new WorkspaceManager(join(this.storageRoot, "workspace"));
  }

  async execute(taskId: string, request: string): Promise<RunSummary> {
    process.env.PI_ORCHESTRATION_ROOT = this.orchestrationRoot;
    process.env.PI_ORCHESTRATION_PROJECT_ROOT = this.projectRoot;
    process.env.PI_ORCHESTRATION_STORAGE_ROOT = this.storageRoot;

    const configLoader = new ConfigLoader(
      process.env.PI_ORCHESTRATION_ROLES_PATH ?? join(this.orchestrationRoot, "config", "roles.yaml"),
      process.env.PI_ORCHESTRATION_PROVIDERS_PATH ?? join(this.orchestrationRoot, "config", "providers.yaml")
    );
    const config = await configLoader.load();
    const tribeManagerConfig = await new TribeManagerConfigLoader(
      process.env.PI_ORCHESTRATION_TRIBE_MANAGER_PATH ?? join(this.orchestrationRoot, "config", "tribe-manager.yaml")
    ).configForProject(this.projectRoot);
    const roles = new RoleRegistry(config);
    this.providerRegistry.configure(config.providers);
    const logRoot = join(this.storageRoot, "logs");
    await mkdir(logRoot, { recursive: true });

    const dashboard = new Dashboard(this.eventBus);
    const stopDashboard = dashboard.start();
    const runWorkspace = await this.workspaceManager.prepareRun(taskId);
    const taskManager = new TaskManagerWorker(
      this.providerRegistry.get(roles.providerFor("task_manager")),
      this.eventBus,
      join(logRoot, "task-manager.log"),
      roles.replicasFor("executor")
    );
    const tribeSyncWorker = new TaskManagerWorker(
      this.providerRegistry.get(providerForTribeSync(config.providers, roles.providerFor("executor"))),
      this.eventBus,
      join(logRoot, "tribe-manager-sync.log"),
      roles.replicasFor("executor")
    );

    const taskManagerLog = join(logRoot, "task-manager.log");
    await ensureLogFile(taskManagerLog);
    let effectiveRequest = request;
    let plan: RunSummary["plan"] | undefined = this.preplannedPlanPath ? await readPreplannedPlan(this.preplannedPlanPath) : undefined;
    if (!plan && this.clarificationPath) {
      const questions = await taskManager.clarify(taskId, request, join(runWorkspace, "task-manager-clarify"));
      if (questions.length) {
        this.eventBus.publish("ClarificationRequired", { taskId, questions, answerPath: this.clarificationPath }, "task-manager");
        const answer = await waitForClarification(this.clarificationPath);
        effectiveRequest = `${request}\n\nUser clarification:\n${answer}`;
      }
    }
    plan = plan ?? await taskManager.plan(taskId, effectiveRequest, join(runWorkspace, "task-manager"), tribeManagerConfig);
    if (this.planApprovalPath && !this.skipPlanApproval) {
      let revisionCount = 0;
      while (true) {
        await clearDecisionFile(this.planApprovalPath);
        this.eventBus.publish("PlanApprovalRequired", { taskId, plan, approvalPath: this.planApprovalPath, revisionCount }, "task-manager");
        const approval = await waitForPlanApproval(this.planApprovalPath);
        if (approval.revision) {
          revisionCount += 1;
          plan = await taskManager.plan(
            taskId,
            effectiveRequest,
            join(runWorkspace, `task-manager-revision-${revisionCount}`),
            tribeManagerConfig,
            approval.revision,
            plan
          );
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
    const tribeInProgressSync = await tribeSyncWorker.reportApprovedTask(
      taskId,
      effectiveRequest,
      plan,
      join(runWorkspace, "tribe-manager-approved"),
      tribeManagerConfig
    );
    if (tribeInProgressSync.taskId) await writeStoredTribeTaskId(this.storageRoot, taskId, tribeInProgressSync.taskId);
    const tribeTaskId = tribeInProgressSync.taskId ?? await readStoredTribeTaskId(this.storageRoot, taskId);
    const assignments = assignSubtasks(plan.subtasks, plan.executorCount);

    const executorResults = await Promise.all(
      assignments.map(async (subtasks, index) => {
        const workerId = `executor-${String(index + 1).padStart(3, "0")}`;
        const logPath = join(logRoot, `${workerId}.log`);
        const workerPath = await this.workspaceManager.prepareWorker(taskId, workerId);
        await ensureLogFile(logPath);
        const worker = new ExecutorWorker(
          workerId,
          this.providerRegistry.get(roles.providerFor("executor")),
          this.eventBus,
          logPath
        );
        return worker.run(taskId, effectiveRequest, subtasks, workerPath);
      })
    );

    const executorFailureSummary = executorFailure(executorResults);
    const validation = executorFailureSummary
      ? { success: false, summary: executorFailureSummary }
      : await this.validateWithRepair(taskId, effectiveRequest, plan, logRoot, roles);
    const workSucceeded = !executorFailureSummary && validation.success;
    const gitPublish = workSucceeded ? await this.confirmAndPublishGitChanges(taskId, effectiveRequest, roles, logRoot, runWorkspace) : undefined;
    const success = workSucceeded && (!gitPublish?.attempted || (gitPublish.committed && gitPublish.pushed));
    const validationSummary = success || !gitPublish?.attempted ? validation.summary : `${validation.summary}\n${gitPublish.summary}`;
    const tribeCompletionSync = await tribeSyncWorker.reportCompletion(
      taskId,
      effectiveRequest,
      success,
      validationSummary,
      join(runWorkspace, "tribe-manager-complete"),
      tribeManagerConfig,
      tribeTaskId
    );
    if (!success) this.eventBus.publish("ApprovalRequired", { taskId, success, dashboard: dashboard.render() });
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

  async planOnly(taskId: string, request: string, revisionFeedback?: string, previousPlan?: RunSummary["plan"]): Promise<RunSummary["plan"]> {
    process.env.PI_ORCHESTRATION_ROOT = this.orchestrationRoot;
    process.env.PI_ORCHESTRATION_PROJECT_ROOT = this.projectRoot;
    process.env.PI_ORCHESTRATION_STORAGE_ROOT = this.storageRoot;

    const configLoader = new ConfigLoader(
      process.env.PI_ORCHESTRATION_ROLES_PATH ?? join(this.orchestrationRoot, "config", "roles.yaml"),
      process.env.PI_ORCHESTRATION_PROVIDERS_PATH ?? join(this.orchestrationRoot, "config", "providers.yaml")
    );
    const config = await configLoader.load();
    const tribeManagerConfig = await new TribeManagerConfigLoader(
      process.env.PI_ORCHESTRATION_TRIBE_MANAGER_PATH ?? join(this.orchestrationRoot, "config", "tribe-manager.yaml")
    ).configForProject(this.projectRoot);
    const roles = new RoleRegistry(config);
    this.providerRegistry.configure(config.providers);
    const logRoot = join(this.storageRoot, "logs");
    await mkdir(logRoot, { recursive: true });

    const runWorkspace = await this.workspaceManager.prepareRun(taskId);
    const taskManagerLog = join(logRoot, `task-manager-${taskId}.log`);
    await ensureLogFile(taskManagerLog);
    const taskManager = new TaskManagerWorker(
      this.providerRegistry.get(roles.providerFor("task_manager")),
      this.eventBus,
      taskManagerLog,
      roles.replicasFor("executor")
    );

    return taskManager.plan(taskId, request, join(runWorkspace, "task-manager-preplan"), tribeManagerConfig, revisionFeedback, previousPlan);
  }

  private async validateWithRepair(
    taskId: string,
    request: string,
    plan: RunSummary["plan"],
    logRoot: string,
    roles: RoleRegistry
  ) {
    let validation = await this.runValidator(taskId, plan, logRoot, roles);

    for (let attempt = 1; !validation.success && attempt <= this.maxValidationRepairAttempts; attempt += 1) {
      const workerId = `executor-repair-${String(attempt).padStart(3, "0")}`;
      const logPath = join(logRoot, `${workerId}.log`);
      const workerPath = await this.workspaceManager.prepareWorker(taskId, workerId);
      await ensureLogFile(logPath);
      const repairWorker = new ExecutorWorker(
        workerId,
        this.providerRegistry.get(roles.providerFor("executor")),
        this.eventBus,
        logPath
      );
      const repairResult = await repairWorker.repairValidationFailure(
        taskId,
        request,
        plan,
        validation.summary,
        workerPath
      );

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

  private async runValidator(taskId: string, plan: RunSummary["plan"], logRoot: string, roles: RoleRegistry) {
    const validatorPath = await this.workspaceManager.prepareWorker(taskId, "validator");
    const validatorLog = join(logRoot, "validator.log");
    await ensureLogFile(validatorLog);
    const validator = new ValidatorWorker(
      this.providerRegistry.get(roles.providerFor("validator")),
      this.eventBus,
      validatorLog
    );
    return validator.validate(taskId, plan, validatorPath);
  }

  private async confirmAndPublishGitChanges(
    taskId: string,
    request: string,
    roles: RoleRegistry,
    logRoot: string,
    runWorkspace: string
  ): Promise<GitPublishResult> {
    const preview = await previewTaskChanges(this.projectRoot);
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

    return publishTaskChanges(this.projectRoot, taskId, request, {
      commitMessageProvider: this.providerRegistry.get(roles.providerFor("validator")),
      logPath: join(logRoot, "commit-message.log"),
      workspacePath: join(runWorkspace, "commit-message")
    });
  }
}

function assignSubtasks(subtasks: Subtask[], executorCount: number): Subtask[][] {
  const buckets = Array.from({ length: executorCount }, () => [] as Subtask[]);
  subtasks.forEach((task, index) => {
    buckets[index % executorCount].push(task);
  });
  return buckets.filter((bucket) => bucket.length > 0);
}

function executorFailure(results: Array<{ success: boolean; summary: string }>): string | undefined {
  const failed = results.filter((result) => !result.success);
  if (!failed.length) return undefined;
  return `Executor failed before validation:\n${failed.map((result) => `- ${result.summary}`).join("\n")}`;
}

async function ensureLogFile(path: string): Promise<void> {
  await writeFile(path, "", { flag: "a" });
}

async function waitForPlanApproval(path: string): Promise<{ approved: boolean; reason?: string; revision?: string }> {
  if (process.env.PI_ORCHESTRATION_AUTO_APPROVE_PLAN === "true") {
    return { approved: true };
  }

  while (true) {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as { approved?: boolean; reason?: string; revision?: string };
      if (typeof parsed.revision === "string" && parsed.revision.trim()) {
        return { approved: false, revision: parsed.revision.trim() };
      }
      if (typeof parsed.approved === "boolean") {
        return { approved: parsed.approved, reason: parsed.reason };
      }
    } catch {
      // Wait for Pi to confirm or reject the Task Manager plan.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function clearDecisionFile(path: string): Promise<void> {
  await writeFile(path, "", "utf8");
}

async function waitForClarification(path: string): Promise<string> {
  if (process.env.PI_ORCHESTRATION_AUTO_CLARIFY) return process.env.PI_ORCHESTRATION_AUTO_CLARIFY;

  while (true) {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as { answer?: string };
      if (typeof parsed.answer === "string" && parsed.answer.trim()) return parsed.answer.trim();
    } catch {
      // Wait for Pi to write the clarification answer.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function readPreplannedPlan(path: string): Promise<RunSummary["plan"] | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as RunSummary["plan"];
  } catch {
    return undefined;
  }
}

async function writeStoredTribeTaskId(storageRoot: string, taskId: string, tribeTaskId: number): Promise<void> {
  const path = join(storageRoot, "tribe-task-ids.json");
  const ids = await readStoredTribeTaskIds(path);
  ids[taskId] = tribeTaskId;
  await writeFile(path, JSON.stringify(ids, null, 2), "utf8");
}

async function readStoredTribeTaskId(storageRoot: string, taskId: string): Promise<number | undefined> {
  return (await readStoredTribeTaskIds(join(storageRoot, "tribe-task-ids.json")))[taskId];
}

async function readStoredTribeTaskIds(path: string): Promise<Record<string, number>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
  } catch {
    return {};
  }
}

function providerForTribeSync(providers: Record<string, unknown>, fallback: string): string {
  return Object.hasOwn(providers, "claude-code") ? "claude-code" : fallback;
}
