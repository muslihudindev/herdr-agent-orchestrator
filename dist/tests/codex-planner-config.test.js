"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const ConfigLoader_1 = require("../packages/config/src/ConfigLoader");
(0, node_test_1.default)("Task Manager uses read-only Codex planner profile", async () => {
    const config = await new ConfigLoader_1.ConfigLoader("config/roles.yaml", "config/providers.yaml").load();
    strict_1.default.equal(config.roles.task_manager.provider, "codex-planner");
    strict_1.default.equal(config.providers["codex-planner"].command, "codex");
    strict_1.default.deepEqual(config.providers["codex-planner"].args, [
        "exec",
        "--sandbox",
        "read-only",
        "--color",
        "always",
        "--skip-git-repo-check"
    ]);
    strict_1.default.equal(config.providers["codex-planner"].keepPaneOpen, false);
    strict_1.default.equal(config.providers["codex-planner"].timeoutMs, 600000);
});
