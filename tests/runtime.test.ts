import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeOrchestrator } from "../packages/runtime/src/RuntimeOrchestrator";

test("runs a provider-agnostic multi-worker task", async () => {
  const previousRolesPath = process.env.PI_ORCHESTRATION_ROLES_PATH;
  const previousAutoApprovePlan = process.env.PI_ORCHESTRATION_AUTO_APPROVE_PLAN;
  process.env.PI_ORCHESTRATION_ROLES_PATH = join(process.cwd(), "config", "roles.test.yaml");
  process.env.PI_ORCHESTRATION_AUTO_APPROVE_PLAN = "true";
  let summary;
  try {
    const projectRoot = await mkdtemp(join(tmpdir(), "herdr-runtime-project-"));
    const storageRoot = await mkdtemp(join(tmpdir(), "herdr-runtime-storage-"));
    const runtime = new RuntimeOrchestrator({
      orchestrationRoot: process.cwd(),
      projectRoot,
      storageRoot
    });
    summary = await runtime.run("Build JWT authentication with refresh token support.");
  } finally {
    if (previousRolesPath === undefined) {
      delete process.env.PI_ORCHESTRATION_ROLES_PATH;
    } else {
      process.env.PI_ORCHESTRATION_ROLES_PATH = previousRolesPath;
    }
    if (previousAutoApprovePlan === undefined) {
      delete process.env.PI_ORCHESTRATION_AUTO_APPROVE_PLAN;
    } else {
      process.env.PI_ORCHESTRATION_AUTO_APPROVE_PLAN = previousAutoApprovePlan;
    }
  }

  assert.equal(summary.success, true);
  assert.equal(summary.approvalRequired, false);
  assert.ok(summary.plan.subtasks.length >= 4);
  assert.ok(summary.workers.some((worker) => worker.id === "validator"));
});

test("runtime does not validate when executors fail", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile("packages/runtime/src/TaskManagerRuntime.ts", "utf8"));

  assert.match(source, /executorFailure\(executorResults\)/);
  assert.match(source, /Executor failed before validation/);
  assert.match(source, /: await this\.validateWithRepair/);
});

test("orchestrator returns a failed summary when the child process exits unexpectedly", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile("packages/runtime/src/RuntimeOrchestrator.ts", "utf8"));

  assert.match(source, /crashedRunSummary\(taskId, request, preplannedPlan\)/);
  assert.match(source, /Orchestration process exited unexpectedly before writing summary/);
  assert.doesNotMatch(source, /Task Manager exited with \$\{childExitCode/);
});
