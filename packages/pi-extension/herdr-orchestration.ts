import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Dashboard } from "../../packages/dashboard/src/Dashboard";
import { RuntimeOrchestrator } from "../../packages/runtime/src/RuntimeOrchestrator";
import type { FileScope, RegressionMatrixEntry, RunSummary, TaskPhase, TaskPlan, TaskSafetyAnalysis, ValidationRecord, ValidatorResult } from "../../packages/shared/src/types";

const execFileAsync = promisify(execFile);
const orchestrationRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const projectRoot = process.cwd();
const storageRoot = join(projectRoot, ".pi", "herdr-orchestration");
const queuePath = join(storageRoot, "queue.json");
const tribeManagerConfigPath = join(orchestrationRoot, "config", "tribe-manager.yaml");
process.env.PI_ORCHESTRATION_TRIBE_MANAGER_PATH = process.env.PI_ORCHESTRATION_TRIBE_MANAGER_PATH ?? tribeManagerConfigPath;

type QueueStatus = "todo" | "inprogress" | "complete" | "failed";

interface QueueItem {
	id: string;
	task: string;
	status: QueueStatus;
	phase?: TaskPhase;
	createdAt: string;
	updatedAt: string;
	startedAt?: string;
	completedAt?: string;
	result?: {
		success: boolean;
		taskId: string;
		summary: string;
		gitPublish?: RunSummary["gitPublish"];
		tribeManagerSync?: RunSummary["tribeManagerSync"];
	};
	error?: string;
	plan?: TaskPlan;
	planTaskId?: string;
	planApprovalStatus?: "pending" | "approved" | "rejected";
	planRevisionCount?: number;
	planningStartedAt?: string;
	plannedAt?: string;
	safetyAnalysis?: TaskSafetyAnalysis;
	regressionMatrix?: RegressionMatrixEntry[];
	baselineValidation?: ValidationRecord[];
	finalValidation?: ValidationRecord[];
	validatorDecision?: ValidatorResult;
	approvedFileScope?: FileScope[];
	actualChangedFiles?: string[];
	publishApproval?: "pending" | "approved" | "rejected" | "not_required";
	riskApprovalStatus?: "pending" | "approved" | "not_required";
}

interface State {
	running: boolean;
	awaitingApproval: boolean;
	awaitingClarification: boolean;
	awaitingPlanApproval: boolean;
	awaitingGitPublishApproval: boolean;
	processing: boolean;
	clarificationPath?: string;
	planApprovalPath?: string;
	gitPublishApprovalPath?: string;
	planApprovalQueueId?: string;
	taskManagerStatus?: "todo" | "inprogress" | "complete" | "failed";
	currentRunTaskId?: string;
	lastTaskId?: string;
	lastSummary?: string;
	lastDashboard?: string;
	lastPlanApproval?: PlanApprovalPayload;
	preplanning: Set<string>;
}

interface PlanApprovalPayload {
	taskId?: string;
	approvalPath?: string;
	revisionCount?: number;
	submittedTask?: string;
	plan?: {
		request?: string;
		detectedTechnology?: string[];
		executorCount?: number;
		subtasks?: Array<{
			id: string;
			title: string;
			description: string;
			roleHint?: string;
			filesHint?: string[];
		}>;
			acceptanceCriteria?: string[];
			currentBehavior?: string[];
			requestedBehavior?: string[];
			impactAnalysis?: TaskSafetyAnalysis;
			regressionMatrix?: RegressionMatrixEntry[];
			riskLevel?: string;
			approvalRequired?: boolean;
			approvalReasons?: string[];
			baselineTestPlan?: ValidationRecord[];
			validationPlan?: ValidationRecord[];
		};
}

interface ClarificationPayload {
	taskId?: string;
	answerPath?: string;
	questions?: string[];
}

interface GitPublishApprovalPayload {
	taskId?: string;
	approvalPath?: string;
	preview?: {
		summary?: string;
		repositories?: Array<{
			path: string;
			changed: boolean;
			remotes: string[];
			summary: string;
		}>;
	};
}

const state: State = {
	running: false,
	awaitingApproval: false,
	awaitingClarification: false,
	awaitingPlanApproval: false,
	awaitingGitPublishApproval: false,
	processing: false,
	preplanning: new Set<string>(),
	taskManagerStatus: "todo",
};

export default function herdrOrchestrationExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		ensureQueueFile();
		ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
		const queue = readQueue();
		if (queue.some((item) => item.status === "inprogress")) {
			for (const item of queue) {
				if (item.status === "inprogress") item.status = "todo";
			}
			writeQueue(queue);
		}
		void preplanQueuedTasks(pi, ctx);
		void processQueue(pi, ctx);
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		return { action: "continue" };
	});

	pi.registerCommand("herdr-start", {
		description: "Start HerdR orchestration explicitly",
		handler: async (args, ctx) => {
			await queueTaskCommand(pi, ctx, args, "/herdr-start <task>");
		},
	});

	pi.registerCommand("herdr-add-task", {
		description: "Add a new HerdR orchestration task to the queue",
		handler: async (args, ctx) => {
			await queueTaskCommand(pi, ctx, args, "/herdr-add-task <task>");
		},
	});

	pi.registerCommand("herdr-confirm", {
		description: "Approve the current HerdR confirmation prompt",
		handler: async (_args, ctx) => {
			if (state.awaitingGitPublishApproval && state.gitPublishApprovalPath) {
				ctx.ui.notify("Use /herdr-approve to approve publishing, or /herdr-reject to reject it.", "warning");
				return;
			}

			if (!state.awaitingPlanApproval || !state.planApprovalPath) {
				const pendingPlan = nextPendingQueuedPlan();
				if (!pendingPlan) {
					ctx.ui.notify("No Task Manager plan is waiting for confirmation.", "warning");
					return;
				}
				if (requiresRiskApproval(pendingPlan)) {
					markRiskApprovalPending(pendingPlan.id);
					ctx.ui.notify(`High-risk plan ${pendingPlan.id} needs /herdr-approve-risk first.`, "warning");
					sendCard(pi, "High-risk approval required", renderQueue(readQueue(), renderRiskApproval(pendingPlan)));
					return;
				}
				approveQueuedPlan(pendingPlan.id);
				sendCard(pi, "Plan approved", "Recovered pending queued plan approval and starting execution.");
				ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
				if (ctx.mode === "tui") {
					void processQueue(pi, ctx);
				} else {
					await processQueue(pi, ctx);
				}
				return;
			}

			const queuePlanId = state.planApprovalQueueId;
			if (queuePlanId) {
				const queuePlan = readQueue().find((item) => item.id === queuePlanId);
				if (queuePlan && requiresRiskApproval(queuePlan)) {
					markRiskApprovalPending(queuePlanId);
					ctx.ui.notify(`High-risk plan ${queuePlanId} needs /herdr-approve-risk first.`, "warning");
					sendCard(pi, "High-risk approval required", renderQueue(readQueue(), renderRiskApproval(queuePlan)));
					return;
				}
				approveQueuedPlan(queuePlanId);
			} else {
				writePlanApproval(state.planApprovalPath, true);
			}
			state.awaitingPlanApproval = false;
			state.planApprovalPath = undefined;
			state.planApprovalQueueId = undefined;
			sendCard(pi, "Plan approved", queuePlanId ? "Plan is approved and will execute when this task becomes active." : "Launching executors and validator.");
			ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
			if (queuePlanId) {
				if (ctx.mode === "tui") {
					void processQueue(pi, ctx);
				} else {
					await processQueue(pi, ctx);
				}
			}
		},
	});

	pi.registerCommand("herdr-answer", {
		description: "Answer Task Manager clarification questions",
		handler: async (args, ctx) => {
			if (!state.awaitingClarification || !state.clarificationPath) {
				ctx.ui.notify("No Task Manager clarification is waiting for an answer.", "warning");
				return;
			}
			const answer = args.trim();
			if (!answer) {
				ctx.ui.notify("Usage: /herdr-answer <answer>", "warning");
				return;
			}
			writeClarificationAnswer(state.clarificationPath, answer);
			state.awaitingClarification = false;
			state.clarificationPath = undefined;
			sendCard(pi, "Clarification received", "Task Manager will continue planning.");
			ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
		},
	});

	pi.registerCommand("herdr-reject-plan", {
		description: "Reject the Task Manager plan before workers launch",
		handler: async (args, ctx) => {
			if (!state.awaitingPlanApproval || !state.planApprovalPath) {
				ctx.ui.notify("No Task Manager plan is waiting for rejection.", "warning");
				return;
			}

			const reason = args.trim();
			if (state.planApprovalQueueId) {
				rejectQueuedPlan(state.planApprovalQueueId, reason || "Task Manager plan rejected.");
			} else {
				writePlanApproval(state.planApprovalPath, false, reason || undefined);
			}
			state.awaitingPlanApproval = false;
			state.planApprovalPath = undefined;
			state.planApprovalQueueId = undefined;
			sendCard(pi, "Plan rejected", reason || "Task Manager plan rejected.");
			ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
		},
	});

	pi.registerCommand("herdr-reject-git", {
		description: "Skip git commit and push for the completed task",
		handler: async (args, ctx) => {
			if (!state.awaitingGitPublishApproval || !state.gitPublishApprovalPath) {
				ctx.ui.notify("No git publish confirmation is waiting.", "warning");
				return;
			}
			writePlanApproval(state.gitPublishApprovalPath, false, args.trim() || undefined);
			state.awaitingGitPublishApproval = false;
			state.gitPublishApprovalPath = undefined;
			sendCard(pi, "Git publish skipped", args.trim() || "Commit and push skipped by user.");
			ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
		},
	});

	pi.registerCommand("herdr-revise-plan", {
		description: "Request Task Manager to revise the current plan",
		handler: async (args, ctx) => {
			if (!state.awaitingPlanApproval || !state.planApprovalPath) {
				ctx.ui.notify("No Task Manager plan is waiting for revision.", "warning");
				return;
			}
			const feedback = args.trim();
			if (!feedback) {
				ctx.ui.notify("Usage: /herdr-revise-plan <feedback>", "warning");
				return;
			}

			if (state.planApprovalQueueId) {
				const queueId = state.planApprovalQueueId;
				state.awaitingPlanApproval = false;
				state.planApprovalPath = undefined;
				state.planApprovalQueueId = undefined;
				sendCard(pi, "Plan revision requested", feedback);
				void revisePreplannedTask(pi, ctx, queueId, feedback);
				ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
				return;
			}

			writePlanRevision(state.planApprovalPath, feedback);
			state.awaitingPlanApproval = false;
			state.planApprovalPath = undefined;
			state.planApprovalQueueId = undefined;
			sendCard(pi, "Plan revision requested", feedback);
			ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
		},
	});

	pi.registerCommand("herdr-plan-detail", {
		description: "Show the full Task Manager plan currently waiting for confirmation",
		handler: async (_args, ctx) => {
			if (!state.lastPlanApproval?.plan) {
				ctx.ui.notify("No Task Manager plan is available.", "warning");
				return;
			}
			sendCard(pi, "Task Manager plan detail", renderQueue(readQueue(), renderPlanDetail(state.lastPlanApproval)));
			ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
		},
	});

	pi.registerCommand("herdr-impact", {
		description: "Show impact analysis for the active or pending HerdR task",
		handler: async (_args, ctx) => {
			const item = currentDetailedTask();
			if (!item) {
				ctx.ui.notify("No HerdR task has impact analysis available.", "warning");
				return;
			}
			sendCard(pi, "Impact analysis", renderQueue(readQueue(), renderImpact(item)));
			ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
		},
	});

	pi.registerCommand("herdr-regression-matrix", {
		description: "Show regression matrix for the active or pending HerdR task",
		handler: async (_args, ctx) => {
			const item = currentDetailedTask();
			if (!item) {
				ctx.ui.notify("No HerdR task has a regression matrix available.", "warning");
				return;
			}
			sendCard(pi, "Regression matrix", renderQueue(readQueue(), renderRegressionMatrix(item)));
			ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
		},
	});

	pi.registerCommand("herdr-validation", {
		description: "Show baseline and final validation for the active or latest HerdR task",
		handler: async (_args, ctx) => {
			const item = currentDetailedTask();
			if (!item) {
				ctx.ui.notify("No HerdR task has validation details available.", "warning");
				return;
			}
			sendCard(pi, "Validation", renderQueue(readQueue(), renderValidation(item)));
			ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
		},
	});

	pi.registerCommand("herdr-approve-risk", {
		description: "Approve high-risk aspects listed in the Task Manager plan",
		handler: async (_args, ctx) => {
			const item = currentDetailedTask();
			if (!item || !requiresRiskApproval(item)) {
				ctx.ui.notify("No high-risk HerdR plan needs approval.", "warning");
				return;
			}
			approveRisk(item.id);
			sendCard(pi, "High-risk approval recorded", renderQueue(readQueue(), `Approved high-risk aspects for ${item.id}. Use /herdr-confirm to approve the plan.`));
			ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
		},
	});

	pi.registerCommand("herdr-status", {
		description: "Show current HerdR orchestration queue status",
		handler: async (_args, ctx) => {
			sendCard(pi, "HerdR queue", renderQueue(readQueue(), state.lastDashboard));
			ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
		},
	});

	pi.registerCommand("herdr-queue", {
		description: "Alias for /herdr-status",
		handler: async (_args, ctx) => {
			sendCard(pi, "HerdR queue", renderQueue(readQueue(), state.lastDashboard));
			ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
		},
	});

	pi.registerCommand("herdr-run-todo", {
		description: "Manually start approved todo tasks or resume their planning prompt",
		handler: async (_args, ctx) => {
			const queue = readQueue();
			const approved = queue.find((item) => item.status === "todo" && item.planApprovalStatus === "approved");
			if (approved) {
				sendCard(pi, "HerdR queue", renderQueue(queue, `Starting approved todo task ${approved.id}.`));
				ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
				if (ctx.mode === "tui") {
					void processQueue(pi, ctx);
				} else {
					await processQueue(pi, ctx);
				}
				return;
			}

			const pending = queue.find((item) => item.status === "todo" && item.plan && item.planApprovalStatus === "pending");
			if (pending) {
				promptQueuedPlanApproval(pi, ctx, pending.id);
				return;
			}

			const unplanned = queue.find((item) => item.status === "todo" && !item.plan);
			if (unplanned) {
				sendCard(pi, "Task Manager planning", renderQueue(queue, `Planning todo task ${unplanned.id}.`));
				void preplanQueuedTasks(pi, ctx);
				ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
				return;
			}

			sendCard(pi, "HerdR queue", renderQueue(queue, "No todo tasks need manual start."));
			ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
		},
	});

	pi.registerCommand("herdr-approve", {
		description: "Approve validated HerdR orchestration for publishing",
		handler: async (_args, ctx) => {
			if (state.awaitingGitPublishApproval && state.gitPublishApprovalPath) {
				writePlanApproval(state.gitPublishApprovalPath, true);
				state.awaitingGitPublishApproval = false;
				state.gitPublishApprovalPath = undefined;
				sendCard(pi, "Publish approved", "Committing and pushing changed repositories.");
				ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
				return;
			}
			if (!state.awaitingApproval || !state.lastTaskId) {
				ctx.ui.notify("No orchestration is waiting for approval.", "warning");
				return;
			}
			sendCard(pi, "HerdR approved", `Approved ${state.lastTaskId}.`);
			state.awaitingApproval = false;
			ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
		},
	});

	pi.registerCommand("herdr-reject", {
		description: "Reject validated HerdR orchestration before publishing",
		handler: async (args, ctx) => {
			if (state.awaitingGitPublishApproval && state.gitPublishApprovalPath) {
				writePlanApproval(state.gitPublishApprovalPath, false, args.trim() || undefined);
				state.awaitingGitPublishApproval = false;
				state.gitPublishApprovalPath = undefined;
				sendCard(pi, "Publish rejected", args.trim() || "Commit and push rejected by user.");
				ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
				return;
			}
			if (!state.awaitingApproval || !state.lastTaskId) {
				ctx.ui.notify("No orchestration is waiting for rejection.", "warning");
				return;
			}
			const reason = args.trim();
			sendCard(pi, "HerdR rejected", `Rejected ${state.lastTaskId}${reason ? `: ${reason}` : "."}`);
			state.awaitingApproval = false;
			ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
		},
	});

	pi.registerCommand("herdr-clear-complete", {
		description: "Remove completed tasks from the local queue file",
		handler: async (_args, ctx) => {
			const remaining = readQueue().filter((item) => item.status !== "complete");
			writeQueue(remaining);
			sendCard(pi, "HerdR queue", renderQueue(remaining, "Completed tasks cleared."));
			ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
		},
	});

	pi.registerCommand("herdr-retry-failed", {
		description: "Requeue a failed HerdR task for rework",
		handler: async (args, ctx) => {
			const queueId = args.trim();
			if (!queueId) {
				ctx.ui.notify("Usage: /herdr-retry-failed <queue-id>", "warning");
				return;
			}

			const retry = retryFailedTask(queueId);
			if (!retry) {
				ctx.ui.notify(`No failed task found for ${queueId}.`, "warning");
				return;
			}

			sendCard(pi, "Task requeued", renderQueue(readQueue(), `Requeued ${queueId} as ${retry.id}.`));
			ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
			void preplanQueuedTasks(pi, ctx);
		},
	});

	pi.registerCommand("herdr-reset-inprogress", {
		description: "Move stuck in-progress HerdR tasks back to todo",
		handler: async (_args, ctx) => {
			const queue = readQueue();
			for (const item of queue) {
				if (item.status === "inprogress") {
					item.status = "todo";
					item.phase = "queued";
					item.updatedAt = new Date().toISOString();
					delete item.startedAt;
					delete item.error;
				}
			}
			writeQueue(queue);
			state.running = false;
			state.processing = false;
			state.awaitingApproval = false;
			state.awaitingClarification = false;
			state.awaitingPlanApproval = false;
			state.awaitingGitPublishApproval = false;
			state.clarificationPath = undefined;
			state.planApprovalPath = undefined;
			state.gitPublishApprovalPath = undefined;
			state.planApprovalQueueId = undefined;
			state.taskManagerStatus = "todo";
			state.currentRunTaskId = undefined;
			sendCard(pi, "HerdR queue", renderQueue(queue, "In-progress tasks reset to todo."));
			ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
		},
	});
}

async function processQueue(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (state.processing) return;
	state.processing = true;

	try {
		while (true) {
			const next = readQueue().find((item) => item.status === "todo" && item.planApprovalStatus === "approved");
			if (!next) break;
			await runOrchestration(pi, ctx, next.id);
		}
	} finally {
		state.processing = false;
		ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
	}
}

async function preplanQueuedTasks(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const candidates = readQueue().filter((item) => item.status === "todo" && !item.plan && !state.preplanning.has(item.id));
	for (const item of candidates) {
		void preplanQueueItem(pi, ctx, item.id);
	}
}

async function preplanQueueItem(pi: ExtensionAPI, ctx: ExtensionContext, queueId: string): Promise<void> {
	const item = readQueue().find((entry) => entry.id === queueId);
	if (!item || item.plan || state.preplanning.has(queueId)) return;

	state.preplanning.add(queueId);
	markPlanningStarted(queueId);
	sendCard(pi, "Task Manager planning", renderQueue(readQueue(), `Planning queued task ${queueId}`));
	ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));

	try {
		await ensureBuilt();
		const runtime = new RuntimeOrchestrator({
			orchestrationRoot,
			projectRoot,
			storageRoot,
		});
		const result = await runtime.planOnly(item.task);
		savePreplannedTask(queueId, result.taskId, result.plan);
		promptQueuedPlanApproval(pi, ctx, queueId);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		markPlanningFailed(queueId, message);
		sendCard(pi, "Task planning failed", renderQueue(readQueue(), message));
	} finally {
		state.preplanning.delete(queueId);
		ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
	}
}

async function revisePreplannedTask(pi: ExtensionAPI, ctx: ExtensionContext, queueId: string, feedback: string): Promise<void> {
	const item = readQueue().find((entry) => entry.id === queueId);
	if (!item?.plan || state.preplanning.has(queueId)) return;

	state.preplanning.add(queueId);
	markPlanningStarted(queueId);
	sendCard(pi, "Task Manager revising plan", renderQueue(readQueue(), `Revising plan for ${queueId}`));
	try {
		await ensureBuilt();
		const runtime = new RuntimeOrchestrator({
			orchestrationRoot,
			projectRoot,
			storageRoot,
		});
		const result = await runtime.planOnly(item.task, {
			revisionFeedback: feedback,
			previousPlan: item.plan,
		});
		savePreplannedTask(queueId, result.taskId, result.plan, (item.planRevisionCount ?? 0) + 1);
		promptQueuedPlanApproval(pi, ctx, queueId);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		markPlanningFailed(queueId, message);
		sendCard(pi, "Task planning failed", renderQueue(readQueue(), message));
	} finally {
		state.preplanning.delete(queueId);
		ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
	}
}

function promptQueuedPlanApproval(pi: ExtensionAPI, ctx: ExtensionContext, queueId: string): void {
	const item = readQueue().find((entry) => entry.id === queueId);
	if (!item?.plan) return;
	state.awaitingPlanApproval = true;
	state.planApprovalPath = `queue:${queueId}`;
	state.planApprovalQueueId = queueId;
	state.lastPlanApproval = {
		taskId: item.planTaskId ?? item.id,
		approvalPath: state.planApprovalPath,
		revisionCount: item.planRevisionCount,
		submittedTask: item.task,
		plan: item.plan,
	};
	sendCard(pi, "Confirm Task Manager plan", renderQueue(readQueue(), renderPlanApproval(state.lastPlanApproval)));
	ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
}

function promptNextPendingQueuedPlan(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (state.awaitingPlanApproval) return;
	const item = nextPendingQueuedPlan();
	if (!item) return;
	promptQueuedPlanApproval(pi, ctx, item.id);
}

function nextPendingQueuedPlan(): QueueItem | undefined {
	return readQueue().find((item) => item.status === "todo" && Boolean(item.plan) && item.planApprovalStatus === "pending");
}

function clearRuntimePlanApprovalState(): void {
	if (state.planApprovalPath?.startsWith("queue:")) return;
	state.awaitingPlanApproval = false;
	state.planApprovalPath = undefined;
	state.planApprovalQueueId = undefined;
}

async function runOrchestration(pi: ExtensionAPI, ctx: ExtensionContext, queueId: string): Promise<void> {
	const item = markTask(queueId, "inprogress");
	if (!item) return;

	state.running = true;
	state.lastDashboard = undefined;
	state.taskManagerStatus = "todo";
	state.currentRunTaskId = undefined;
	ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
	sendCard(pi, "Task Manager", renderQueue(readQueue(), `Starting ${item.id}\n\n${item.task}`));

	try {
		await ensureBuilt();
		const runtime = new RuntimeOrchestrator({
			orchestrationRoot,
			projectRoot,
			storageRoot,
		});
		const dashboard = new Dashboard(runtime.events());
		const stopDashboard = dashboard.start();

		runtime.events().subscribe("TaskAssigned", (event) => {
			if ((event.payload as { plan?: unknown }).plan) {
				state.taskManagerStatus = "complete";
				sendCard(pi, "Task Manager", renderQueue(readQueue(), "Analyzing repository...\nBreaking task into subtasks..."));
				ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
			}
		});
		runtime.events().subscribe("ClarificationRequired", (event) => {
			const payload = event.payload as ClarificationPayload;
			if (!payload.answerPath) return;
			state.awaitingClarification = true;
			state.clarificationPath = payload.answerPath;
			const lines = [
				"Task Manager needs clarification before planning.",
				"",
				...(payload.questions?.length ? payload.questions.map((question, index) => `${index + 1}. ${question}`) : ["1. Please clarify the task."]),
				"",
				"Use /herdr-answer <answer> to continue.",
			];
			sendCard(pi, "Clarification required", renderQueue(readQueue(), lines.join("\n")));
			ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
		});
		runtime.events().subscribe("PlanApprovalRequired", (event) => {
			const payload = event.payload as PlanApprovalPayload;
			if (!payload.approvalPath) return;
			state.awaitingPlanApproval = true;
			state.planApprovalPath = payload.approvalPath;
			state.planApprovalQueueId = undefined;
			state.lastPlanApproval = payload;
			sendCard(pi, "Confirm Task Manager plan", renderQueue(readQueue(), renderPlanApproval(payload)));
			ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
		});
		runtime.events().subscribe("GitPublishApprovalRequired", (event) => {
			const payload = event.payload as GitPublishApprovalPayload;
			if (!payload.approvalPath) return;
			state.awaitingGitPublishApproval = true;
			state.gitPublishApprovalPath = payload.approvalPath;
			sendCard(pi, "Confirm git publish", renderQueue(readQueue(), renderGitPublishApproval(payload)));
			ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
		});
		runtime.events().subscribe("ValidationPassed", (event) => {
			const payload = event.payload as { result?: { summary?: string } };
			sendCard(pi, "Validator", renderQueue(readQueue(), `Validation Passed\n\n${payload.result?.summary ?? "Validator accepted the work."}`));
			ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
		});
		runtime.events().subscribe("ValidationFailed", (event) => {
			const payload = event.payload as { result?: { summary?: string } };
			sendCard(pi, "Validator", renderQueue(readQueue(), `Validation Failed\n\n${payload.result?.summary ?? "Validator rejected the work."}`));
			ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
		});
		runtime.events().subscribe("WorkerStarted", (event) => {
			if (event.workerId === "task-manager") {
				state.taskManagerStatus = "inprogress";
				ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
			} else if (event.workerId === "validator") {
				sendCard(pi, "Validator", renderQueue(readQueue(), "Running validation..."));
				ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
			}
		});
		runtime.events().subscribe("WorkerFinished", (event) => {
			if (event.workerId === "task-manager") {
				state.taskManagerStatus = "complete";
				sendCard(pi, "Task Manager", renderQueue(readQueue(), "Task Manager finished planning and delegation."));
				ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
			}
		});
		runtime.events().subscribe("WorkerFailed", (event) => {
			if (event.workerId === "task-manager") {
				state.taskManagerStatus = "failed";
				sendCard(pi, "Task Manager", renderQueue(readQueue(), "Task Manager failed."));
				ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
			}
		});
		runtime.events().subscribe("ProgressUpdated", () => {
			state.lastDashboard = dashboard.render();
			ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
		});

		const summary = await runtime.run(item.task, item.plan, {
			skipPlanApproval: item.planApprovalStatus === "approved",
		});
		stopDashboard();
		state.running = false;
		state.awaitingApproval = summary.success && summary.approvalRequired;
		state.awaitingClarification = false;
		state.awaitingGitPublishApproval = false;
		state.clarificationPath = undefined;
		state.gitPublishApprovalPath = undefined;
		clearRuntimePlanApprovalState();
		state.taskManagerStatus = "complete";
		state.currentRunTaskId = summary.taskId;
		state.lastTaskId = summary.taskId;
		state.lastSummary = [
			summary.success ? "Validation Passed" : "Validation Failed",
			"",
			`Task ID: ${summary.taskId}`,
			`Executors: ${summary.plan.executorCount}`,
			`Validation: ${summary.validationSummary}`,
			summary.gitPublish ? `Git: ${summary.gitPublish.summary}` : undefined,
			summary.tribeManagerSync ? `Tribe Manager: ${summary.tribeManagerSync.completion}` : undefined,
			"",
			summary.success ? "Task marked complete in queue." : "Task marked failed in queue.",
			summary.success
				? gitPublishFailed(summary.gitPublish)
					? "Finished. Git publish had errors; check the Git note above."
					: "Finished. Changes were committed and pushed when git publishing was available."
				: summary.approvalRequired
					? "Use /herdr-approve or /herdr-reject for the latest failed task."
					: "Fix required before completion.",
		].filter((line): line is string => line !== undefined).join("\n");
		state.lastDashboard = dashboard.render();
		finishTask(queueId, summary.success ? "complete" : "failed", {
			success: summary.success,
			taskId: summary.taskId,
			summary: summary.validationSummary,
			gitPublish: summary.gitPublish,
			tribeManagerSync: summary.tribeManagerSync,
		});
		saveRunSafety(queueId, summary);
		const followUp = enqueueValidationFixTask(item, summary.success, summary.validationSummary);
		sendCard(pi, summary.success ? "Task completed" : "Task failed", renderQueue(readQueue(), state.lastSummary));
		if (followUp) {
			sendCard(pi, "Validation fix queued", renderQueue(readQueue(), `Queued ${followUp.id} to fix validator failure.`));
			void preplanQueuedTasks(pi, ctx);
		}
		promptNextPendingQueuedPlan(pi, ctx);
		ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
	} catch (error) {
		state.running = false;
		state.awaitingClarification = false;
		state.awaitingGitPublishApproval = false;
		state.clarificationPath = undefined;
		state.gitPublishApprovalPath = undefined;
		clearRuntimePlanApprovalState();
		state.taskManagerStatus = state.taskManagerStatus === "complete" ? "complete" : "failed";
		const message = error instanceof Error ? error.message : String(error);
		finishTask(queueId, "failed", {
			success: false,
			taskId: "not-created",
			summary: message,
		});
		sendCard(pi, "Task failed", renderQueue(readQueue(), `Task failed\n\n${message}`));
		promptNextPendingQueuedPlan(pi, ctx);
		ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
	}
}

async function ensureBuilt(): Promise<void> {
	await execFileAsync("npm", ["run", "build"], {
		cwd: orchestrationRoot,
		env: {
			...process.env,
			PI_ORCHESTRATION_ROOT: orchestrationRoot,
			PI_ORCHESTRATION_PROJECT_ROOT: projectRoot,
			PI_ORCHESTRATION_STORAGE_ROOT: storageRoot,
			PI_ORCHESTRATION_TRIBE_MANAGER_PATH: tribeManagerConfigPath,
		},
	});
}

function sendCard(pi: ExtensionAPI, title: string, body: string): void {
	pi.sendMessage({
		customType: "herdr-orchestration",
		content: `${title}\n\n${body}`,
		display: true,
		details: { title, at: Date.now() },
	});
}

async function queueTaskCommand(pi: ExtensionAPI, ctx: ExtensionContext, args: string, usage: string): Promise<void> {
	const task = args.trim();
	if (!task) {
		ctx.ui.notify(`Usage: ${usage}`, "warning");
		return;
	}
	const item = enqueueTask(task);
	sendCard(pi, "Task queued", renderQueue(readQueue(), `Queued ${item.id}`));
	ctx.ui.setStatus("herdr-orchestration", statusLine(ctx));
	void preplanQueuedTasks(pi, ctx);
	if (ctx.mode === "tui") {
		void processQueue(pi, ctx);
	} else {
		await processQueue(pi, ctx);
	}
}

function enqueueTask(task: string): QueueItem {
	const now = new Date().toISOString();
	const queue = readQueue();
	const item: QueueItem = {
		id: `queue-${Date.now().toString(36)}`,
		task,
		status: "todo",
		phase: "queued",
		createdAt: now,
		updatedAt: now,
	};
	queue.push(item);
	writeQueue(queue);
	return item;
}

function enqueueValidationFixTask(task: QueueItem, success: boolean, validationSummary: string): QueueItem | undefined {
	if (success) return undefined;
	if (!isAutoReworkFailure(validationSummary)) return undefined;
	if (task.task.startsWith("Fix validation failure for ")) return undefined;
	return enqueueTask([
		`Fix validation failure for ${task.id}: ${task.task}`,
		"",
		"Validator failure:",
		validationSummary
	].join("\n"));
}

function isAutoReworkFailure(summary: string): boolean {
	return /(^|\b)(git|commit|push|remote|mcp|tribe|tribe_manager)(\b|$)/i.test(summary);
}

function retryFailedTask(id: string): QueueItem | undefined {
	const now = new Date().toISOString();
	const queue = readQueue();
	const failed = queue.find((entry) => entry.id === id && entry.status === "failed");
	if (!failed) return undefined;

	const item: QueueItem = {
		id: `queue-${Date.now().toString(36)}`,
		task: `Rework failed task ${id}: ${failed.task}`,
		status: "todo",
		phase: "queued",
		createdAt: now,
		updatedAt: now,
		error: failed.result?.summary ? `Previous failure: ${failed.result.summary}` : failed.error,
	};
	queue.push(item);
	writeQueue(queue);
	return item;
}

function writePlanApproval(path: string, approved: boolean, reason?: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({ approved, reason, decidedAt: new Date().toISOString() }, null, 2), "utf8");
}

function writePlanRevision(path: string, revision: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({ revision, decidedAt: new Date().toISOString() }, null, 2), "utf8");
}

function writeClarificationAnswer(path: string, answer: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({ answer, answeredAt: new Date().toISOString() }, null, 2), "utf8");
}

function markTask(id: string, status: QueueStatus): QueueItem | undefined {
	const now = new Date().toISOString();
	const queue = readQueue();
	const item = queue.find((entry) => entry.id === id);
	if (!item) return undefined;
	item.status = status;
	item.phase = phaseForStatus(status, item);
	item.updatedAt = now;
	if (status === "inprogress") item.startedAt = now;
	writeQueue(queue);
	return item;
}

function markPlanningStarted(id: string): void {
	const queue = readQueue();
	const item = queue.find((entry) => entry.id === id);
	if (!item) return;
	item.planningStartedAt = new Date().toISOString();
	item.phase = "investigating";
	delete item.error;
	writeQueue(queue);
}

function savePreplannedTask(id: string, planTaskId: string, plan: TaskPlan, revisionCount = 0): void {
	const queue = readQueue();
	const item = queue.find((entry) => entry.id === id);
	if (!item) return;
	item.planTaskId = planTaskId;
	item.plan = plan;
	item.planApprovalStatus = "pending";
	item.phase = "awaiting_plan_approval";
	item.safetyAnalysis = plan.impactAnalysis;
	item.regressionMatrix = plan.regressionMatrix;
	item.approvedFileScope = plan.fileOwnership;
	item.riskApprovalStatus = isHighRiskPlan(plan) ? "pending" : "not_required";
	item.planRevisionCount = revisionCount;
	item.plannedAt = new Date().toISOString();
	item.updatedAt = item.plannedAt;
	writeQueue(queue);
}

function approveQueuedPlan(id: string): void {
	const queue = readQueue();
	const item = queue.find((entry) => entry.id === id);
	if (!item) return;
	item.planApprovalStatus = "approved";
	if (item.riskApprovalStatus === "pending" && !requiresRiskApproval(item)) item.riskApprovalStatus = "approved";
	item.updatedAt = new Date().toISOString();
	writeQueue(queue);
}

function rejectQueuedPlan(id: string, reason: string): void {
	const queue = readQueue();
	const item = queue.find((entry) => entry.id === id);
	if (!item) return;
	item.status = "failed";
	item.phase = "cancelled";
	item.planApprovalStatus = "rejected";
	item.error = reason;
	item.updatedAt = new Date().toISOString();
	writeQueue(queue);
}

function markPlanningFailed(id: string, error: string): void {
	const queue = readQueue();
	const item = queue.find((entry) => entry.id === id);
	if (!item) return;
	item.error = error;
	item.phase = "failed";
	item.updatedAt = new Date().toISOString();
	writeQueue(queue);
}

function finishTask(id: string, status: "complete" | "failed", result: QueueItem["result"]): void {
	const now = new Date().toISOString();
	const queue = readQueue();
	const item = queue.find((entry) => entry.id === id);
	if (!item) return;
	item.status = status;
	item.phase = status === "complete" ? "completed" : "failed";
	item.updatedAt = now;
	if (status === "complete") item.completedAt = now;
	item.result = result;
	item.error = status === "failed" ? result?.summary : undefined;
	writeQueue(queue);
}

function saveRunSafety(id: string, summary: RunSummary): void {
	const queue = readQueue();
	const item = queue.find((entry) => entry.id === id);
	if (!item) return;
	item.phase = summary.phase ?? item.phase;
	item.safetyAnalysis = summary.safetyAnalysis ?? item.safetyAnalysis;
	item.regressionMatrix = summary.regressionMatrix ?? item.regressionMatrix;
	item.baselineValidation = summary.baselineValidation ?? item.baselineValidation;
	item.finalValidation = summary.finalValidation ?? item.finalValidation;
	item.validatorDecision = summary.validatorDecision ?? item.validatorDecision;
	item.approvedFileScope = summary.approvedFileScope ?? item.approvedFileScope;
	item.actualChangedFiles = summary.actualChangedFiles ?? item.actualChangedFiles;
	item.publishApproval = summary.publishApproval ?? item.publishApproval;
	writeQueue(queue);
}

function migrateQueueItem(item: QueueItem): QueueItem {
	const phase = item.phase ?? phaseForStatus(item.status, item);
	const plan = item.plan;
	return {
		...item,
		phase,
		safetyAnalysis: item.safetyAnalysis ?? plan?.impactAnalysis,
		regressionMatrix: item.regressionMatrix ?? plan?.regressionMatrix,
		approvedFileScope: item.approvedFileScope ?? plan?.fileOwnership,
		riskApprovalStatus: item.riskApprovalStatus ?? (plan && isHighRiskPlan(plan) ? "pending" : "not_required"),
	};
}

function phaseForStatus(status: QueueStatus, item: QueueItem): TaskPhase {
	if (status === "complete") return "completed";
	if (status === "failed") return item.planApprovalStatus === "rejected" ? "cancelled" : "failed";
	if (status === "inprogress") {
		if (item.publishApproval === "pending") return "awaiting_publish_approval";
		return item.plan?.characterizationRequired ? "creating_baseline" : "implementing";
	}
	if (item.plan) return "awaiting_plan_approval";
	if (item.planningStartedAt) return "investigating";
	return "queued";
}

function readQueue(): QueueItem[] {
	ensureQueueFile();
	try {
		const parsed = JSON.parse(readFileSync(queuePath, "utf8")) as { tasks?: QueueItem[] };
		return Array.isArray(parsed.tasks) ? parsed.tasks.map(migrateQueueItem) : [];
	} catch {
		return [];
	}
}

function writeQueue(tasks: QueueItem[]): void {
	ensureQueueFile();
	writeFileSync(queuePath, JSON.stringify({ tasks }, null, 2), "utf8");
}

function ensureQueueFile(): void {
	mkdirSync(dirname(queuePath), { recursive: true });
	if (!existsSync(queuePath)) {
		writeFileSync(queuePath, JSON.stringify({ tasks: [] }, null, 2), "utf8");
	}
}

function renderQueue(tasks: QueueItem[], prefix?: string): string {
	const counts = countByStatus(tasks);
	const lines = [
		prefix,
		prefix ? "" : undefined,
		`Task Manager: ${state.taskManagerStatus ?? "todo"}`,
		state.currentRunTaskId ? `Current run: ${state.currentRunTaskId}` : undefined,
		`Queue file: ${queuePath}`,
		`Project root: ${projectRoot}`,
		`todo: ${counts.todo}  inprogress: ${counts.inprogress}  complete: ${counts.complete}  failed: ${counts.failed}`,
		nextQueueAction(tasks),
		"",
		...tasks.slice(-12).map((item) => {
			const result = item.result ? ` -> ${item.result.success ? "passed" : "failed"}` : "";
			const plan = item.plan ? ` plan:${item.planApprovalStatus ?? "ready"}` : item.planningStartedAt ? " plan:planning" : "";
			const phase = item.phase ? ` phase:${item.phase}` : "";
			const risk = item.plan?.riskLevel ? ` risk:${item.plan.riskLevel}` : "";
			const baseline = item.baselineValidation?.length ? ` baseline:${validationStatus(item.baselineValidation)}` : "";
			const validation = item.finalValidation?.length ? ` validation:${validationStatus(item.finalValidation)}` : item.validatorDecision ? ` validator:${item.validatorDecision.decision}` : "";
			const publish = item.publishApproval ? ` publish:${item.publishApproval}` : "";
			const tribe = item.result?.tribeManagerSync ? ` tribe:${item.result.tribeManagerSync.taskId ?? "sync-status"}` : "";
			return `[${item.status}] ${item.id}${phase}${risk}${plan}${baseline}${validation}${publish}${tribe} ${ellipsis(item.task, 120)}${result}`;
		}),
	].filter((line): line is string => line !== undefined);

	return lines.join("\n");
}

function nextQueueAction(tasks: QueueItem[]): string | undefined {
	const pendingPlan = tasks.find((item) => item.status === "todo" && item.plan && item.planApprovalStatus === "pending");
	if (pendingPlan) return `Next: /herdr-confirm to approve ${pendingPlan.id}, or /herdr-revise-plan <feedback>.`;
	const approved = tasks.find((item) => item.status === "todo" && item.planApprovalStatus === "approved");
	if (approved) return `Next: /herdr-run-todo to start approved task ${approved.id}.`;
	return undefined;
}

function renderPlanApproval(payload: PlanApprovalPayload): string {
	const plan = payload.plan;
	const subtasks = plan?.subtasks ?? [];
	const technologies = formatTechnology(plan?.detectedTechnology);
	const criteria = plan?.acceptanceCriteria ?? [];
	const shownSubtasks = subtasks.slice(0, 3);
	const hiddenSubtasks = subtasks.length - shownSubtasks.length;
	const shownCriteria = criteria.slice(0, 3);
	const hiddenCriteria = criteria.length - shownCriteria.length;

	return [
		"Task Manager plan is ready.",
		payload.revisionCount ? `Revision: ${payload.revisionCount}` : "",
		"",
		`Task: ${compactTaskText(payload.submittedTask ?? plan?.request ?? "Unknown request")}`,
		"",
		"Planned changes:",
		...(shownSubtasks.length
			? shownSubtasks.map((task) => {
					const role = task.roleHint ? ` (${task.roleHint})` : "";
					return `- ${task.id}: ${task.title}${role}`;
				})
			: ["- No subtasks were produced by Task Manager."]),
		hiddenSubtasks > 0 ? `- ...and ${hiddenSubtasks} more` : "",
		"",
		`Executors: ${plan?.executorCount ?? "unknown"} | Stack: ${compactTaskText(technologies)}`,
		"",
		"Validation will check:",
		...(shownCriteria.length ? shownCriteria.map((item) => `- ${compactTaskText(item)}`) : ["- Validator will run available checks."]),
		hiddenCriteria > 0 ? `- ...and ${hiddenCriteria} more` : "",
		"",
		"Use /herdr-confirm to launch workers.",
		"Use /herdr-plan-detail to show full plan.",
		"Use /herdr-revise-plan <feedback> to request changes.",
		"Use /herdr-reject-plan [reason] to stop before execution.",
	].filter(Boolean).join("\n");
}

function renderPlanDetail(payload: PlanApprovalPayload): string {
	const plan = payload.plan;
	const subtasks = plan?.subtasks ?? [];
	const criteria = plan?.acceptanceCriteria ?? [];
	return [
		"Task Manager plan detail",
		payload.revisionCount ? `Revision: ${payload.revisionCount}` : "",
		"",
		"Task:",
		payload.submittedTask ?? plan?.request ?? "Unknown request",
		"",
		`Task ID: ${payload.taskId ?? "unknown"}`,
		`Executors: ${plan?.executorCount ?? "unknown"}`,
		`Detected stack: ${formatTechnology(plan?.detectedTechnology)}`,
		"",
		"Subtasks:",
		...(subtasks.length
			? subtasks.map((task) => {
					const files = task.filesHint?.length ? `\n  Files: ${task.filesHint.join(", ")}` : "";
					const depends = task.dependsOn?.length ? `\n  Depends on: ${task.dependsOn.join(", ")}` : "";
					return `- ${task.id}: ${task.title}${task.roleHint ? ` (${task.roleHint})` : ""}\n  ${task.description}${depends}${files}`;
				})
			: ["- No subtasks were produced by Task Manager."]),
		"",
		"Acceptance criteria:",
		...(criteria.length ? criteria.map((item) => `- ${item}`) : ["- Validator will run available checks."]),
		"",
		payload.plan ? renderImpact({ id: payload.taskId ?? "plan", task: payload.submittedTask ?? payload.plan.request ?? "", status: "todo", createdAt: "", updatedAt: "", plan: payload.plan }) : "",
		"",
		payload.plan ? renderRegressionMatrix({ id: payload.taskId ?? "plan", task: payload.submittedTask ?? payload.plan.request ?? "", status: "todo", createdAt: "", updatedAt: "", plan: payload.plan }) : "",
		"",
		"Use /herdr-confirm, /herdr-revise-plan <feedback>, or /herdr-reject-plan [reason].",
	].filter(Boolean).join("\n");
}

function renderRiskApproval(item: QueueItem): string {
	return [
		`Task: ${item.id}`,
		`Risk: ${item.plan?.riskLevel ?? "unknown"}`,
		"",
		"Approval reasons:",
		...(item.plan?.approvalReasons?.length ? item.plan.approvalReasons.map((reason) => `- ${reason}`) : ["- High-risk plan requires explicit approval."]),
		"",
		"Use /herdr-approve-risk to approve these high-risk aspects, then /herdr-confirm to approve the plan."
	].join("\n");
}

function renderImpact(item: QueueItem): string {
	const impact = item.safetyAnalysis ?? item.plan?.impactAnalysis;
	if (!impact) return "No impact analysis is available.";
	return [
		`Task: ${item.id}`,
		`Risk: ${impact.riskLevel}`,
		"",
		"Current behavior:",
		...listLines(impact.currentBehavior),
		"",
		"Requested behavior:",
		...listLines(impact.requestedBehavior),
		"",
		"Regression risks:",
		...(impact.regressionRisks.length ? impact.regressionRisks.map((risk) => `- ${risk.area}: ${risk.scenario} (${risk.riskLevel})`) : ["- None listed."]),
		"",
		"Approval reasons:",
		...listLines(impact.approvalReasons)
	].join("\n");
}

function renderRegressionMatrix(item: QueueItem): string {
	const matrix = item.regressionMatrix ?? item.plan?.regressionMatrix ?? [];
	if (!matrix.length) return "No regression matrix is available.";
	return [
		`Task: ${item.id}`,
		"",
		...matrix.map((entry) => [
			`- ${entry.id}: ${entry.area}`,
			`  Scenario: ${entry.scenario}`,
			`  Existing: ${entry.existingBehavior}`,
			`  Expected: ${entry.expectedBehaviorAfterChange}`,
			`  Risk/test/status: ${entry.riskLevel}/${entry.requiredTestType}/${entry.validationStatus}${entry.coveredByTest ? ` (${entry.coveredByTest})` : ""}`
		].join("\n"))
	].join("\n");
}

function renderValidation(item: QueueItem): string {
	return [
		`Task: ${item.id}`,
		`Phase: ${item.phase ?? "unknown"}`,
		item.validatorDecision ? `Validator: ${item.validatorDecision.decision} (${item.validatorDecision.validationStatus})` : "Validator: not available",
		"",
		"Baseline:",
		...validationLines(item.baselineValidation),
		"",
		"Final:",
		...validationLines(item.finalValidation)
	].join("\n");
}

function renderGitPublishApproval(payload: GitPublishApprovalPayload): string {
	const repositories = payload.preview?.repositories?.filter((repo) => repo.changed) ?? [];
	const shownRepositories = repositories.slice(0, 5);
	const hiddenRepositories = repositories.length - shownRepositories.length;
	return [
		"Validation passed. Confirm git commit and push.",
		"",
		`Task ID: ${payload.taskId ?? "unknown"}`,
		payload.preview?.summary ?? "Changed repositories detected.",
		"",
		"Repositories to publish:",
		...(shownRepositories.length
			? shownRepositories.map((repo) => `- ${repo.path} (${repo.remotes.length ? repo.remotes.join(", ") : "no remotes"})`)
			: ["- No changed repositories listed."]),
		hiddenRepositories > 0 ? `- ...and ${hiddenRepositories} more` : "",
		"",
		"Use /herdr-approve to commit and push.",
		"Use /herdr-reject [reason] to skip commit and push.",
	].filter(Boolean).join("\n");
}

function gitPublishFailed(gitPublish: RunSummary["gitPublish"] | undefined): boolean {
	return Boolean(gitPublish?.attempted && (!gitPublish.committed || !gitPublish.pushed));
}

function compactTaskText(text: string): string {
	const withoutClarification = text.split(/\n\s*User clarification:\s*\n/i)[0] ?? text;
	const singleLine = withoutClarification.replace(/\s+/g, " ").trim();
	if (singleLine.length <= 280) return singleLine;
	return `${singleLine.slice(0, 277).trimEnd()}...`;
}

function formatTechnology(value: unknown): string {
	if (Array.isArray(value)) {
		const items = value.map((item) => String(item).trim()).filter(Boolean);
		return items.length ? items.join(", ") : "Unknown";
	}
	if (typeof value === "string") return value.trim() || "Unknown";
	return "Unknown";
}

function ellipsis(text: string, maxLength: number): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	if (singleLine.length <= maxLength) return singleLine;
	return `${singleLine.slice(0, maxLength - 3).trimEnd()}...`;
}

function countByStatus(tasks: QueueItem[]): Record<QueueStatus, number> {
	return {
		todo: tasks.filter((item) => item.status === "todo").length,
		inprogress: tasks.filter((item) => item.status === "inprogress").length,
		complete: tasks.filter((item) => item.status === "complete").length,
		failed: tasks.filter((item) => item.status === "failed").length,
	};
}

function currentDetailedTask(): QueueItem | undefined {
	const queue = readQueue();
	return queue.find((item) => item.id === state.planApprovalQueueId)
		?? queue.find((item) => item.status === "inprogress")
		?? queue.find((item) => item.status === "todo" && item.plan)
		?? queue.at(-1);
}

function isHighRiskPlan(plan: TaskPlan): boolean {
	return plan.riskLevel === "high" || plan.riskLevel === "critical" || Boolean(plan.approvalRequired && plan.approvalReasons?.length);
}

function requiresRiskApproval(item: QueueItem): boolean {
	return Boolean(item.plan && isHighRiskPlan(item.plan) && item.riskApprovalStatus !== "approved");
}

function markRiskApprovalPending(id: string): void {
	const queue = readQueue();
	const item = queue.find((entry) => entry.id === id);
	if (!item) return;
	item.riskApprovalStatus = "pending";
	item.updatedAt = new Date().toISOString();
	writeQueue(queue);
}

function approveRisk(id: string): void {
	const queue = readQueue();
	const item = queue.find((entry) => entry.id === id);
	if (!item) return;
	item.riskApprovalStatus = "approved";
	item.updatedAt = new Date().toISOString();
	writeQueue(queue);
}

function validationStatus(records: ValidationRecord[]): string {
	if (records.some((record) => record.status === "failed" || record.status === "blocked")) return "failed";
	if (records.some((record) => record.status === "running")) return "running";
	if (records.some((record) => record.required && record.status === "skipped")) return "partial";
	if (records.length && records.every((record) => record.status === "passed" || record.status === "skipped")) return "passed";
	return "pending";
}

function validationLines(records: ValidationRecord[] | undefined): string[] {
	if (!records?.length) return ["- Not available."];
	return records.map((record) => `- ${record.category}: ${record.command} -> ${record.status}${record.outputSummary ? ` (${record.outputSummary})` : ""}${record.skipReason ? ` skip:${record.skipReason}` : ""}`);
}

function listLines(items: string[] | undefined): string[] {
	return items?.length ? items.map((item) => `- ${item}`) : ["- Not listed."];
}

function statusLine(ctx: ExtensionContext): string {
	const queue = readQueue();
	const counts = countByStatus(queue);
	const manager = state.taskManagerStatus ? ` tm:${state.taskManagerStatus}` : "";
	const clarification = state.awaitingClarification ? " clarify:waiting" : "";
	const plan = state.awaitingPlanApproval || queue.some((item) => item.status === "todo" && item.plan && item.planApprovalStatus === "pending") ? " plan:waiting" : "";
	const risk = queue.some((item) => item.status === "todo" && requiresRiskApproval(item)) ? " risk:waiting" : "";
	const git = state.awaitingGitPublishApproval ? " git:waiting" : "";
	const phase = queue.find((item) => item.status === "inprogress")?.phase;
	const text = `HerdR todo:${counts.todo} inprogress:${counts.inprogress} complete:${counts.complete} failed:${counts.failed}${phase ? ` phase:${phase}` : ""}${clarification}${plan}${risk}${git}${manager}`;
	if (state.awaitingClarification) return ctx.ui.theme.fg("warning", text);
	if (state.awaitingPlanApproval) return ctx.ui.theme.fg("warning", text);
	if (risk) return ctx.ui.theme.fg("warning", text);
	if (state.awaitingGitPublishApproval) return ctx.ui.theme.fg("warning", text);
	if (counts.inprogress > 0) return ctx.ui.theme.fg("accent", text);
	if (counts.todo > 0) return ctx.ui.theme.fg("warning", text);
	return ctx.ui.theme.fg("dim", text);
}
