"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const node_child_process_1 = require("node:child_process");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const node_os_1 = require("node:os");
const node_util_1 = require("node:util");
const GitPublisher_1 = require("../packages/runtime/src/GitPublisher");
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
(0, node_test_1.default)("publishes changes in multiple git repositories under a project folder", async () => {
    const root = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "herdr-git-publisher-"));
    const project = (0, node_path_1.join)(root, "project");
    const remotes = (0, node_path_1.join)(root, "remotes");
    await (0, promises_1.mkdir)(project);
    await (0, promises_1.mkdir)((0, node_path_1.join)(project, ".git"));
    await (0, promises_1.mkdir)(remotes);
    const repoA = await createRepository(project, remotes, "repo-a");
    const repoB = await createRepository(project, remotes, "repo-b");
    await (0, promises_1.writeFile)((0, node_path_1.join)(repoA, "feature.txt"), "feature a\n", "utf8");
    await (0, promises_1.writeFile)((0, node_path_1.join)(repoB, "feature.txt"), "feature b\n", "utf8");
    const result = await (0, GitPublisher_1.publishTaskChanges)(project, "task-test", "Implement multi repo publishing");
    strict_1.default.equal(result.attempted, true);
    strict_1.default.equal(result.committed, true);
    strict_1.default.equal(result.pushed, true);
    strict_1.default.equal(result.repositories?.filter((repo) => repo.committed).length, 2);
    strict_1.default.equal(result.repositories?.filter((repo) => repo.pushed).length, 2);
});
(0, node_test_1.default)("skips pre-commit hook for portal-vendor-fe publishing", async () => {
    const root = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "herdr-git-no-verify-"));
    const project = (0, node_path_1.join)(root, "project");
    const remotes = (0, node_path_1.join)(root, "remotes");
    await (0, promises_1.mkdir)(project);
    await (0, promises_1.mkdir)((0, node_path_1.join)(project, ".git"));
    await (0, promises_1.mkdir)(remotes);
    const repo = await createRepository(project, remotes, "portal-vendor-fe");
    await (0, promises_1.mkdir)((0, node_path_1.join)(repo, ".git", "hooks"), { recursive: true });
    await (0, promises_1.writeFile)((0, node_path_1.join)(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await (0, promises_1.writeFile)((0, node_path_1.join)(repo, "feature.txt"), "feature\n", "utf8");
    const result = await (0, GitPublisher_1.publishTaskChanges)(project, "task-test", "Commit frontend change");
    strict_1.default.equal(result.committed, true);
    strict_1.default.equal(result.pushed, true);
});
(0, node_test_1.default)("keeps pre-commit hook for other repositories", async () => {
    const root = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "herdr-git-verify-"));
    const project = (0, node_path_1.join)(root, "project");
    const remotes = (0, node_path_1.join)(root, "remotes");
    await (0, promises_1.mkdir)(project);
    await (0, promises_1.mkdir)((0, node_path_1.join)(project, ".git"));
    await (0, promises_1.mkdir)(remotes);
    const repo = await createRepository(project, remotes, "repo-a");
    await (0, promises_1.mkdir)((0, node_path_1.join)(repo, ".git", "hooks"), { recursive: true });
    await (0, promises_1.writeFile)((0, node_path_1.join)(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await (0, promises_1.writeFile)((0, node_path_1.join)(repo, "feature.txt"), "feature\n", "utf8");
    const result = await (0, GitPublisher_1.publishTaskChanges)(project, "task-test", "Commit backend change");
    strict_1.default.equal(result.committed, false);
    strict_1.default.equal(result.pushed, false);
});
(0, node_test_1.default)("uses existing conventional commit prefix when repo history has one", async () => {
    const root = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "herdr-git-message-"));
    const project = (0, node_path_1.join)(root, "project");
    const remotes = (0, node_path_1.join)(root, "remotes");
    await (0, promises_1.mkdir)(project);
    await (0, promises_1.mkdir)((0, node_path_1.join)(project, ".git"));
    await (0, promises_1.mkdir)(remotes);
    const repo = await createRepository(project, remotes, "repo-a");
    await (0, promises_1.writeFile)((0, node_path_1.join)(repo, "fix.txt"), "fix\n", "utf8");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "fix: prior fix"]);
    await (0, promises_1.writeFile)((0, node_path_1.join)(repo, "feature.txt"), "feature\n", "utf8");
    const result = await (0, GitPublisher_1.publishTaskChanges)(project, "task-test", "User task text must not become the commit message");
    const subject = await gitOutput(repo, ["log", "-1", "--format=%s"]);
    strict_1.default.equal(result.committed, true);
    strict_1.default.equal(subject.trim(), "fix: add feature");
});
(0, node_test_1.default)("generates commit message scope from changed code paths", async () => {
    const root = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "herdr-git-scope-"));
    const project = (0, node_path_1.join)(root, "project");
    const remotes = (0, node_path_1.join)(root, "remotes");
    await (0, promises_1.mkdir)(project);
    await (0, promises_1.mkdir)((0, node_path_1.join)(project, ".git"));
    await (0, promises_1.mkdir)(remotes);
    const repo = await createRepository(project, remotes, "repo-a");
    await (0, promises_1.mkdir)((0, node_path_1.join)(repo, "src", "views", "detail-vendor"), { recursive: true });
    await (0, promises_1.mkdir)((0, node_path_1.join)(repo, "tests", "vendor"), { recursive: true });
    await (0, promises_1.writeFile)((0, node_path_1.join)(repo, "src", "views", "detail-vendor", "index.vue"), "fix\n", "utf8");
    await (0, promises_1.writeFile)((0, node_path_1.join)(repo, "tests", "vendor", "vendor-detail.spec.ts"), "test\n", "utf8");
    const result = await (0, GitPublisher_1.publishTaskChanges)(project, "task-test", "raw task text should be ignored");
    const subject = await gitOutput(repo, ["log", "-1", "--format=%s"]);
    strict_1.default.equal(result.committed, true);
    strict_1.default.equal(subject.trim(), "add vendor detail");
});
(0, node_test_1.default)("uses provider-generated commit subject when available", async () => {
    const root = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "herdr-git-ai-message-"));
    const project = (0, node_path_1.join)(root, "project");
    const remotes = (0, node_path_1.join)(root, "remotes");
    await (0, promises_1.mkdir)(project);
    await (0, promises_1.mkdir)((0, node_path_1.join)(project, ".git"));
    await (0, promises_1.mkdir)(remotes);
    const repo = await createRepository(project, remotes, "repo-a");
    await (0, promises_1.writeFile)((0, node_path_1.join)(repo, "feature.txt"), "feature\n", "utf8");
    const result = await (0, GitPublisher_1.publishTaskChanges)(project, "task-test", "raw task text should be ignored", {
        commitMessageProvider: fakeCommitMessageProvider("fix generated subject"),
        logPath: (0, node_path_1.join)(root, "commit-message.log"),
        workspacePath: (0, node_path_1.join)(root, "workspace")
    });
    const subject = await gitOutput(repo, ["log", "-1", "--format=%s"]);
    strict_1.default.equal(result.committed, true);
    strict_1.default.equal(subject.trim(), "fix generated subject");
});
async function createRepository(project, remotes, name) {
    const repo = (0, node_path_1.join)(project, name);
    const remote = (0, node_path_1.join)(remotes, `${name}.git`);
    await (0, promises_1.mkdir)(repo);
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.email", "herdr@example.local"]);
    await git(repo, ["config", "user.name", "HerdR"]);
    await (0, promises_1.writeFile)((0, node_path_1.join)(repo, "README.md"), `# ${name}\n`, "utf8");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "Initial commit"]);
    await git(remotes, ["init", "--bare", `${name}.git`]);
    await git(repo, ["remote", "add", "origin", remote]);
    await git(repo, ["push", "-u", "origin", "main"]);
    return repo;
}
async function git(cwd, args) {
    await execFileAsync("git", args, { cwd });
}
async function gitOutput(cwd, args) {
    return (await execFileAsync("git", args, { cwd })).stdout;
}
function fakeCommitMessageProvider(subject) {
    return {
        name: "fake",
        async start() { },
        async stop() { },
        async executeTask(task) {
            await (0, promises_1.appendFile)(task.logPath, `HERDR_COMMIT_JSON {"subject":"${subject}"}\n`);
            return { success: true, exitCode: 0, summary: "ok" };
        },
        async streamLogs() {
            return () => undefined;
        },
        async cancelTask() { },
        async healthCheck() {
            return true;
        },
        async getStatus() {
            return { name: "fake", healthy: true, runningTasks: 0 };
        }
    };
}
