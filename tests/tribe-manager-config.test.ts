import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TribeManagerConfigLoader } from "../packages/config/src/TribeManagerConfigLoader";
import { isGitRelatedTask } from "../packages/task-manager/src/TaskManagerWorker";

test("loads tribe manager objective by project path", async () => {
  const root = join("/tmp", `tribe-manager-${Date.now()}`);
  const configPath = join(root, "tribe-manager.yaml");
  const projectRoot = join(root, "project");
  await mkdir(root, { recursive: true });
  await writeFile(
    configPath,
    [
      "projects:",
      `  ${projectRoot}:`,
      "    objective: Keep task work aligned with the roadmap",
      "    objective_id: 42",
      "    user_id: 7",
      ""
    ].join("\n"),
    "utf8"
  );

  const objective = await new TribeManagerConfigLoader(configPath).objectiveForProject(projectRoot);
  const config = await new TribeManagerConfigLoader(configPath).configForProject(projectRoot);

  assert.equal(objective, "Keep task work aligned with the roadmap");
  assert.equal(config?.objectiveId, 42);
  assert.equal(config?.userId, 7);
});

test("loads tribe manager config with deeper yaml indentation", async () => {
  const root = join("/tmp", `tribe-manager-indent-${Date.now()}`);
  const configPath = join(root, "tribe-manager.yaml");
  const projectRoot = join(root, "project");
  await mkdir(root, { recursive: true });
  await writeFile(
    configPath,
    [
      "projects:",
      `  ${projectRoot}:`,
      "      objective: Indented objective",
      "      objective_id: 42",
      "      user_id: 7",
      ""
    ].join("\n"),
    "utf8"
  );

  const config = await new TribeManagerConfigLoader(configPath).configForProject(projectRoot);

  assert.equal(config?.objective, "Indented objective");
  assert.equal(config?.objectiveId, 42);
  assert.equal(config?.userId, 7);
});

test("loads current tribe manager project config", async () => {
  const config = await new TribeManagerConfigLoader("config/tribe-manager.yaml").configForProject("/home/muslih/Documents/MPM_PORTAL");

  assert.equal(config?.objective, "Support bugs post-deployment");
  assert.equal(config?.objectiveId, 23);
  assert.equal(config?.userId, 16);
});

test("uses nearest parent tribe manager project objective", async () => {
  const root = join("/tmp", `tribe-manager-parent-${Date.now()}`);
  const configPath = join(root, "tribe-manager.yaml");
  await mkdir(root, { recursive: true });
  await writeFile(
    configPath,
    [
      "projects:",
      `  ${root}:`,
      "    objective: Parent objective",
      `  ${join(root, "nested")}:`,
      "    objective: Nested objective",
      ""
    ].join("\n"),
    "utf8"
  );

  const objective = await new TribeManagerConfigLoader(configPath).objectiveForProject(join(root, "nested", "app"));

  assert.equal(objective, "Nested objective");
});

test("returns no tribe manager objective when project path is not configured", async () => {
  const objective = await new TribeManagerConfigLoader("config/tribe-manager.yaml").objectiveForProject("/not/configured");

  assert.equal(objective, undefined);
});

test("detects git-related tasks for tribe manager exclusion", () => {
  assert.equal(isGitRelatedTask("commit then push it"), true);
  assert.equal(isGitRelatedTask("create a feature branch"), true);
  assert.equal(isGitRelatedTask("fix the e2e test error"), false);
});
