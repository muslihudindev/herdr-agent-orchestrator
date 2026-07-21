import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ConfigLoader } from "../packages/config/src/ConfigLoader";

test("Claude Code provider uses supported permission-mode flag", async () => {
  const config = await new ConfigLoader("config/roles.yaml", "config/providers.yaml").load();
  const claude = config.providers["claude-code"];

  assert.equal(claude.command, "claude");
  assert.deepEqual(claude.args, ["--permission-mode", "auto"]);
  assert.equal(claude.args.includes("--auto"), false);
  assert.equal(claude.interactive, true);
  assert.equal(claude.keepPaneOpen, false);
  assert.equal(claude.closePaneOnDone, true);
  assert.equal(claude.timeoutMs, 1800000);
});

test("interactive providers launch through HerdR agent start", async () => {
  const source = await readFile("packages/providers/src/ProcessProvider.ts", "utf8");
  const adapter = await readFile("packages/runtime/src/HerdRAdapter.ts", "utf8");

  assert.match(source, /startAgent/);
  assert.match(adapter, /agent",\s+"start"/);
});

test("interactive providers can finish when HerdR marker appears in logs", async () => {
  const source = await readFile("packages/providers/src/ProcessProvider.ts", "utf8");

  assert.match(source, /waitForInteractiveCompletion/);
  assert.match(source, /HERDR_DONE/);
  assert.match(source, /interactiveCompletionMarker/);
  assert.match(source, /HERDR_TRIBE_JSON/);
  assert.match(source, /countOccurrences\(transcript, marker\) >= 2/);
  assert.match(source, /sawWorking && \(status === "done" \|\| status === "idle"\)/);
  assert.match(source, /readAgent/);
  assert.doesNotMatch(source, /waitForAgentDone\(paneId/);
  assert.doesNotMatch(source, /logContains/);
});

test("interactive providers close panes on timeout", async () => {
  const source = await readFile("packages/providers/src/ProcessProvider.ts", "utf8");

  assert.match(source, /await this\.closeInteractivePane\(task, pane\.id\);\s+return \{\s+success: false/s);
  assert.match(source, /private async closeInteractivePane/);
  assert.match(source, /closePaneOnDone/);
});

test("interactive provider startup failures are logged instead of crashing orchestration", async () => {
  const source = await readFile("packages/providers/src/ProcessProvider.ts", "utf8");

  assert.match(source, /private async startInteractiveAgent/);
  assert.match(source, /catch \(error\)/);
  assert.match(source, /failed to start interactive/);
  assert.match(source, /errorMessage\(error\)/);
  assert.match(source, /return \{ success: false, exitCode: 1, summary \}/);
});

test("interactive HerdR agent names are unique per spawn", async () => {
  const source = await readFile("packages/providers/src/ProcessProvider.ts", "utf8");

  assert.match(source, /herdrAgentLabel\(task\)/);
  assert.match(source, /function herdrAgentLabel\(task: ProviderTask\)/);
  assert.match(source, /safeMarkerPart\(task\.workerId\).*safeMarkerPart\(task\.taskId\).*createId\("spawn"\)/s);
  assert.match(source, /starting interactive .* agent \$\{agentLabel\}/);
  assert.match(source, /failed to start interactive .* agent \$\{agentLabel\}/);
  assert.doesNotMatch(source, /startAgent\(task\.workerId/);
});
