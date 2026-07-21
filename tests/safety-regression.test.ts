import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ConfigLoader } from "../packages/config/src/ConfigLoader";

test("shared task model keeps queue status compatible while adding safety phases", async () => {
  const source = await readFile("packages/shared/src/types.ts", "utf8");

  assert.match(source, /export type TaskPhase =/);
  assert.match(source, /"awaiting_plan_approval"/);
  assert.match(source, /"creating_baseline"/);
  assert.match(source, /"awaiting_publish_approval"/);
  assert.match(source, /export interface TaskSafetyAnalysis/);
  assert.match(source, /export interface RegressionMatrixEntry/);
  assert.match(source, /export interface ValidationRecord/);
  assert.match(source, /export interface ValidatorResult/);
  assert.match(source, /approvedFileScope/);
  assert.match(source, /publishApproval/);
});

test("safety configuration has safe defaults and reads YAML switches", async () => {
  const config = await new ConfigLoader("config/roles.test.yaml", "config/providers.yaml").load();

  assert.equal(config.safety.requireImpactAnalysis, true);
  assert.equal(config.safety.requireRegressionMatrix, true);
  assert.equal(config.safety.highRisk.requireExplicitApproval, true);
  assert.equal(config.validation.maximumRepairAttempts, 2);
  assert.equal(config.git.publishMode, "manual_approval");
});

test("Task Manager prompt and parser require impact analysis and concrete regression matrix", async () => {
  const source = await readFile("packages/task-manager/src/TaskManagerWorker.ts", "utf8");

  assert.match(source, /Trace the complete current behavior/);
  assert.match(source, /Search for callers of shared code/);
  assert.match(source, /Produce a repository-specific regression matrix/);
  assert.match(source, /Task Manager plan missing impactAnalysis/);
  assert.match(source, /Task Manager plan missing regressionMatrix/);
  assert.match(source, /contains generic entries/);
  assert.match(source, /simulatedProviderPlan/);
});

test("runtime gates implementation with baseline, scope checks, independent validation, and publish approval", async () => {
  const source = await readFile("packages/runtime/src/TaskManagerRuntime.ts", "utf8");

  assert.match(source, /runBaselineIfRequired/);
  assert.match(source, /task\.baseline\.started/);
  assert.match(source, /production files changed/);
  assert.match(source, /assignSubtasksByScope/);
  assert.match(source, /scopesOverlap/);
  assert.match(source, /executor\.scope_violation/);
  assert.match(source, /validator\.finding\.created/);
  assert.match(source, /waitForGitPublishApproval/);
  assert.match(source, /task\.publish_approval\.requested/);
  assert.match(source, /git\.publish\.started/);
});

test("executor and validator prompts enforce minimal diff and structured validation", async () => {
  const executor = await readFile("packages/workers/src/ExecutorWorker.ts", "utf8");
  const validator = await readFile("packages/validator/src/ValidatorWorker.ts", "utf8");

  assert.match(executor, /Make the smallest possible change/);
  assert.match(executor, /Do not modify files outside the assigned scope/);
  assert.match(executor, /characterization-test Executor/);
  assert.match(executor, /Do not modify production behavior/);
  assert.match(executor, /search for callers/);
  assert.match(validator, /Do not trust Executor summaries/);
  assert.match(validator, /Inspect the actual Git diff/);
  assert.match(validator, /HERDR_VALIDATOR_JSON/);
  assert.match(validator, /Critical and high findings block approval/);
});

test("Pi renders phase, risk, validation, impact, regression, and risk approval commands", async () => {
  const source = await readFile("packages/pi-extension/herdr-orchestration.ts", "utf8");

  assert.match(source, /phase:/);
  assert.match(source, /risk:/);
  assert.match(source, /herdr-impact/);
  assert.match(source, /herdr-regression-matrix/);
  assert.match(source, /herdr-validation/);
  assert.match(source, /herdr-approve-risk/);
  assert.match(source, /requiresRiskApproval/);
  assert.match(source, /migrateQueueItem/);
});
