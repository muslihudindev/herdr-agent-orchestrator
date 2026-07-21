import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EventBus } from "../../event-bus/src/EventBus";
import { createId } from "../../shared/src/ids";
import { PlatformEvent, RunSummary, TaskPlan } from "../../shared/src/types";

export interface RuntimeOrchestratorOptions {
  orchestrationRoot?: string;
  projectRoot?: string;
  storageRoot?: string;
}

export class RuntimeOrchestrator {
  private readonly eventBus = new EventBus();
  private readonly orchestrationRoot: string;
  private readonly projectRoot: string;
  private readonly storageRoot: string;

  constructor(options: RuntimeOrchestratorOptions = {}) {
    this.orchestrationRoot = options.orchestrationRoot ?? process.cwd();
    this.projectRoot = options.projectRoot ?? process.cwd();
    this.storageRoot = options.storageRoot ?? process.cwd();
  }

  events(): EventBus {
    return this.eventBus;
  }

  async run(request: string, preplannedPlan?: TaskPlan, options: { skipPlanApproval?: boolean } = {}): Promise<RunSummary> {
    const taskId = createId("task");
    await mkdir(join(this.storageRoot, "logs"), { recursive: true });
    await mkdir(join(this.storageRoot, "workspace", taskId), { recursive: true });

    this.eventBus.publish("TaskReceived", { taskId, request });

    const requestPath = join(this.storageRoot, "workspace", taskId, "request.txt");
    const eventsPath = join(this.storageRoot, "workspace", taskId, "events.jsonl");
    const summaryPath = join(this.storageRoot, "workspace", taskId, "summary.json");
    const clarificationPath = join(this.storageRoot, "workspace", taskId, "clarification.json");
    const planApprovalPath = join(this.storageRoot, "workspace", taskId, "plan-approval.json");
    const gitPublishApprovalPath = join(this.storageRoot, "workspace", taskId, "git-publish-approval.json");
    const preplannedPlanPath = join(this.storageRoot, "workspace", taskId, "preplanned-plan.json");
    await writeFile(requestPath, request, "utf8");
    await writeFile(eventsPath, "", "utf8");
    if (preplannedPlan) await writeFile(preplannedPlanPath, JSON.stringify(preplannedPlan, null, 2), "utf8");

    const taskManagerLog = join(this.storageRoot, "logs", "task-manager.log");
    await ensureLogFile(taskManagerLog);
    const child = await this.spawnTaskManager(
      taskId,
      requestPath,
      eventsPath,
      summaryPath,
      clarificationPath,
      planApprovalPath,
      gitPublishApprovalPath,
      taskManagerLog,
      "execute",
      preplannedPlan ? preplannedPlanPath : undefined,
      options.skipPlanApproval
    );
    const completed = await this.replayEventsUntilSummary(eventsPath, summaryPath, child);
    if (!completed) {
      await writeFile(summaryPath, JSON.stringify(crashedRunSummary(taskId, request, preplannedPlan), null, 2), "utf8");
      this.eventBus.publish("ApprovalRequired", { taskId, success: false, dashboard: "Orchestration process exited unexpectedly before writing summary." });
    }
    return JSON.parse(await readFile(summaryPath, "utf8")) as RunSummary;
  }

  async planOnly(request: string, options: { revisionFeedback?: string; previousPlan?: TaskPlan } = {}): Promise<{ taskId: string; plan: TaskPlan }> {
    const taskId = createId("task");
    await mkdir(join(this.storageRoot, "logs"), { recursive: true });
    await mkdir(join(this.storageRoot, "workspace", taskId), { recursive: true });

    const requestPath = join(this.storageRoot, "workspace", taskId, "request.txt");
    const eventsPath = join(this.storageRoot, "workspace", taskId, "events.jsonl");
    const summaryPath = join(this.storageRoot, "workspace", taskId, "plan-summary.json");
    const clarificationPath = join(this.storageRoot, "workspace", taskId, "clarification.json");
    const planApprovalPath = join(this.storageRoot, "workspace", taskId, "plan-approval.json");
    const gitPublishApprovalPath = join(this.storageRoot, "workspace", taskId, "git-publish-approval.json");
    const revisionPath = join(this.storageRoot, "workspace", taskId, "revision.txt");
    const previousPlanPath = join(this.storageRoot, "workspace", taskId, "previous-plan.json");
    await writeFile(requestPath, request, "utf8");
    await writeFile(eventsPath, "", "utf8");
    if (options.revisionFeedback) await writeFile(revisionPath, options.revisionFeedback, "utf8");
    if (options.previousPlan) await writeFile(previousPlanPath, JSON.stringify(options.previousPlan, null, 2), "utf8");

    const taskManagerLog = join(this.storageRoot, "logs", `task-manager-${taskId}.log`);
    await ensureLogFile(taskManagerLog);
    const child = await this.spawnTaskManager(
      taskId,
      requestPath,
      eventsPath,
      summaryPath,
      clarificationPath,
      planApprovalPath,
      gitPublishApprovalPath,
      taskManagerLog,
      "plan-only",
      undefined,
      false,
      options.revisionFeedback ? revisionPath : undefined,
      options.previousPlan ? previousPlanPath : undefined
    );
    const completed = await this.replayEventsUntilSummary(eventsPath, summaryPath, child);
    if (!completed) throw new Error("Task Manager exited unexpectedly before producing a plan");
    return JSON.parse(await readFile(summaryPath, "utf8")) as { taskId: string; plan: TaskPlan };
  }

  private async spawnTaskManager(
    taskId: string,
    requestPath: string,
    eventsPath: string,
    summaryPath: string,
    clarificationPath: string,
    planApprovalPath: string,
    gitPublishApprovalPath: string,
    taskManagerLog: string,
    mode = "execute",
    preplannedPlanPath?: string,
    skipPlanApproval = false,
    revisionPath?: string,
    previousPlanPath?: string
  ): Promise<ChildProcessWithoutNullStreams> {
    const entry = join(this.orchestrationRoot, "dist", "apps", "pi-orchestrator", "src", "index.js");
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
    const child = spawn(process.execPath, args, {
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

  private async replayEventsUntilSummary(
    eventsPath: string,
    summaryPath: string,
    child: ChildProcessWithoutNullStreams | undefined
  ): Promise<boolean> {
    let offset = 0;
    let childExitCode: number | null | undefined;
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

  private async replayNewEvents(eventsPath: string, offset: number): Promise<number> {
    const text = await readFile(eventsPath, "utf8");
    if (text.length === offset) return offset;

    for (const line of text.slice(offset).split(/\r?\n/)) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as PlatformEvent;
      this.eventBus.publish(event.type, event.payload, event.workerId);
    }
    return text.length;
  }
}

function crashedRunSummary(taskId: string, request: string, plan?: TaskPlan): RunSummary {
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

async function ensureLogFile(path: string): Promise<void> {
  await writeFile(path, "", { flag: "a" });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
