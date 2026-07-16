"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const promises_1 = require("node:fs/promises");
(0, node_test_1.default)("Pi runtime does not instantiate backend role workers directly", async () => {
    const source = await (0, promises_1.readFile)("packages/runtime/src/RuntimeOrchestrator.ts", "utf8");
    strict_1.default.equal(source.includes("TaskManagerWorker"), false);
    strict_1.default.equal(source.includes("ExecutorWorker"), false);
    strict_1.default.equal(source.includes("ValidatorWorker"), false);
    strict_1.default.equal(source.includes("ProviderRegistry"), false);
});
(0, node_test_1.default)("Pi queued preplanned approval starts only approved tasks", async () => {
    const source = await (0, promises_1.readFile)(".pi/extensions/herdr-orchestration.ts", "utf8");
    strict_1.default.match(source, /item\.status === "todo" && item\.planApprovalStatus === "approved"/);
    strict_1.default.match(source, /if \(queuePlanId\) \{\s+if \(ctx\.mode === "tui"\) \{\s+void processQueue\(pi, ctx\);/s);
});
(0, node_test_1.default)("Pi preserves queued plan confirmation while active task finishes", async () => {
    const source = await (0, promises_1.readFile)(".pi/extensions/herdr-orchestration.ts", "utf8");
    strict_1.default.match(source, /function clearRuntimePlanApprovalState\(\)/);
    strict_1.default.match(source, /state\.planApprovalPath\?\.startsWith\("queue:"\)/);
    strict_1.default.match(source, /const pendingPlan = nextPendingQueuedPlan\(\)/);
    strict_1.default.match(source, /Recovered pending queued plan approval/);
});
(0, node_test_1.default)("Pi plan confirmation uses compact submitted task text", async () => {
    const source = await (0, promises_1.readFile)(".pi/extensions/herdr-orchestration.ts", "utf8");
    strict_1.default.match(source, /submittedTask: item\.task/);
    strict_1.default.match(source, /compactTaskText\(payload\.submittedTask \?\? plan\?\.request/);
    strict_1.default.match(source, /subtasks\.slice\(0, 3\)/);
    strict_1.default.match(source, /criteria\.slice\(0, 3\)/);
    strict_1.default.match(source, /herdr-plan-detail/);
    strict_1.default.match(source, /function renderPlanDetail/);
    strict_1.default.match(source, /User clarification/);
});
(0, node_test_1.default)("Runtime auto publishes git changes after validation passes", async () => {
    const source = await (0, promises_1.readFile)("packages/runtime/src/TaskManagerRuntime.ts", "utf8");
    strict_1.default.match(source, /publishTaskChanges\(this\.projectRoot, taskId, request, \{/);
    strict_1.default.match(source, /commitMessageProvider: this\.providerRegistry\.get\(roles\.providerFor\("validator"\)\)/);
    strict_1.default.match(source, /gitPublish\.committed && gitPublish\.pushed/);
    strict_1.default.doesNotMatch(source, /waitForGitPublishApproval/);
    strict_1.default.doesNotMatch(source, /GitPublishApprovalRequired/);
});
(0, node_test_1.default)("Pi passes explicit tribe manager config path to runtime", async () => {
    const source = await (0, promises_1.readFile)(".pi/extensions/herdr-orchestration.ts", "utf8");
    strict_1.default.match(source, /tribeManagerConfigPath/);
    strict_1.default.match(source, /PI_ORCHESTRATION_TRIBE_MANAGER_PATH/);
});
(0, node_test_1.default)("Pi has a manual command to resume stuck todo tasks", async () => {
    const source = await (0, promises_1.readFile)(".pi/extensions/herdr-orchestration.ts", "utf8");
    strict_1.default.match(source, /herdr-run-todo/);
    strict_1.default.match(source, /Starting approved todo task/);
    strict_1.default.match(source, /promptQueuedPlanApproval\(pi, ctx, pending\.id\)/);
    strict_1.default.match(source, /preplanQueuedTasks\(pi, ctx\)/);
});
(0, node_test_1.default)("Pi can requeue failed tasks for rework", async () => {
    const source = await (0, promises_1.readFile)(".pi/extensions/herdr-orchestration.ts", "utf8");
    strict_1.default.match(source, /herdr-retry-failed/);
    strict_1.default.match(source, /function retryFailedTask/);
    strict_1.default.match(source, /status: "todo"/);
    strict_1.default.match(source, /Rework failed task/);
});
(0, node_test_1.default)("Pi auto-reworks only git or mcp related failures", async () => {
    const source = await (0, promises_1.readFile)(".pi/extensions/herdr-orchestration.ts", "utf8");
    strict_1.default.match(source, /enqueueValidationFixTask/);
    strict_1.default.match(source, /Fix validation failure for/);
    strict_1.default.match(source, /Validator failure:/);
    strict_1.default.match(source, /isAutoReworkFailure/);
    strict_1.default.match(source, /git\|commit\|push\|remote\|mcp\|tribe\|tribe_manager/);
    strict_1.default.doesNotMatch(source, /validation\|validator\|acceptance\|not accepted\|checks/);
});
(0, node_test_1.default)("Pi displays validator progress and result cards", async () => {
    const source = await (0, promises_1.readFile)(".pi/extensions/herdr-orchestration.ts", "utf8");
    strict_1.default.match(source, /ValidationPassed/);
    strict_1.default.match(source, /ValidationFailed/);
    strict_1.default.match(source, /Running validation/);
});
(0, node_test_1.default)("Pi normal conversation is not automatically queued as a task", async () => {
    const source = await (0, promises_1.readFile)(".pi/extensions/herdr-orchestration.ts", "utf8");
    strict_1.default.match(source, /pi\.on\("input"/);
    strict_1.default.match(source, /return \{ action: "continue" \}/);
    strict_1.default.match(source, /herdr-add-task/);
    strict_1.default.match(source, /queueTaskCommand\(pi, ctx, args, "\/herdr-add-task <task>"\)/);
});
(0, node_test_1.default)("Pi queue rows are single-line ellipsized", async () => {
    const source = await (0, promises_1.readFile)(".pi/extensions/herdr-orchestration.ts", "utf8");
    strict_1.default.match(source, /ellipsis\(item\.task, 120\)/);
    strict_1.default.match(source, /text\.replace\(\/\\s\+\/g, " "\)/);
});
(0, node_test_1.default)("Pi surfaces pending queued plan as the next action", async () => {
    const source = await (0, promises_1.readFile)(".pi/extensions/herdr-orchestration.ts", "utf8");
    strict_1.default.match(source, /function nextQueueAction/);
    strict_1.default.match(source, /Next: \/herdr-confirm to approve/);
    strict_1.default.match(source, /plan:waiting/);
});
