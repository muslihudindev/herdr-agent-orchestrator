import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { EventBus } from "../../event-bus/src/EventBus";
import { TribeManagerProjectConfig } from "../../config/src/TribeManagerConfigLoader";
import { Provider } from "../../providers/src/Provider";
import { createId } from "../../shared/src/ids";
import { ProviderTask, Subtask, TaskPlan } from "../../shared/src/types";
import { BaseWorker } from "../../workers/src/BaseWorker";

export class TaskManagerWorker extends BaseWorker {
  constructor(provider: Provider, eventBus: EventBus, logPath: string, private readonly maxExecutors: number) {
    super("task-manager", "task_manager", provider, eventBus, logPath);
  }

  async clarify(taskId: string, request: string, workspacePath: string): Promise<string[]> {
    const providerTask: ProviderTask = {
      taskId: createId("provider"),
      role: "task_manager",
      workerId: this.id,
      instruction: [
        "You are the Task Manager.",
        "Read enough repository context to decide whether the user request is actionable.",
        "Ask clarification only when missing information would materially change the implementation plan.",
        "",
        "Hard boundaries:",
        "You may inspect and read repository files.",
        "Do not implement code, edit files, run tests, or spawn agents.",
        "",
        "End with the literal marker HERDR_CLARIFICATION_JSON followed by one JSON object.",
        'Use {"questions": []} when no clarification is needed.',
        'Use {"questions": ["question"]} when clarification is needed.',
        "",
        "User request:",
        request
      ].join("\n"),
      workspacePath,
      logPath: this.logPath,
      metadata: { request, clarification: true }
    };

    await this.executeProviderTask(providerTask);
    return readClarificationQuestions(this.logPath);
  }

  async plan(
    taskId: string,
    request: string,
    workspacePath: string,
    tribeManagerConfig?: TribeManagerProjectConfig,
    revisionFeedback?: string,
    previousPlan?: TaskPlan
  ): Promise<TaskPlan> {
    const providerTask: ProviderTask = {
      taskId: createId("provider"),
      role: "task_manager",
      workerId: this.id,
      instruction: [
        "You are the Task Manager.",
        "Your job is to read the repository and produce the best execution plan for HerdR executors.",
        "",
        "Hard boundaries:",
        "You may inspect and read repository files.",
        "Do not implement code.",
        "Do not edit files.",
        "Do not run tests, lint, build, or validation commands.",
        "Do not spawn agents, subagents, background agents, workers, or executors.",
        "Do not call any internal multi-agent, delegation, plan-update, or task-spawning tool.",
        "Do not say that you are launching, spawning, assigning, or delegating to executors.",
        "HerdR is the only system allowed to create executors.",
        "",
        "Return a concise planning report, then end with the literal marker HERDR_PLAN_JSON followed by one JSON object.",
        "The JSON object must contain detectedTechnology, executorCount, subtasks, and acceptanceCriteria.",
        "Each subtask must contain title, description, roleHint, dependsOn, and filesHint.",
        "",
        "Choose the best concrete tasks for executors after reading the code.",
        "Use filesHint to prevent overlapping edits where possible.",
        "If tests are needed, create a dedicated test-writing subtask; do not run tests yourself.",
        "",
        ...revisionInstructions(revisionFeedback, previousPlan),
        "",
        "User request:",
        request
      ].join("\n"),
      workspacePath,
      logPath: this.logPath,
      metadata: { request, tribeManagerConfig, revisionFeedback, previousPlan }
    };

    await this.executeProviderTask(providerTask);
    const detectedTechnology = await detectTechnology(".");
    const providerPlan = await readProviderPlan(workspacePath, this.logPath);
    const subtasks = normalizeSubtasks(providerPlan?.subtasks, request, detectedTechnology);
    const executorCount = Math.min(this.maxExecutors, Math.max(1, Math.min(subtasks.length, scoreExecutorNeed(request))));
    const plan: TaskPlan = {
      request,
      detectedTechnology: providerPlan?.detectedTechnology?.length ? providerPlan.detectedTechnology : detectedTechnology,
      subtasks,
      executorCount: normalizeExecutorCount(providerPlan?.executorCount, executorCount, this.maxExecutors, subtasks.length),
      acceptanceCriteria: providerPlan?.acceptanceCriteria?.length ? providerPlan.acceptanceCriteria : [
        "Assigned subtasks completed",
        "Executor assigned to tests added or updated relevant tests",
        "Validator ran final tests, lint, build, or available verification commands",
        "Human approval is requested before finishing"
      ]
    };

    this.eventBus.publish("TaskAssigned", { taskId, plan }, this.id);
    return plan;
  }

  async reportCompletion(
    taskId: string,
    request: string,
    success: boolean,
    validationSummary: string,
    workspacePath: string,
    tribeManagerConfig?: TribeManagerProjectConfig,
    tribeTaskId?: number
  ): Promise<string> {
    const instructions = tribeManagerInstructions("complete", request, tribeManagerConfig, { success, validationSummary, tribeTaskId });
    if (!instructions.length) return tribeSyncSkippedReason(request, tribeManagerConfig);
    if (!tribeTaskId) return "completion sync skipped: no captured Tribe task id";

    const providerTask: ProviderTask = {
      taskId: createId("provider"),
      role: "task_manager",
      workerId: this.id,
      instruction: [
        "You are the Task Manager.",
        "The task has completed validation. Do not implement code, edit files, run tests, or spawn agents.",
        "",
        ...instructions,
        "",
        "Completion context:",
        `Task ID: ${taskId}`,
        `Validation: ${success ? "passed" : "failed"}`,
        `Validation summary: ${validationSummary}`,
        "",
        "Original user request:",
        request
      ].join("\n"),
      workspacePath,
      logPath: this.logPath,
      metadata: { request, success, validationSummary, tribeManagerConfig, tribeTaskId }
    };

    const result = await this.executeProviderTask(providerTask);
    return result.success
      ? tribeTaskId
        ? `completion sync requested for Tribe task ${tribeTaskId}`
        : "completion sync requested without captured Tribe task id"
      : `completion sync provider failed: ${result.summary}`;
  }

  async reportApprovedTask(
    taskId: string,
    request: string,
    plan: TaskPlan,
    workspacePath: string,
    tribeManagerConfig?: TribeManagerProjectConfig
  ): Promise<{ taskId?: number; summary: string }> {
    const instructions = tribeManagerInstructions("approved", request, tribeManagerConfig, { plan });
    if (!instructions.length) return { summary: tribeSyncSkippedReason(request, tribeManagerConfig) };

    const providerTask: ProviderTask = {
      taskId: createId("provider"),
      role: "task_manager",
      workerId: this.id,
      instruction: [
        "You are the Task Manager.",
        "The user approved the Task Manager plan. Do not implement code, edit files, run tests, or spawn agents.",
        "",
        ...instructions,
        "",
        "Approved task context:",
        `Task ID: ${taskId}`,
        `Executors approved: ${plan.executorCount}`,
        "",
        "Approved subtasks:",
        ...plan.subtasks.map((task) => `- ${task.id}: ${task.title}\n  ${task.description}`),
        "",
        "Original user request:",
        request
      ].join("\n"),
      workspacePath,
      logPath: this.logPath,
      metadata: { request, plan, tribeManagerConfig }
    };

    const result = await this.executeProviderTask(providerTask);
    if (!result.success) return { summary: `in-progress sync provider failed: ${result.summary}` };
    const tribeTaskId = await readTribeTaskId(this.logPath);
    return tribeTaskId
      ? { taskId: tribeTaskId, summary: `in-progress sync captured Tribe task ${tribeTaskId}` }
      : { summary: "in-progress sync requested but no Tribe task id was captured" };
  }
}

interface ProviderPlan {
  detectedTechnology?: string[];
  executorCount?: number;
  subtasks?: Array<Partial<Subtask>>;
  acceptanceCriteria?: string[];
}

async function readProviderPlan(workspacePath: string, logPath: string): Promise<ProviderPlan | undefined> {
  try {
    const parsed = parseJsonBlock(await readFile(logPath, "utf8"));
    if (parsed) return parsed;
  } catch {
    // Fall back to artifacts in the worker workspace.
  }

  try {
    const files = await readdir(workspacePath);
    const candidates = files.filter((file) => file.endsWith("-result.md") || file.endsWith(".md"));
    for (const file of candidates) {
      const parsed = parseJsonBlock(await readFile(join(workspacePath, file), "utf8"));
      if (parsed) return parsed;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function parseJsonBlock(text: string): ProviderPlan | undefined {
  const marker = "HERDR_PLAN_JSON";
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex < 0) return undefined;

  const afterMarker = text.slice(markerIndex + marker.length).trim();
  const start = afterMarker.indexOf("{");
  const end = afterMarker.lastIndexOf("}");
  const jsonText = start >= 0 && end >= start ? afterMarker.slice(start, end + 1) : undefined;
  if (!jsonText) return undefined;

  try {
    const parsed = JSON.parse(jsonText) as ProviderPlan;
    if (Array.isArray(parsed.subtasks)) return parsed;
  } catch {
    return undefined;
  }
  return undefined;
}

async function readClarificationQuestions(logPath: string): Promise<string[]> {
  try {
    const marker = "HERDR_CLARIFICATION_JSON";
    const text = await readFile(logPath, "utf8");
    const markerIndex = text.lastIndexOf(marker);
    if (markerIndex < 0) return [];
    const afterMarker = text.slice(markerIndex + marker.length).trim();
    const start = afterMarker.indexOf("{");
    const end = afterMarker.lastIndexOf("}");
    if (start < 0 || end < start) return [];
    const parsed = JSON.parse(afterMarker.slice(start, end + 1)) as { questions?: unknown };
    return Array.isArray(parsed.questions) ? parsed.questions.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
  } catch {
    return [];
  }
}

function normalizeSubtasks(input: Array<Partial<Subtask>> | undefined, request: string, technology: string[]): Subtask[] {
  const source = input?.length ? input : createSubtasks(request, technology);
  return source.map((task, index) => ({
    id: task.id || `task-${String(index + 1).padStart(2, "0")}`,
    title: task.title || "Executor task",
    description: task.description || "Complete the assigned work.",
    roleHint: task.roleHint || "core",
    dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn : [],
    filesHint: Array.isArray(task.filesHint) ? task.filesHint : []
  }));
}

function normalizeExecutorCount(value: number | undefined, fallback: number, maxExecutors: number, subtaskCount: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(maxExecutors, Math.max(1, Math.min(subtaskCount, Math.floor(value))));
}

async function detectTechnology(root: string): Promise<string[]> {
  const files = await listFiles(root, 3);
  const tech = new Set<string>();
  const names = files.map((file) => file.toLowerCase());

  if (names.some((file) => file.endsWith("package.json"))) tech.add("Node.js");
  if (names.some((file) => file.includes("vite.config") || file.includes("react"))) tech.add("React");
  if (names.some((file) => file.endsWith("docker-compose.yml"))) tech.add("Docker");
  if (names.some((file) => file.includes("prisma") || file.includes("postgres"))) tech.add("PostgreSQL");
  if (names.some((file) => file.endsWith("pyproject.toml") || file.endsWith("requirements.txt"))) tech.add("Python");
  if (names.some((file) => file.endsWith("go.mod"))) tech.add("Go");

  return tech.size ? [...tech] : ["Unknown"];
}

async function listFiles(root: string, maxDepth: number, depth = 0): Promise<string[]> {
  if (depth > maxDepth) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path, maxDepth, depth + 1)));
    } else if ((await stat(path)).isFile()) {
      files.push(path);
    }
  }

  return files;
}

function createSubtasks(request: string, technology: string[]): Subtask[] {
  const lower = request.toLowerCase();
  const subtasks: Array<Omit<Subtask, "id">> = [];

  if (isGitRelatedTask(request)) {
    subtasks.push(subtask("Git requested changes", "Inspect git status, commit the completed work when appropriate, and push only if the repository remote is configured and the user request explicitly asks for it.", "git"));
  } else if (lower.includes("auth") || lower.includes("jwt")) {
    subtasks.push(subtask("Authentication middleware", "Implement request authentication and authorization boundaries.", "backend"));
    subtasks.push(subtask("JWT service", "Implement token creation, verification, and expiry behavior.", "backend"));
    subtasks.push(subtask("Refresh token support", "Implement refresh-token lifecycle, storage hooks, and invalidation paths.", "backend"));
  } else {
    subtasks.push(subtask("Core implementation", "Implement the requested behavior in the relevant modules.", "core"));
  }

  if (technology.includes("React") || lower.includes("frontend") || lower.includes("ui")) {
    subtasks.push(subtask("Frontend integration", "Update user-facing screens and client-side flows.", "frontend"));
  }

  if (!isGitRelatedTask(request)) {
    subtasks.push(
      subtask(
        "Test implementation",
        "Add or update unit, integration, or e2e tests for the changed behavior. Do not run final validation; Validator owns final verification.",
        "tests"
      )
    );
  }
  return subtasks.map((item, index) => ({ ...item, id: `task-${String(index + 1).padStart(2, "0")}` }));
}

function subtask(title: string, description: string, roleHint: string): Omit<Subtask, "id"> {
  return { title, description, roleHint, dependsOn: [], filesHint: [] };
}

function scoreExecutorNeed(request: string): number {
  const lower = request.toLowerCase();
  if (/(auth|jwt|refresh token|database|frontend|full[- ]stack|migration)/.test(lower)) return 3;
  const words = request.trim().split(/\s+/).length;
  if (words > 80) return 5;
  if (words > 25) return 3;
  return 1;
}

export function isGitRelatedTask(request: string): boolean {
  return /(^|\b)(commit|push|git|branch|merge|rebase|pull|stash|tag)(\b|$)/i.test(request);
}

function tribeManagerInstructions(
  phase: "new" | "approved" | "complete",
  request: string,
  config?: TribeManagerProjectConfig,
  context: { plan?: TaskPlan; success?: boolean; validationSummary?: string; tribeTaskId?: number } = {}
): string[] {
  if (!config?.objective || isGitRelatedTask(request)) return [];
  if (!config.objectiveId || !config.userId) {
    return [
      "Tribe Manager MCP:",
      `Project objective: ${config.objective}`,
      "Tribe Manager sync is configured by objective text only. Automatic MCP task sync requires objective_id and user_id in config/tribe-manager.yaml.",
      "Do not call tribe_manager MCP without objective_id and user_id."
    ];
  }

  const action = phase === "approved"
    ? "This non-git task was approved and is now in progress. Call MCP tribe_manager.create_task before executors launch."
    : "This task completed validation. Call MCP tribe_manager.update_task to sync the completion status.";

  const status = phase === "approved" ? "in-progress" : context.success ? "complete" : "blocked";

  return [
    "Tribe Manager MCP:",
    `Project objective: ${config.objective}`,
    `objective_id: ${config.objectiveId}`,
    `user_id: ${config.userId}`,
    action,
    phase === "approved"
      ? `Create or update a Tribe task with status "${status}", task_name derived from the user request, and task_purpose summarizing the approved plan. Use objective_id ${config.objectiveId} and user_id ${config.userId}.`
      : `Update Tribe task_id ${context.tribeTaskId} with status "${status}" and a note containing the validation summary.`,
    context.validationSummary ? `Validation summary: ${context.validationSummary}` : undefined,
    "Do not call tribe_manager.list_tasks.",
    "Do not inspect existing Tribe tasks.",
    "After any create_task call succeeds, end with HERDR_TRIBE_JSON followed by one JSON object like {\"taskId\":123}.",
    "If the tribe_manager MCP tool is unavailable in this provider session, explicitly report that it was unavailable and continue without failing orchestration."
  ].filter((line): line is string => Boolean(line));
}

function tribeSyncSkippedReason(request: string, config?: TribeManagerProjectConfig): string {
  if (!config?.objective) return "Tribe Manager sync skipped: no project objective configured";
  if (isGitRelatedTask(request)) return "Tribe Manager sync skipped: git-related task";
  if (!config.objectiveId || !config.userId) {
    return "Tribe Manager sync skipped: objective_id and user_id are required in config/tribe-manager.yaml";
  }
  return "Tribe Manager sync skipped";
}

async function readTribeTaskId(logPath: string): Promise<number | undefined> {
  try {
    const marker = "HERDR_TRIBE_JSON";
    const text = await readFile(logPath, "utf8");
    const markerIndex = text.lastIndexOf(marker);
    if (markerIndex < 0) return undefined;
    const afterMarker = text.slice(markerIndex + marker.length).trim();
    const start = afterMarker.indexOf("{");
    const end = afterMarker.lastIndexOf("}");
    if (start < 0 || end < start) return undefined;
    const parsed = JSON.parse(afterMarker.slice(start, end + 1)) as { taskId?: unknown; task_id?: unknown };
    const id = parsed.taskId ?? parsed.task_id;
    return typeof id === "number" ? id : undefined;
  } catch {
    return undefined;
  }
}

function revisionInstructions(feedback?: string, previousPlan?: TaskPlan): string[] {
  if (!feedback) return [];

  return [
    "Plan revision requested by user:",
    feedback,
    "",
    "Previous plan:",
    JSON.stringify(previousPlan ?? {}, null, 2),
    "",
    "Revise the plan to address the feedback. Keep useful parts of the previous plan, but change executor tasks, file ownership, executor count, or acceptance criteria when appropriate."
  ];
}
