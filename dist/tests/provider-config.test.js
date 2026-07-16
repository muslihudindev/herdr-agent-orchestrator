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
