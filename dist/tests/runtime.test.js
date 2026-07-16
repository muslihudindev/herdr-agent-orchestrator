"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const node_os_1 = require("node:os");
const RuntimeOrchestrator_1 = require("../packages/runtime/src/RuntimeOrchestrator");
(0, node_test_1.default)("runs a provider-agnostic multi-worker task", async () => {
    const previousRolesPath = process.env.PI_ORCHESTRATION_ROLES_PATH;
    const previousAutoApprovePlan = process.env.PI_ORCHESTRATION_AUTO_APPROVE_PLAN;
    process.env.PI_ORCHESTRATION_ROLES_PATH = (0, node_path_1.join)(process.cwd(), "config", "roles.test.yaml");
    process.env.PI_ORCHESTRATION_AUTO_APPROVE_PLAN = "true";
    let summary;
    try {
        const projectRoot = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "herdr-runtime-project-"));
        const storageRoot = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "herdr-runtime-storage-"));
        const runtime = new RuntimeOrchestrator_1.RuntimeOrchestrator({
            orchestrationRoot: process.cwd(),
            projectRoot,
            storageRoot
        });
        summary = await runtime.run("Build JWT authentication with refresh token support.");
    }
    finally {
        if (previousRolesPath === undefined) {
            delete process.env.PI_ORCHESTRATION_ROLES_PATH;
        }
        else {
            process.env.PI_ORCHESTRATION_ROLES_PATH = previousRolesPath;
        }
        if (previousAutoApprovePlan === undefined) {
            delete process.env.PI_ORCHESTRATION_AUTO_APPROVE_PLAN;
        }
        else {
            process.env.PI_ORCHESTRATION_AUTO_APPROVE_PLAN = previousAutoApprovePlan;
        }
    }
    strict_1.default.equal(summary.success, true);
    strict_1.default.equal(summary.approvalRequired, false);
    strict_1.default.ok(summary.plan.subtasks.length >= 4);
    strict_1.default.ok(summary.workers.some((worker) => worker.id === "validator"));
});
(0, node_test_1.default)("runtime does not validate when executors fail", async () => {
    const source = await import("node:fs/promises").then((fs) => fs.readFile("packages/runtime/src/TaskManagerRuntime.ts", "utf8"));
    strict_1.default.match(source, /executorFailure\(executorResults\)/);
    strict_1.default.match(source, /Executor failed before validation/);
    strict_1.default.match(source, /: await this\.validateWithRepair/);
});
