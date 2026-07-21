"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const promises_1 = require("node:fs/promises");
const ConfigLoader_1 = require("../packages/config/src/ConfigLoader");
(0, node_test_1.default)("shared task model keeps queue status compatible while adding safety phases", async () => {
    const source = await (0, promises_1.readFile)("packages/shared/src/types.ts", "utf8");
    strict_1.default.match(source, /export type TaskPhase =/);
    strict_1.default.match(source, /"awaiting_plan_approval"/);
    strict_1.default.match(source, /"creating_baseline"/);
    strict_1.default.match(source, /"awaiting_publish_approval"/);
    strict_1.default.match(source, /export interface TaskSafetyAnalysis/);
    strict_1.default.match(source, /export interface RegressionMatrixEntry/);
    strict_1.default.match(source, /export interface ValidationRecord/);
    strict_1.default.match(source, /export interface ValidatorResult/);
    strict_1.default.match(source, /approvedFileScope/);
    strict_1.default.match(source, /publishApproval/);
});
(0, node_test_1.default)("safety configuration has safe defaults and reads YAML switches", async () => {
    const config = await new ConfigLoader_1.ConfigLoader("config/roles.test.yaml", "config/providers.yaml").load();
    strict_1.default.equal(config.safety.requireImpactAnalysis, true);
    strict_1.default.equal(config.safety.requireRegressionMatrix, true);
    strict_1.default.equal(config.safety.highRisk.requireExplicitApproval, true);
    strict_1.default.equal(config.validation.maximumRepairAttempts, 2);
    strict_1.default.equal(config.git.publishMode, "manual_approval");
});
(0, node_test_1.default)("Task Manager prompt and parser require impact analysis and concrete regression matrix", async () => {
    const source = await (0, promises_1.readFile)("packages/task-manager/src/TaskManagerWorker.ts", "utf8");
    strict_1.default.match(source, /Trace the complete current behavior/);
    strict_1.default.match(source, /Search for callers of shared code/);
    strict_1.default.match(source, /Produce a repository-specific regression matrix/);
    strict_1.default.match(source, /Task Manager plan missing impactAnalysis/);
    strict_1.default.match(source, /Task Manager plan missing regressionMatrix/);
    strict_1.default.match(source, /contains generic entries/);
    strict_1.default.match(source, /simulatedProviderPlan/);
});
(0, node_test_1.default)("runtime gates implementation with baseline, scope checks, independent validation, and publish approval", async () => {
    const source = await (0, promises_1.readFile)("packages/runtime/src/TaskManagerRuntime.ts", "utf8");
    strict_1.default.match(source, /runBaselineIfRequired/);
    strict_1.default.match(source, /task\.baseline\.started/);
    strict_1.default.match(source, /production files changed/);
    strict_1.default.match(source, /assignSubtasksByScope/);
    strict_1.default.match(source, /scopesOverlap/);
    strict_1.default.match(source, /executor\.scope_violation/);
    strict_1.default.match(source, /validator\.finding\.created/);
    strict_1.default.match(source, /waitForGitPublishApproval/);
    strict_1.default.match(source, /task\.publish_approval\.requested/);
    strict_1.default.match(source, /git\.publish\.started/);
});
(0, node_test_1.default)("executor and validator prompts enforce minimal diff and structured validation", async () => {
    const executor = await (0, promises_1.readFile)("packages/workers/src/ExecutorWorker.ts", "utf8");
    const validator = await (0, promises_1.readFile)("packages/validator/src/ValidatorWorker.ts", "utf8");
    strict_1.default.match(executor, /Make the smallest possible change/);
    strict_1.default.match(executor, /Do not modify files outside the assigned scope/);
    strict_1.default.match(executor, /characterization-test Executor/);
    strict_1.default.match(executor, /Do not modify production behavior/);
    strict_1.default.match(executor, /search for callers/);
    strict_1.default.match(validator, /Do not trust Executor summaries/);
    strict_1.default.match(validator, /Inspect the actual Git diff/);
    strict_1.default.match(validator, /HERDR_VALIDATOR_JSON/);
    strict_1.default.match(validator, /Critical and high findings block approval/);
});
(0, node_test_1.default)("Pi renders phase, risk, validation, impact, regression, and risk approval commands", async () => {
    const source = await (0, promises_1.readFile)("packages/pi-extension/herdr-orchestration.ts", "utf8");
    strict_1.default.match(source, /phase:/);
    strict_1.default.match(source, /risk:/);
    strict_1.default.match(source, /herdr-impact/);
    strict_1.default.match(source, /herdr-regression-matrix/);
    strict_1.default.match(source, /herdr-validation/);
    strict_1.default.match(source, /herdr-approve-risk/);
    strict_1.default.match(source, /requiresRiskApproval/);
    strict_1.default.match(source, /migrateQueueItem/);
});
