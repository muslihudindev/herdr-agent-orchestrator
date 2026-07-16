"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const promises_1 = require("node:fs/promises");
(0, node_test_1.default)("Task Manager prompt delegates tests instead of running them", async () => {
    const source = await (0, promises_1.readFile)("packages/task-manager/src/TaskManagerWorker.ts", "utf8");
    strict_1.default.match(source, /Do not run tests, lint, build, or validation commands/);
    strict_1.default.match(source, /You may inspect and read repository files/);
    strict_1.default.match(source, /Choose the best concrete tasks for executors after reading the code/);
    strict_1.default.match(source, /Do not spawn agents, subagents, background agents, workers, or executors/);
    strict_1.default.match(source, /HerdR is the only system allowed to create executors/);
    strict_1.default.match(source, /test-writing subtask/);
    strict_1.default.doesNotMatch(source, /Run the project's configured tests/);
});
(0, node_test_1.default)("Task Manager records approved non-git tasks as in progress in Tribe Manager before execution", async () => {
    const source = await (0, promises_1.readFile)("packages/task-manager/src/TaskManagerWorker.ts", "utf8");
    const runtime = await (0, promises_1.readFile)("packages/runtime/src/TaskManagerRuntime.ts", "utf8");
    strict_1.default.match(source, /approved and is now in progress/);
    strict_1.default.match(source, /"in-progress"/);
    strict_1.default.match(source, /Create or update a Tribe task with status/);
    strict_1.default.match(source, /Do not call tribe_manager\.list_tasks/);
    strict_1.default.doesNotMatch(source, /phase === "new"\s+phase === "approved"/);
    strict_1.default.match(runtime, /providerForTribeSync/);
    strict_1.default.match(runtime, /"claude-code"/);
});
(0, node_test_1.default)("Tribe Manager completion updates stored task id instead of creating a duplicate", async () => {
    const source = await (0, promises_1.readFile)("packages/task-manager/src/TaskManagerWorker.ts", "utf8");
    const runtime = await (0, promises_1.readFile)("packages/runtime/src/TaskManagerRuntime.ts", "utf8");
    strict_1.default.match(runtime, /writeStoredTribeTaskId/);
    strict_1.default.match(runtime, /readStoredTribeTaskId/);
    strict_1.default.match(source, /completion sync skipped: no captured Tribe task id/);
    strict_1.default.match(source, /Update Tribe task_id/);
    strict_1.default.doesNotMatch(source, /record the final outcome/);
});
(0, node_test_1.default)("Task Manager can revise plans from user feedback", async () => {
    const source = await (0, promises_1.readFile)("packages/task-manager/src/TaskManagerWorker.ts", "utf8");
    strict_1.default.match(source, /Plan revision requested by user/);
    strict_1.default.match(source, /Revise the plan to address the feedback/);
});
(0, node_test_1.default)("Validator owns final verification", async () => {
    const source = await (0, promises_1.readFile)("packages/validator/src/ValidatorWorker.ts", "utf8");
    strict_1.default.match(source, /You own final verification/);
    strict_1.default.match(source, /Run the project's configured tests, lint, and build commands when available/);
    strict_1.default.match(source, /do not regress or unintentionally change behavior for other user roles/);
    strict_1.default.match(source, /not accepted/);
    strict_1.default.match(source, /Validator rejected work/);
    strict_1.default.match(source, /summarizeValidatorRejection/);
});
