import test from "node:test";
import assert from "node:assert/strict";
import { ConfigLoader } from "../packages/config/src/ConfigLoader";

test("loads role and provider configuration", async () => {
  const config = await new ConfigLoader("config/roles.test.yaml", "config/providers.yaml").load();
  assert.equal(config.roles.task_manager.provider, "simulated");
  assert.equal(config.roles.executor.replicas, 3);
  assert.equal(config.providers.codex.command, "codex");
  assert.deepEqual(config.providers["claude-code"].args, ["--permission-mode", "auto"]);
  assert.equal(config.providers["claude-code"].interactive, true);
});

test("production role defaults map to Codex and Claude Code", async () => {
  const config = await new ConfigLoader("config/roles.yaml", "config/providers.yaml").load();
  assert.equal(config.roles.task_manager.provider, "codex-planner");
  assert.equal(config.roles.executor.provider, "claude-code");
  assert.equal(config.roles.validator.provider, "claude-code");
});
