import test from "node:test";
import assert from "node:assert/strict";
import { ConfigLoader } from "../packages/config/src/ConfigLoader";

test("Task Manager uses read-only Codex planner profile", async () => {
  const config = await new ConfigLoader("config/roles.yaml", "config/providers.yaml").load();

  assert.equal(config.roles.task_manager.provider, "codex-planner");
  assert.equal(config.providers["codex-planner"].command, "codex");
  assert.deepEqual(config.providers["codex-planner"].args, [
    "exec",
    "--sandbox",
    "read-only",
    "--color",
    "always",
    "--skip-git-repo-check"
  ]);
  assert.equal(config.providers["codex-planner"].keepPaneOpen, false);
  assert.equal(config.providers["codex-planner"].timeoutMs, 600000);
});
