"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const ConfigLoader_1 = require("../packages/config/src/ConfigLoader");
(0, node_test_1.default)("loads role and provider configuration", async () => {
    const config = await new ConfigLoader_1.ConfigLoader("config/roles.test.yaml", "config/providers.yaml").load();
    strict_1.default.equal(config.roles.task_manager.provider, "simulated");
    strict_1.default.equal(config.roles.executor.replicas, 3);
    strict_1.default.equal(config.providers.codex.command, "codex");
    strict_1.default.deepEqual(config.providers["claude-code"].args, ["--permission-mode", "auto"]);
    strict_1.default.equal(config.providers["claude-code"].interactive, true);
});
(0, node_test_1.default)("production role defaults map to Codex and Claude Code", async () => {
    const config = await new ConfigLoader_1.ConfigLoader("config/roles.yaml", "config/providers.yaml").load();
    strict_1.default.equal(config.roles.task_manager.provider, "codex-planner");
    strict_1.default.equal(config.roles.executor.provider, "claude-code");
    strict_1.default.equal(config.roles.validator.provider, "claude-code");
});
