"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const promises_1 = require("node:fs/promises");
const ConfigLoader_1 = require("../packages/config/src/ConfigLoader");
(0, node_test_1.default)("Claude Code provider uses supported permission-mode flag", async () => {
    const config = await new ConfigLoader_1.ConfigLoader("config/roles.yaml", "config/providers.yaml").load();
    const claude = config.providers["claude-code"];
    strict_1.default.equal(claude.command, "claude");
    strict_1.default.deepEqual(claude.args, ["--permission-mode", "auto"]);
    strict_1.default.equal(claude.args.includes("--auto"), false);
    strict_1.default.equal(claude.interactive, true);
    strict_1.default.equal(claude.keepPaneOpen, false);
    strict_1.default.equal(claude.closePaneOnDone, true);
    strict_1.default.equal(claude.timeoutMs, 1800000);
});
(0, node_test_1.default)("interactive providers launch through HerdR agent start", async () => {
    const source = await (0, promises_1.readFile)("packages/providers/src/ProcessProvider.ts", "utf8");
    const adapter = await (0, promises_1.readFile)("packages/runtime/src/HerdRAdapter.ts", "utf8");
    strict_1.default.match(source, /startAgent/);
    strict_1.default.match(adapter, /agent",\s+"start"/);
});
(0, node_test_1.default)("interactive providers can finish when HerdR marker appears in logs", async () => {
    const source = await (0, promises_1.readFile)("packages/providers/src/ProcessProvider.ts", "utf8");
    strict_1.default.match(source, /waitForInteractiveCompletion/);
    strict_1.default.match(source, /HERDR_DONE/);
    strict_1.default.match(source, /interactiveCompletionMarker/);
    strict_1.default.match(source, /HERDR_TRIBE_JSON/);
    strict_1.default.match(source, /countOccurrences\(transcript, marker\) >= 2/);
    strict_1.default.match(source, /sawWorking && \(status === "done" \|\| status === "idle"\)/);
    strict_1.default.match(source, /readAgent/);
    strict_1.default.doesNotMatch(source, /waitForAgentDone\(paneId/);
    strict_1.default.doesNotMatch(source, /logContains/);
});
(0, node_test_1.default)("interactive providers close panes on timeout", async () => {
    const source = await (0, promises_1.readFile)("packages/providers/src/ProcessProvider.ts", "utf8");
    strict_1.default.match(source, /await this\.closeInteractivePane\(task, pane\.id\);\s+return \{\s+success: false/s);
    strict_1.default.match(source, /private async closeInteractivePane/);
    strict_1.default.match(source, /closePaneOnDone/);
});
(0, node_test_1.default)("interactive provider startup failures are logged instead of crashing orchestration", async () => {
    const source = await (0, promises_1.readFile)("packages/providers/src/ProcessProvider.ts", "utf8");
    strict_1.default.match(source, /private async startInteractiveAgent/);
    strict_1.default.match(source, /catch \(error\)/);
    strict_1.default.match(source, /failed to start interactive/);
    strict_1.default.match(source, /errorMessage\(error\)/);
    strict_1.default.match(source, /return \{ success: false, exitCode: 1, summary \}/);
});
(0, node_test_1.default)("interactive HerdR agent names are unique per spawn", async () => {
    const source = await (0, promises_1.readFile)("packages/providers/src/ProcessProvider.ts", "utf8");
    strict_1.default.match(source, /herdrAgentLabel\(task\)/);
    strict_1.default.match(source, /function herdrAgentLabel\(task: ProviderTask\)/);
    strict_1.default.match(source, /safeMarkerPart\(task\.workerId\).*safeMarkerPart\(task\.taskId\).*createId\("spawn"\)/s);
    strict_1.default.match(source, /starting interactive .* agent \$\{agentLabel\}/);
    strict_1.default.match(source, /failed to start interactive .* agent \$\{agentLabel\}/);
    strict_1.default.doesNotMatch(source, /startAgent\(task\.workerId/);
});
