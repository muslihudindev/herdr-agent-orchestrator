import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { publishTaskChanges } from "../packages/runtime/src/GitPublisher";

const execFileAsync = promisify(execFile);

test("publishes changes in multiple git repositories under a project folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "herdr-git-publisher-"));
  const project = join(root, "project");
  const remotes = join(root, "remotes");
  await mkdir(project);
  await mkdir(join(project, ".git"));
  await mkdir(remotes);

  const repoA = await createRepository(project, remotes, "repo-a");
  const repoB = await createRepository(project, remotes, "repo-b");

  await writeFile(join(repoA, "feature.txt"), "feature a\n", "utf8");
  await writeFile(join(repoB, "feature.txt"), "feature b\n", "utf8");

  const result = await publishTaskChanges(project, "task-test", "Implement multi repo publishing");

  assert.equal(result.attempted, true);
  assert.equal(result.committed, true);
  assert.equal(result.pushed, true);
  assert.equal(result.repositories?.filter((repo) => repo.committed).length, 2);
  assert.equal(result.repositories?.filter((repo) => repo.pushed).length, 2);
});

test("skips pre-commit hook for portal-vendor-fe publishing", async () => {
  const root = await mkdtemp(join(tmpdir(), "herdr-git-no-verify-"));
  const project = join(root, "project");
  const remotes = join(root, "remotes");
  await mkdir(project);
  await mkdir(join(project, ".git"));
  await mkdir(remotes);

  const repo = await createRepository(project, remotes, "portal-vendor-fe");
  await mkdir(join(repo, ".git", "hooks"), { recursive: true });
  await writeFile(join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await writeFile(join(repo, "feature.txt"), "feature\n", "utf8");

  const result = await publishTaskChanges(project, "task-test", "Commit frontend change");

  assert.equal(result.committed, true);
  assert.equal(result.pushed, true);
});

test("keeps pre-commit hook for other repositories", async () => {
  const root = await mkdtemp(join(tmpdir(), "herdr-git-verify-"));
  const project = join(root, "project");
  const remotes = join(root, "remotes");
  await mkdir(project);
  await mkdir(join(project, ".git"));
  await mkdir(remotes);

  const repo = await createRepository(project, remotes, "repo-a");
  await mkdir(join(repo, ".git", "hooks"), { recursive: true });
  await writeFile(join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await writeFile(join(repo, "feature.txt"), "feature\n", "utf8");

  const result = await publishTaskChanges(project, "task-test", "Commit backend change");

  assert.equal(result.committed, false);
  assert.equal(result.pushed, false);
});

test("uses existing conventional commit prefix when repo history has one", async () => {
  const root = await mkdtemp(join(tmpdir(), "herdr-git-message-"));
  const project = join(root, "project");
  const remotes = join(root, "remotes");
  await mkdir(project);
  await mkdir(join(project, ".git"));
  await mkdir(remotes);

  const repo = await createRepository(project, remotes, "repo-a");
  await writeFile(join(repo, "fix.txt"), "fix\n", "utf8");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "fix: prior fix"]);
  await writeFile(join(repo, "feature.txt"), "feature\n", "utf8");

  const result = await publishTaskChanges(project, "task-test", "User task text must not become the commit message");
  const subject = await gitOutput(repo, ["log", "-1", "--format=%s"]);

  assert.equal(result.committed, true);
  assert.equal(subject.trim(), "fix: add feature");
});

test("generates commit message scope from changed code paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "herdr-git-scope-"));
  const project = join(root, "project");
  const remotes = join(root, "remotes");
  await mkdir(project);
  await mkdir(join(project, ".git"));
  await mkdir(remotes);

  const repo = await createRepository(project, remotes, "repo-a");
  await mkdir(join(repo, "src", "views", "detail-vendor"), { recursive: true });
  await mkdir(join(repo, "tests", "vendor"), { recursive: true });
  await writeFile(join(repo, "src", "views", "detail-vendor", "index.vue"), "fix\n", "utf8");
  await writeFile(join(repo, "tests", "vendor", "vendor-detail.spec.ts"), "test\n", "utf8");

  const result = await publishTaskChanges(project, "task-test", "raw task text should be ignored");
  const subject = await gitOutput(repo, ["log", "-1", "--format=%s"]);

  assert.equal(result.committed, true);
  assert.equal(subject.trim(), "add vendor detail");
});

test("uses provider-generated commit subject when available", async () => {
  const root = await mkdtemp(join(tmpdir(), "herdr-git-ai-message-"));
  const project = join(root, "project");
  const remotes = join(root, "remotes");
  await mkdir(project);
  await mkdir(join(project, ".git"));
  await mkdir(remotes);

  const repo = await createRepository(project, remotes, "repo-a");
  await writeFile(join(repo, "feature.txt"), "feature\n", "utf8");

  let instruction = "";
  const result = await publishTaskChanges(project, "task-test", "raw task text should be ignored", {
    commitMessageProvider: fakeCommitMessageProvider("fix generated subject", (task) => {
      instruction = task.instruction;
    }),
    logPath: join(root, "commit-message.log"),
    workspacePath: join(root, "workspace")
  });
  const subject = await gitOutput(repo, ["log", "-1", "--format=%s"]);

  assert.equal(result.committed, true);
  assert.equal(subject.trim(), "fix generated subject");
  assert.match(instruction, /Describe the actual behavior changed/);
  assert.match(instruction, /Avoid generic subjects/);
  assert.doesNotMatch(instruction, /raw task text should be ignored/);
});

async function createRepository(project: string, remotes: string, name: string): Promise<string> {
  const repo = join(project, name);
  const remote = join(remotes, `${name}.git`);
  await mkdir(repo);
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "herdr@example.local"]);
  await git(repo, ["config", "user.name", "HerdR"]);
  await writeFile(join(repo, "README.md"), `# ${name}\n`, "utf8");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "Initial commit"]);

  await git(remotes, ["init", "--bare", `${name}.git`]);
  await git(repo, ["remote", "add", "origin", remote]);
  await git(repo, ["push", "-u", "origin", "main"]);
  return repo;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout;
}

function fakeCommitMessageProvider(subject: string, onTask?: (task: { instruction: string; logPath: string }) => void) {
  return {
    name: "fake",
    async start() {},
    async stop() {},
    async executeTask(task: { instruction: string; logPath: string }) {
      onTask?.(task);
      await appendFile(task.logPath, `HERDR_COMMIT_JSON {"subject":"${subject}"}\n`);
      return { success: true, exitCode: 0, summary: "ok" };
    },
    async streamLogs() {
      return () => undefined;
    },
    async cancelTask() {},
    async healthCheck() {
      return true;
    },
    async getStatus() {
      return { name: "fake", healthy: true, runningTasks: 0 };
    }
  };
}
