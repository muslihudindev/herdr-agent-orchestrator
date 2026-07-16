import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const piExtensionPath = "packages/pi-extension/herdr-orchestration.ts";

test("Pi runtime does not instantiate backend role workers directly", async () => {
  const source = await readFile("packages/runtime/src/RuntimeOrchestrator.ts", "utf8");

  assert.equal(source.includes("TaskManagerWorker"), false);
  assert.equal(source.includes("ExecutorWorker"), false);
  assert.equal(source.includes("ValidatorWorker"), false);
  assert.equal(source.includes("ProviderRegistry"), false);
});

test("Pi queued preplanned approval starts only approved tasks", async () => {
  const source = await readFile(piExtensionPath, "utf8");

  assert.match(source, /item\.status === "todo" && item\.planApprovalStatus === "approved"/);
  assert.match(source, /if \(queuePlanId\) \{\s+if \(ctx\.mode === "tui"\) \{\s+void processQueue\(pi, ctx\);/s);
});

test("Pi preserves queued plan confirmation while active task finishes", async () => {
  const source = await readFile(piExtensionPath, "utf8");

  assert.match(source, /function clearRuntimePlanApprovalState\(\)/);
  assert.match(source, /state\.planApprovalPath\?\.startsWith\("queue:"\)/);
  assert.match(source, /const pendingPlan = nextPendingQueuedPlan\(\)/);
  assert.match(source, /Recovered pending queued plan approval/);
});

test("Pi plan confirmation uses compact submitted task text", async () => {
	const source = await readFile(piExtensionPath, "utf8");

	assert.match(source, /submittedTask: item\.task/);
	assert.match(source, /compactTaskText\(payload\.submittedTask \?\? plan\?\.request/);
	assert.match(source, /function formatTechnology\(value: unknown\)/);
	assert.match(source, /subtasks\.slice\(0, 3\)/);
	assert.match(source, /criteria\.slice\(0, 3\)/);
	assert.match(source, /herdr-plan-detail/);
  assert.match(source, /function renderPlanDetail/);
  assert.match(source, /User clarification/);
});

test("Runtime auto publishes git changes after validation passes", async () => {
  const source = await readFile("packages/runtime/src/TaskManagerRuntime.ts", "utf8");

  assert.match(source, /publishTaskChanges\(this\.projectRoot, taskId, request, \{/);
  assert.match(source, /commitMessageProvider: this\.providerRegistry\.get\(roles\.providerFor\("validator"\)\)/);
  assert.match(source, /gitPublish\.committed && gitPublish\.pushed/);
  assert.doesNotMatch(source, /waitForGitPublishApproval/);
  assert.doesNotMatch(source, /GitPublishApprovalRequired/);
});

test("Pi passes explicit tribe manager config path to runtime", async () => {
  const source = await readFile(piExtensionPath, "utf8");

  assert.match(source, /tribeManagerConfigPath/);
  assert.match(source, /PI_ORCHESTRATION_TRIBE_MANAGER_PATH/);
});

test("Pi has a manual command to resume stuck todo tasks", async () => {
  const source = await readFile(piExtensionPath, "utf8");

  assert.match(source, /herdr-run-todo/);
  assert.match(source, /Starting approved todo task/);
  assert.match(source, /promptQueuedPlanApproval\(pi, ctx, pending\.id\)/);
  assert.match(source, /preplanQueuedTasks\(pi, ctx\)/);
});

test("Pi can requeue failed tasks for rework", async () => {
  const source = await readFile(piExtensionPath, "utf8");

  assert.match(source, /herdr-retry-failed/);
  assert.match(source, /function retryFailedTask/);
  assert.match(source, /status: "todo"/);
  assert.match(source, /Rework failed task/);
});

test("Pi auto-reworks only git or mcp related failures", async () => {
  const source = await readFile(piExtensionPath, "utf8");

  assert.match(source, /enqueueValidationFixTask/);
  assert.match(source, /Fix validation failure for/);
  assert.match(source, /Validator failure:/);
  assert.match(source, /isAutoReworkFailure/);
  assert.match(source, /git\|commit\|push\|remote\|mcp\|tribe\|tribe_manager/);
  assert.doesNotMatch(source, /validation\|validator\|acceptance\|not accepted\|checks/);
});

test("Pi displays validator progress and result cards", async () => {
  const source = await readFile(piExtensionPath, "utf8");

  assert.match(source, /ValidationPassed/);
  assert.match(source, /ValidationFailed/);
  assert.match(source, /Running validation/);
});

test("Pi normal conversation is not automatically queued as a task", async () => {
  const source = await readFile(piExtensionPath, "utf8");

  assert.match(source, /pi\.on\("input"/);
  assert.match(source, /return \{ action: "continue" \}/);
  assert.match(source, /herdr-add-task/);
  assert.match(source, /queueTaskCommand\(pi, ctx, args, "\/herdr-add-task <task>"\)/);
});

test("Pi queue rows are single-line ellipsized", async () => {
  const source = await readFile(piExtensionPath, "utf8");

  assert.match(source, /ellipsis\(item\.task, 120\)/);
  assert.match(source, /text\.replace\(\/\\s\+\/g, " "\)/);
});

test("Pi surfaces pending queued plan as the next action", async () => {
  const source = await readFile(piExtensionPath, "utf8");

  assert.match(source, /function nextQueueAction/);
  assert.match(source, /Next: \/herdr-confirm to approve/);
  assert.match(source, /plan:waiting/);
});
