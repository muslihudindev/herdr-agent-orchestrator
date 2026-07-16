"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkspaceManager = void 0;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
class WorkspaceManager {
    root;
    constructor(root = "workspace") {
        this.root = root;
    }
    async prepareRun(taskId) {
        const path = (0, node_path_1.join)(this.root, taskId);
        await (0, promises_1.mkdir)(path, { recursive: true });
        return path;
    }
    async prepareWorker(taskId, workerId) {
        const path = (0, node_path_1.join)(this.root, taskId, workerId);
        await (0, promises_1.mkdir)(path, { recursive: true });
        return path;
    }
    async cleanupRun(taskId) {
        await (0, promises_1.rm)((0, node_path_1.join)(this.root, taskId), { recursive: true, force: true });
    }
}
exports.WorkspaceManager = WorkspaceManager;
