"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const TribeManagerConfigLoader_1 = require("../packages/config/src/TribeManagerConfigLoader");
const TaskManagerWorker_1 = require("../packages/task-manager/src/TaskManagerWorker");
(0, node_test_1.default)("loads tribe manager objective by project path", async () => {
    const root = (0, node_path_1.join)("/tmp", `tribe-manager-${Date.now()}`);
    const configPath = (0, node_path_1.join)(root, "tribe-manager.yaml");
    const projectRoot = (0, node_path_1.join)(root, "project");
    await (0, promises_1.mkdir)(root, { recursive: true });
    await (0, promises_1.writeFile)(configPath, [
        "projects:",
        `  ${projectRoot}:`,
        "    objective: Keep task work aligned with the roadmap",
        "    objective_id: 42",
        "    user_id: 7",
        ""
    ].join("\n"), "utf8");
    const objective = await new TribeManagerConfigLoader_1.TribeManagerConfigLoader(configPath).objectiveForProject(projectRoot);
    const config = await new TribeManagerConfigLoader_1.TribeManagerConfigLoader(configPath).configForProject(projectRoot);
    strict_1.default.equal(objective, "Keep task work aligned with the roadmap");
    strict_1.default.equal(config?.objectiveId, 42);
    strict_1.default.equal(config?.userId, 7);
});
(0, node_test_1.default)("loads tribe manager config with deeper yaml indentation", async () => {
    const root = (0, node_path_1.join)("/tmp", `tribe-manager-indent-${Date.now()}`);
    const configPath = (0, node_path_1.join)(root, "tribe-manager.yaml");
    const projectRoot = (0, node_path_1.join)(root, "project");
    await (0, promises_1.mkdir)(root, { recursive: true });
    await (0, promises_1.writeFile)(configPath, [
        "projects:",
        `  ${projectRoot}:`,
        "      objective: Indented objective",
        "      objective_id: 42",
        "      user_id: 7",
        ""
    ].join("\n"), "utf8");
    const config = await new TribeManagerConfigLoader_1.TribeManagerConfigLoader(configPath).configForProject(projectRoot);
    strict_1.default.equal(config?.objective, "Indented objective");
    strict_1.default.equal(config?.objectiveId, 42);
    strict_1.default.equal(config?.userId, 7);
});
(0, node_test_1.default)("loads project config with ids", async () => {
    const root = (0, node_path_1.join)("/tmp", `tribe-manager-current-${Date.now()}`);
    const configPath = (0, node_path_1.join)(root, "tribe-manager.yaml");
    await (0, promises_1.mkdir)(root, { recursive: true });
    await (0, promises_1.writeFile)(configPath, [
        "projects:",
        "  /home/muslih/Documents/MPM_PORTAL:",
        "    objective: Support bugs post-deployment",
        "    objective_id: 23",
        "    user_id: 16",
        ""
    ].join("\n"), "utf8");
    const config = await new TribeManagerConfigLoader_1.TribeManagerConfigLoader(configPath).configForProject("/home/muslih/Documents/MPM_PORTAL");
    strict_1.default.equal(config?.objective, "Support bugs post-deployment");
    strict_1.default.equal(config?.objectiveId, 23);
    strict_1.default.equal(config?.userId, 16);
});
(0, node_test_1.default)("uses nearest parent tribe manager project objective", async () => {
    const root = (0, node_path_1.join)("/tmp", `tribe-manager-parent-${Date.now()}`);
    const configPath = (0, node_path_1.join)(root, "tribe-manager.yaml");
    await (0, promises_1.mkdir)(root, { recursive: true });
    await (0, promises_1.writeFile)(configPath, [
        "projects:",
        `  ${root}:`,
        "    objective: Parent objective",
        `  ${(0, node_path_1.join)(root, "nested")}:`,
        "    objective: Nested objective",
        ""
    ].join("\n"), "utf8");
    const objective = await new TribeManagerConfigLoader_1.TribeManagerConfigLoader(configPath).objectiveForProject((0, node_path_1.join)(root, "nested", "app"));
    strict_1.default.equal(objective, "Nested objective");
});
(0, node_test_1.default)("returns no tribe manager objective when project path is not configured", async () => {
    const objective = await new TribeManagerConfigLoader_1.TribeManagerConfigLoader("config/tribe-manager.yaml").objectiveForProject("/not/configured");
    strict_1.default.equal(objective, undefined);
});
(0, node_test_1.default)("detects git-related tasks for tribe manager exclusion", () => {
    strict_1.default.equal((0, TaskManagerWorker_1.isGitRelatedTask)("commit then push it"), true);
    strict_1.default.equal((0, TaskManagerWorker_1.isGitRelatedTask)("create a feature branch"), true);
    strict_1.default.equal((0, TaskManagerWorker_1.isGitRelatedTask)("fix the e2e test error"), false);
});
(0, node_test_1.default)("parses Tribe task id from HerdR wrapped provider logs", () => {
    strict_1.default.equal((0, TaskManagerWorker_1.parseTribeTaskId)('HERDR_TRIBE_JSON {"taskId":443}'), 443);
    strict_1.default.equal((0, TaskManagerWorker_1.parseTribeTaskId)('HERDR_TRIBE_JSON\n{"taskId":505}'), 505);
    strict_1.default.equal((0, TaskManagerWorker_1.parseTribeTaskId)('{"text":"HERDR_TRIBE_JSON {\\"taskId\\": 464}\\n"}'), 464);
    strict_1.default.equal((0, TaskManagerWorker_1.parseTribeTaskId)('HERDR_TRIBE_JSON {"taskId": null, "reason": "unavailable"}'), undefined);
});
