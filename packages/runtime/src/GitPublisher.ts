import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Provider } from "../../providers/src/Provider";
import { createId } from "../../shared/src/ids";

const execFileAsync = promisify(execFile);

export interface GitPublishResult {
  attempted: boolean;
  committed: boolean;
  pushed: boolean;
  commit?: string;
  remotes: string[];
  repositories?: GitRepositoryPublishResult[];
  summary: string;
}

export interface GitRepositoryPublishResult {
  path: string;
  attempted: boolean;
  committed: boolean;
  pushed: boolean;
  commit?: string;
  remotes: string[];
  summary: string;
}

export interface GitPublishPreview {
  repositories: Array<{
    path: string;
    changed: boolean;
    remotes: string[];
    summary: string;
  }>;
  changedRepositories: number;
  summary: string;
}

export async function previewTaskChanges(projectRoot: string): Promise<GitPublishPreview> {
  const repositories = await discoverGitRepositories(projectRoot);
  const previews = [];
  for (const repository of repositories) {
    const porcelain = await gitOutput(repository, ["status", "--porcelain"]);
    const remotes = (await gitOutput(repository, ["remote"]))
      .split(/\r?\n/)
      .map((remote) => remote.trim())
      .filter(Boolean);
    const changed = Boolean(porcelain.trim());
    previews.push({
      path: repository,
      changed,
      remotes,
      summary: changed
        ? `${repository}: changes detected; remotes: ${remotes.join(", ") || "none"}`
        : `${repository}: no changes`
    });
  }

  const changedRepositories = previews.filter((preview) => preview.changed).length;
  return {
    repositories: previews,
    changedRepositories,
    summary: repositories.length
      ? `${changedRepositories}/${repositories.length} git repositor${repositories.length === 1 ? "y has" : "ies have"} changes`
      : "no git repositories found under project folder"
  };
}

export interface GitPublishOptions {
  commitMessageProvider?: Provider;
  logPath?: string;
  workspacePath?: string;
}

export async function publishTaskChanges(
  projectRoot: string,
  _taskId: string,
  _request: string,
  options: GitPublishOptions = {}
): Promise<GitPublishResult> {
  const repositories = await discoverGitRepositories(projectRoot);
  if (!repositories.length) {
    return skipped("no git repositories found under project folder");
  }

  const results = [];
  for (const repository of repositories) {
    results.push(await publishRepositoryChanges(repository, options));
  }

  const changed = results.filter((result) => result.attempted);
  const committed = results.filter((result) => result.committed);
  const pushed = results.filter((result) => result.pushed);

  if (!changed.length) {
    return {
      attempted: false,
      committed: false,
      pushed: false,
      remotes: [],
      repositories: results,
      summary: `git publish skipped: no changes in ${repositories.length} git repositor${repositories.length === 1 ? "y" : "ies"}`
    };
  }

  return {
    attempted: true,
    committed: committed.length === changed.length,
    pushed: pushed.length === changed.length,
    remotes: unique(results.flatMap((result) => result.remotes)),
    repositories: results,
    summary: `git publish: ${committed.length}/${changed.length} repos committed, ${pushed.length}/${changed.length} repos pushed`
  };
}

async function publishRepositoryChanges(projectRoot: string, options: GitPublishOptions): Promise<GitRepositoryPublishResult> {
  const porcelainBefore = await gitOutput(projectRoot, ["status", "--porcelain"]);
  if (!porcelainBefore.trim()) {
    return repositorySkipped(projectRoot, "no git changes to commit");
  }

  await git(projectRoot, ["add", "-A"]);
  const porcelainAfterAdd = await gitOutput(projectRoot, ["status", "--porcelain"]);
  if (!porcelainAfterAdd.trim()) {
    return repositorySkipped(projectRoot, "no staged git changes to commit");
  }

  const message = await commitMessage(projectRoot, options);
  try {
    await git(projectRoot, ["commit", "-m", message, ...commitHookArgs(projectRoot)]);
  } catch (error) {
    return {
      path: projectRoot,
      attempted: true,
      committed: false,
      pushed: false,
      remotes: [],
      summary: `git commit failed: ${errorMessage(error)}`
    };
  }

  const commit = (await gitOutput(projectRoot, ["rev-parse", "--short", "HEAD"])).trim();
  const branch = (await gitOutput(projectRoot, ["branch", "--show-current"])).trim();
  if (!branch) {
    return {
      path: projectRoot,
      attempted: true,
      committed: true,
      pushed: false,
      commit,
      remotes: [],
      summary: `committed ${commit}; push skipped because HEAD is detached`
    };
  }

  const remotes = (await gitOutput(projectRoot, ["remote"]))
    .split(/\r?\n/)
    .map((remote) => remote.trim())
    .filter(Boolean);

  if (!remotes.length) {
    return {
      path: projectRoot,
      attempted: true,
      committed: true,
      pushed: false,
      commit,
      remotes: [],
      summary: `committed ${commit}; push skipped because no git remotes are configured`
    };
  }

  const pushedRemotes: string[] = [];
  const failedPushes: string[] = [];
  for (const remote of remotes) {
    try {
      await git(projectRoot, ["push", remote, `HEAD:${branch}`]);
      pushedRemotes.push(remote);
    } catch (error) {
      failedPushes.push(`${remote}: ${errorMessage(error)}`);
    }
  }

  return {
    path: projectRoot,
    attempted: true,
    committed: true,
    pushed: failedPushes.length === 0,
    commit,
    remotes,
    summary: failedPushes.length
      ? `committed ${commit}; pushed to ${pushedRemotes.join(", ") || "no remotes"}; failed: ${failedPushes.join("; ")}`
      : `committed ${commit} and pushed ${branch} to ${remotes.join(", ")}`
  };
}

function commitHookArgs(projectRoot: string): string[] {
  return projectRoot.endsWith("/portal-vendor-fe") ? ["--no-verify"] : [];
}

async function discoverGitRepositories(projectRoot: string): Promise<string[]> {
  const repositories: string[] = [];
  await walk(projectRoot, repositories, 0);
  return repositories.sort((left, right) => left.length - right.length);
}

async function walk(directory: string, repositories: string[], depth: number): Promise<void> {
  if (depth > 5) return;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  if (entries.some((entry) => entry.name === ".git") && await isGitRepository(directory)) {
    repositories.push(directory);
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || shouldSkipDirectory(entry.name)) continue;
    const path = join(directory, entry.name);
    await walk(path, repositories, depth + 1);
  }
}

async function isGitRepository(projectRoot: string): Promise<boolean> {
  try {
    const output = await gitOutput(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
    return output.trim() === "true";
  } catch {
    return false;
  }
}

function skipped(reason: string): GitPublishResult {
  return {
    attempted: false,
    committed: false,
    pushed: false,
    remotes: [],
    summary: `git publish skipped: ${reason}`
  };
}

function repositorySkipped(path: string, reason: string): GitRepositoryPublishResult {
  return {
    path,
    attempted: false,
    committed: false,
    pushed: false,
    remotes: [],
    summary: `git publish skipped: ${reason}`
  };
}

async function git(projectRoot: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: projectRoot });
}

async function gitOutput(projectRoot: string, args: string): Promise<string>;
async function gitOutput(projectRoot: string, args: string[]): Promise<string>;
async function gitOutput(projectRoot: string, args: string | string[]): Promise<string> {
  const result = await execFileAsync("git", Array.isArray(args) ? args : [args], { cwd: projectRoot });
  return result.stdout;
}

async function commitMessage(projectRoot: string, options: GitPublishOptions): Promise<string> {
  const prefix = await commitPrefix(projectRoot);
  const message = await aiCommitSubject(projectRoot, options) ?? await generatedCommitSubject(projectRoot);
  return prefix && !/^[a-z]+(?:\([^)]+\))?!?: /i.test(message) ? `${prefix}: ${message}` : message;
}

async function aiCommitSubject(projectRoot: string, options: GitPublishOptions): Promise<string | undefined> {
  if (!options.commitMessageProvider || !options.workspacePath || !options.logPath) return undefined;

  const workspacePath = join(options.workspacePath, safePathPart(projectRoot));
  await mkdir(workspacePath, { recursive: true });
  await writeFile(options.logPath, "", { flag: "a" });
  const result = await options.commitMessageProvider.executeTask({
    taskId: createId("commit-message"),
    role: "validator",
    workerId: "commit-message",
    instruction: [
      "Generate one concise git commit subject from the staged code changes.",
      "Do not use the user task text. Use only the changed files and diff summary.",
      "Return only HERDR_COMMIT_JSON followed by one JSON object like {\"subject\":\"fix vendor verification button\"}.",
      "Subject rules: lowercase imperative, no period, max 72 characters.",
      "",
      await stagedDiffSummary(projectRoot)
    ].join("\n"),
    workspacePath,
    logPath: options.logPath,
    metadata: { projectRoot }
  });
  if (!result.success) return undefined;
  return sanitizeCommitSubject(await readCommitSubject(options.logPath));
}

async function stagedDiffSummary(projectRoot: string): Promise<string> {
  const [nameStatus, stat, diff] = await Promise.all([
    gitOutput(projectRoot, ["diff", "--cached", "--name-status"]),
    gitOutput(projectRoot, ["diff", "--cached", "--stat"]),
    gitOutput(projectRoot, ["diff", "--cached", "--unified=1", "--no-ext-diff"])
  ]);
  return [`Changed files:\n${nameStatus}`, `Diff stat:\n${stat}`, `Diff:\n${diff.slice(0, 12000)}`].join("\n\n");
}

async function readCommitSubject(logPath: string): Promise<string | undefined> {
  try {
    const text = await readFile(logPath, "utf8");
    const markerIndex = text.lastIndexOf("HERDR_COMMIT_JSON");
    if (markerIndex < 0) return undefined;
    const afterMarker = text.slice(markerIndex + "HERDR_COMMIT_JSON".length);
    const start = afterMarker.indexOf("{");
    const end = afterMarker.indexOf("}", start);
    if (start < 0 || end < start) return undefined;
    const parsed = JSON.parse(afterMarker.slice(start, end + 1)) as { subject?: unknown };
    return typeof parsed.subject === "string" ? parsed.subject : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeCommitSubject(subject: string | undefined): string | undefined {
  const clean = subject?.replace(/\s+/g, " ").trim().replace(/\.$/, "");
  return clean ? clean.slice(0, 72) : undefined;
}

async function generatedCommitSubject(projectRoot: string): Promise<string> {
  const entries = (await gitOutput(projectRoot, ["diff", "--cached", "--name-status"]))
    .split(/\r?\n/)
    .map(parseNameStatus)
    .filter((entry): entry is { status: string; path: string } => Boolean(entry));
  const action = entries.every((entry) => entry.status === "A")
    ? "add"
    : entries.every((entry) => entry.status === "D")
      ? "remove"
      : "update";
  return `${action} ${commitScope(entries.map((entry) => entry.path))}`;
}

function parseNameStatus(line: string): { status: string; path: string } | undefined {
  const [status, ...paths] = line.trim().split(/\s+/);
  const path = paths.at(-1);
  return status && path ? { status: status[0], path } : undefined;
}

function commitScope(paths: string[]): string {
  const tokens = paths.flatMap(pathTokens);
  const counts = tokens.reduce((map, token) => map.set(token, (map.get(token) ?? 0) + 1), new Map<string, number>());
  const ranked = unique(tokens)
    .sort((left, right) => (counts.get(right) ?? 0) - (counts.get(left) ?? 0))
    .slice(0, 3);
  return ranked.length ? ranked.join(" ") : "project files";
}

function pathTokens(path: string): string[] {
  return path
    .replace(/\.[^.]+$/, "")
    .split(/[/_.-]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length > 2 && !commitScopeStopWords.has(part));
}

function safePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, "_");
}

const commitScopeStopWords = new Set([
  "src",
  "app",
  "apps",
  "lib",
  "test",
  "tests",
  "spec",
  "index",
  "component",
  "components",
  "view",
  "views",
  "page",
  "pages",
  "utils",
  "helper",
  "helpers"
]);

async function commitPrefix(projectRoot: string): Promise<string | undefined> {
  try {
    const subjects = (await gitOutput(projectRoot, ["log", "-12", "--format=%s"]))
      .split(/\r?\n/)
      .map((line) => line.match(/^([a-z]+)(?:\([^)]+\))?!?: /i)?.[1]?.toLowerCase())
      .filter((prefix): prefix is string => Boolean(prefix));
    const counts = subjects.reduce((map, prefix) => map.set(prefix, (map.get(prefix) ?? 0) + 1), new Map<string, number>());
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  } catch {
    return undefined;
  }
}

function shouldSkipDirectory(name: string): boolean {
  return new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", ".pi", "logs", "workspace"]).has(name);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
