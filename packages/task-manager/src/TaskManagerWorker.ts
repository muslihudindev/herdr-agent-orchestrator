import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { EventBus } from "../../event-bus/src/EventBus";
import { TribeManagerProjectConfig } from "../../config/src/TribeManagerConfigLoader";
import { Provider } from "../../providers/src/Provider";
import { createId } from "../../shared/src/ids";
import { FileScope, ProviderTask, RegressionMatrixEntry, Subtask, TaskPlan, TaskSafetyAnalysis, ValidationRecord } from "../../shared/src/types";
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
        "Your job is to investigate the repository and produce the best execution plan for HerdR executors.",
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
        "Before assigning implementation:",
        "1. Read repository instructions: AGENTS.md, nested AGENTS.md, CLAUDE.md, README files, contribution guides, and architecture docs.",
        "2. Trace the complete current behavior from input to final side effects.",
        "3. Identify direct and indirect dependencies.",
        "4. Search for callers of shared code.",
        "5. Identify roles, permissions, statuses, APIs, database tables, events, queues, jobs, and UI flows involved.",
        "6. Find existing tests and coverage gaps.",
        "7. Produce a concrete impact analysis.",
        "8. Produce a repository-specific regression matrix.",
        "9. Classify risk.",
        "10. Propose the smallest implementation.",
        "11. Define characterization tests when affected legacy behavior is not protected.",
        "12. Define executor file ownership.",
        "13. Define required validation commands.",
        "14. Identify approval requirements.",
        "",
        "Use targeted repository tools when available: rg, git grep, git log, git blame, language-server references, test discovery, and package dependency information.",
        "Do not blindly load the entire repository.",
        "Do not produce generic regression entries like 'Ensure existing functionality still works.'",
        "Do not allow production-code implementation before required baseline tests pass.",
        "",
        "Return a concise planning report, then end with the literal marker HERDR_PLAN_JSON followed by one JSON object.",
        "The JSON object must contain summary, clarificationQuestions, currentBehavior, requestedBehavior, impactAnalysis, regressionMatrix, riskLevel, approvalRequired, approvalReasons, implementationPlan, baselineTestPlan, validationPlan, subtasks, executorCount, acceptanceCriteria, fileOwnership, and rollbackPlan.",
        "Set nonCodeTask true only for explanation-only, repository questions, documentation-only requests with no generated behavior, git status inspection, or log analysis without modification.",
        "Each subtask must contain title, description, roleHint, dependsOn, filesHint, assignmentType, and fileScope.",
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

    const result = await this.executeProviderTask(providerTask);
    const detectedTechnology = await detectTechnology(".");
    const providerPlan = await readProviderPlan(workspacePath, this.logPath)
      ?? (isSimulatedResult(result.summary) ? simulatedProviderPlan(request, detectedTechnology) : undefined);
    if (!providerPlan) throw new Error("Task Manager output missing HERDR_PLAN_JSON; refusing to execute without impact analysis and regression matrix.");
    assertSafetyPlan(providerPlan, request);
    const subtasks = normalizeSubtasks(providerPlan?.subtasks, request, detectedTechnology);
    const executorCount = Math.min(this.maxExecutors, Math.max(1, Math.min(subtasks.length, scoreExecutorNeed(request))));
    const plan: TaskPlan = {
      request,
      summary: providerPlan.summary,
      clarificationQuestions: providerPlan.clarificationQuestions ?? [],
      detectedTechnology: providerPlan?.detectedTechnology?.length ? providerPlan.detectedTechnology : detectedTechnology,
      currentBehavior: providerPlan.currentBehavior ?? providerPlan.impactAnalysis?.currentBehavior,
      requestedBehavior: providerPlan.requestedBehavior ?? providerPlan.impactAnalysis?.requestedBehavior,
      impactAnalysis: providerPlan.impactAnalysis,
      regressionMatrix: providerPlan.regressionMatrix,
      riskLevel: providerPlan.riskLevel ?? providerPlan.impactAnalysis?.riskLevel,
      approvalRequired: providerPlan.approvalRequired ?? false,
      approvalReasons: providerPlan.approvalReasons ?? providerPlan.impactAnalysis?.approvalReasons ?? [],
      implementationPlan: providerPlan.implementationPlan ?? [],
      baselineTestPlan: providerPlan.baselineTestPlan ?? [],
      validationPlan: providerPlan.validationPlan ?? [],
      executorAssignments: providerPlan.executorAssignments,
      fileOwnership: providerPlan.fileOwnership ?? subtasks.map((task) => task.fileScope).filter((scope): scope is FileScope => Boolean(scope)),
      rollbackPlan: providerPlan.rollbackPlan ?? [],
      nonCodeTask: providerPlan.nonCodeTask ?? isNonCodeTask(request),
      characterizationRequired: providerPlan.characterizationRequired,
      characterizationSkipReason: providerPlan.characterizationSkipReason,
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
    const tribeTaskId = await readTribeTaskId(this.logPath, taskId);
    return tribeTaskId
      ? { taskId: tribeTaskId, summary: `in-progress sync captured Tribe task ${tribeTaskId}` }
      : { summary: "in-progress sync requested but no Tribe task id was captured" };
  }
}

interface ProviderPlan {
  summary?: string;
  clarificationQuestions?: string[];
  currentBehavior?: string[];
  requestedBehavior?: string[];
  detectedTechnology?: string[];
  impactAnalysis?: TaskSafetyAnalysis;
  regressionMatrix?: RegressionMatrixEntry[];
  riskLevel?: TaskPlan["riskLevel"];
  approvalRequired?: boolean;
  approvalReasons?: string[];
  implementationPlan?: string[];
  baselineTestPlan?: ValidationRecord[];
  validationPlan?: ValidationRecord[];
  executorAssignments?: Subtask[];
  fileOwnership?: FileScope[];
  rollbackPlan?: string[];
  nonCodeTask?: boolean;
  characterizationRequired?: boolean;
  characterizationSkipReason?: string;
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
    filesHint: Array.isArray(task.filesHint) ? task.filesHint : [],
    assignmentType: task.assignmentType,
    fileScope: task.fileScope
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

function isNonCodeTask(request: string): boolean {
  return /(^|\b)(explain|question|what is|status|git status|log analysis|inspect logs?|documentation only|docs only)(\b|$)/i.test(request);
}

function isSimulatedResult(summary: string): boolean {
  return /completed by simulated/i.test(summary);
}

function assertSafetyPlan(plan: ProviderPlan, request: string): void {
  if (plan.nonCodeTask || isNonCodeTask(request)) return;
  if (!plan.impactAnalysis) throw new Error("Task Manager plan missing impactAnalysis.");
  if (!plan.regressionMatrix?.length) throw new Error("Task Manager plan missing regressionMatrix.");
  if (plan.regressionMatrix.some(isGenericRegressionEntry)) {
    throw new Error("Task Manager regressionMatrix contains generic entries; refusing to execute without repository-specific scenarios.");
  }
}

function isGenericRegressionEntry(entry: RegressionMatrixEntry): boolean {
  const text = `${entry.area} ${entry.scenario} ${entry.existingBehavior} ${entry.expectedBehaviorAfterChange}`.toLowerCase();
  return /ensure existing functionality still works|existing functionality|all tests pass|no regressions/.test(text);
}

function simulatedProviderPlan(request: string, technology: string[]): ProviderPlan {
  const nonCodeTask = isNonCodeTask(request);
  const filesHint = nonCodeTask ? [] : ["."];
  const scope: FileScope = {
    allowedFiles: [],
    allowedDirectories: filesHint
  };
  const impactAnalysis: TaskSafetyAnalysis = {
    currentBehavior: ["Simulated provider baseline: current repository behavior must be preserved for directly affected files."],
    requestedBehavior: [request],
    entryPoints: filesHint.map((file) => ({ file, description: "Task Manager must refine this in real provider runs." })),
    directDependencies: [],
    indirectDependencies: [],
    sharedCallers: [],
    affectedRoles: [],
    affectedStatuses: [],
    apiContracts: [],
    databaseImpacts: [],
    eventImpacts: [],
    uiImpacts: [],
    regressionRisks: nonCodeTask ? [] : [{
      area: "Simulated repository",
      scenario: "Directly affected behavior remains compatible while the requested change is implemented",
      riskLevel: "low",
      reason: "Simulated provider supplies compatibility coverage for orchestration tests only."
    }],
    testCoverageGaps: nonCodeTask ? [] : [{
      area: "Simulated repository",
      scenario: "Affected behavior requires a concrete repository-specific test in real provider runs",
      requiredTestType: "unit",
      reason: "Simulated provider cannot inspect a real target project."
    }],
    riskLevel: "low",
    approvalReasons: []
  };
  const regressionMatrix: RegressionMatrixEntry[] = nonCodeTask ? [] : [{
    id: "simulated-primary",
    area: "Simulated repository",
    scenario: "Directly affected behavior before and after the requested change",
    existingBehavior: "Existing observable behavior is preserved unless the approved request changes it.",
    expectedBehaviorAfterChange: "Requested behavior is added with no unrelated behavior change.",
    riskLevel: "low",
    requiredTestType: "unit",
    relatedFiles: filesHint,
    validationStatus: "pending"
  }];

  return {
    summary: "Simulated safety plan",
    detectedTechnology: technology,
    currentBehavior: impactAnalysis.currentBehavior,
    requestedBehavior: impactAnalysis.requestedBehavior,
    impactAnalysis,
    regressionMatrix,
    riskLevel: "low",
    approvalRequired: false,
    approvalReasons: [],
    implementationPlan: ["Complete the requested behavior with the smallest possible change."],
    baselineTestPlan: [],
    validationPlan: [{
      command: "simulated validation",
      category: "custom",
      required: false,
      status: "pending"
    }],
    subtasks: createSubtasks(request, technology).map((task) => ({ ...task, assignmentType: task.roleHint === "tests" ? "feature_tests" : "implementation", fileScope: scope })),
    executorCount: Math.min(2, Math.max(1, scoreExecutorNeed(request))),
    acceptanceCriteria: ["Assigned subtasks completed", "Validator independently checks the result"],
    fileOwnership: [scope],
    rollbackPlan: ["Revert the simulated changes if validation fails."],
    nonCodeTask,
    characterizationRequired: false,
    characterizationSkipReason: "Simulated provider has no real legacy behavior to characterize."
  };
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

async function readTribeTaskId(logPath: string, taskId: string): Promise<number | undefined> {
  try {
    const text = await readFile(logPath, "utf8");
    return parseTribeTaskId(text.slice(Math.max(0, text.lastIndexOf(`Task ID: ${taskId}`))));
  } catch {
    return undefined;
  }
}

export function parseTribeTaskId(text: string): number | undefined {
  const matches = [...text.matchAll(/HERDR_TRIBE_JSON[\s\S]*?(\{[^}]*\})/g)];
  for (const match of matches.reverse()) {
    try {
      const parsed = JSON.parse(match[1].replace(/\\"/g, '"')) as { taskId?: unknown; task_id?: unknown };
      const id = parsed.taskId ?? parsed.task_id;
      if (typeof id === "number") return id;
    } catch {
      // Ignore malformed marker output and keep looking in the current task section.
    }
  }
  return undefined;
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
