import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Task Manager prompt delegates tests instead of running them", async () => {
  const source = await readFile("packages/task-manager/src/TaskManagerWorker.ts", "utf8");

  assert.match(source, /Do not run tests, lint, build, or validation commands/);
  assert.match(source, /You may inspect and read repository files/);
  assert.match(source, /Choose the best concrete tasks for executors after reading the code/);
  assert.match(source, /Do not spawn agents, subagents, background agents, workers, or executors/);
  assert.match(source, /HerdR is the only system allowed to create executors/);
  assert.match(source, /test-writing subtask/);
  assert.doesNotMatch(source, /Run the project's configured tests/);
});

test("Task Manager records approved non-git tasks as in progress in Tribe Manager before execution", async () => {
  const source = await readFile("packages/task-manager/src/TaskManagerWorker.ts", "utf8");
  const runtime = await readFile("packages/runtime/src/TaskManagerRuntime.ts", "utf8");

  assert.match(source, /approved and is now in progress/);
  assert.match(source, /"in-progress"/);
  assert.match(source, /Create or update a Tribe task with status/);
  assert.match(source, /Do not call tribe_manager\.list_tasks/);
  assert.doesNotMatch(source, /phase === "new"\s+phase === "approved"/);
  assert.match(runtime, /providerForTribeSync/);
  assert.match(runtime, /"claude-code"/);
});

test("Tribe Manager completion updates stored task id instead of creating a duplicate", async () => {
  const source = await readFile("packages/task-manager/src/TaskManagerWorker.ts", "utf8");
  const runtime = await readFile("packages/runtime/src/TaskManagerRuntime.ts", "utf8");

  assert.match(runtime, /writeStoredTribeTaskId/);
  assert.match(runtime, /readStoredTribeTaskId/);
  assert.match(source, /completion sync skipped: no captured Tribe task id/);
  assert.match(source, /Update Tribe task_id/);
  assert.doesNotMatch(source, /record the final outcome/);
});

test("Task Manager can revise plans from user feedback", async () => {
  const source = await readFile("packages/task-manager/src/TaskManagerWorker.ts", "utf8");

  assert.match(source, /Plan revision requested by user/);
  assert.match(source, /Revise the plan to address the feedback/);
});

test("Validator owns final verification", async () => {
  const source = await readFile("packages/validator/src/ValidatorWorker.ts", "utf8");

  assert.match(source, /You own final verification/);
  assert.match(source, /Run the project's configured tests, lint, and build commands when available/);
  assert.match(source, /do not regress or unintentionally change behavior for other user roles/);
  assert.match(source, /not accepted/);
  assert.match(source, /Validator rejected work/);
  assert.match(source, /summarizeValidatorRejection/);
});
