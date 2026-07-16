#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { EventBus } from "../../../packages/event-bus/src/EventBus";
import { TaskManagerRuntime } from "../../../packages/runtime/src/TaskManagerRuntime";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--agent") {
    await runInternalAgent(args.slice(1));
    return;
  }

  console.error("This is an internal HerdR orchestration runner, not the Pi TUI.");
  console.error("Run the real Pi Coding Agent from your project after installing the HerdR orchestration extension.");
  console.error("Example: herdr, then pi --approve");
  process.exitCode = 1;
}

async function runInternalAgent(args: string[]): Promise<void> {
  const role = args[0];
  if (role !== "task-manager") {
    throw new Error(`Unknown Pi internal agent role: ${role}`);
  }

  const values = parseFlagArgs(args.slice(1));
  const taskId = required(values, "--task-id");
  const mode = values.get("--mode") ?? "execute";
  const requestPath = required(values, "--request");
  const eventsPath = required(values, "--events");
  const summaryPath = required(values, "--summary");
  const clarificationPath = required(values, "--clarification");
  const planApprovalPath = required(values, "--plan-approval");
  const gitPublishApprovalPath = required(values, "--git-publish-approval");
  const preplannedPlanPath = values.get("--preplanned-plan");
  const skipPlanApproval = values.get("--skip-plan-approval") === "true";
  const revisionPath = values.get("--revision");
  const previousPlanPath = values.get("--previous-plan");
  const orchestrationRoot = values.get("--orchestration-root") ?? process.env.PI_ORCHESTRATION_ROOT ?? process.cwd();
  const projectRoot = values.get("--project-root") ?? process.env.PI_ORCHESTRATION_PROJECT_ROOT ?? process.cwd();
  const storageRoot = values.get("--storage-root") ?? process.env.PI_ORCHESTRATION_STORAGE_ROOT ?? process.cwd();
  const request = await readFile(requestPath, "utf8");
  const eventBus = new EventBus();

  await mkdir(dirname(eventsPath), { recursive: true });
  eventBus.subscribe("*", (event) => {
    appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);
  });

  const runtime = new TaskManagerRuntime(eventBus, {
    orchestrationRoot,
    projectRoot,
    storageRoot,
    clarificationPath,
    planApprovalPath,
    gitPublishApprovalPath,
    preplannedPlanPath,
    skipPlanApproval
  });
  if (mode === "plan-only") {
    const revision = revisionPath ? await readFile(revisionPath, "utf8") : undefined;
    const previousPlan = previousPlanPath ? JSON.parse(await readFile(previousPlanPath, "utf8")) : undefined;
    const plan = await runtime.planOnly(taskId, request, revision, previousPlan);
    await writeFile(summaryPath, JSON.stringify({ taskId, plan }, null, 2), "utf8");
    return;
  }
  const summary = await runtime.execute(taskId, request);
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
}

function parseFlagArgs(args: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    values.set(args[index], args[index + 1]);
  }
  return values;
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) throw new Error(`Missing required internal Pi agent flag: ${key}`);
  return value;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
