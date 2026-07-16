"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.previewTaskChanges = previewTaskChanges;
exports.publishTaskChanges = publishTaskChanges;
const node_child_process_1 = require("node:child_process");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const node_util_1 = require("node:util");
const ids_1 = require("../../shared/src/ids");
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
async function previewTaskChanges(projectRoot) {
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
async function publishTaskChanges(projectRoot, _taskId, _request, options = {}) {
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
async function publishRepositoryChanges(projectRoot, options) {
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
    }
    catch (error) {
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
    const pushedRemotes = [];
    const failedPushes = [];
    for (const remote of remotes) {
        try {
            await git(projectRoot, ["push", remote, `HEAD:${branch}`]);
            pushedRemotes.push(remote);
        }
        catch (error) {
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
function commitHookArgs(projectRoot) {
    return projectRoot.endsWith("/portal-vendor-fe") ? ["--no-verify"] : [];
}
async function discoverGitRepositories(projectRoot) {
    const repositories = [];
    await walk(projectRoot, repositories, 0);
    return repositories.sort((left, right) => left.length - right.length);
}
async function walk(directory, repositories, depth) {
    if (depth > 5)
        return;
    let entries;
    try {
        entries = await (0, promises_1.readdir)(directory, { withFileTypes: true });
    }
    catch {
        return;
    }
    if (entries.some((entry) => entry.name === ".git") && await isGitRepository(directory)) {
        repositories.push(directory);
    }
    for (const entry of entries) {
        if (!entry.isDirectory() || shouldSkipDirectory(entry.name))
            continue;
        const path = (0, node_path_1.join)(directory, entry.name);
        await walk(path, repositories, depth + 1);
    }
}
async function isGitRepository(projectRoot) {
    try {
        const output = await gitOutput(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
        return output.trim() === "true";
    }
    catch {
        return false;
    }
}
function skipped(reason) {
    return {
        attempted: false,
        committed: false,
        pushed: false,
        remotes: [],
        summary: `git publish skipped: ${reason}`
    };
}
function repositorySkipped(path, reason) {
    return {
        path,
        attempted: false,
        committed: false,
        pushed: false,
        remotes: [],
        summary: `git publish skipped: ${reason}`
    };
}
async function git(projectRoot, args) {
    await execFileAsync("git", args, { cwd: projectRoot });
}
async function gitOutput(projectRoot, args) {
    const result = await execFileAsync("git", Array.isArray(args) ? args : [args], { cwd: projectRoot });
    return result.stdout;
}
async function commitMessage(projectRoot, options) {
    const prefix = await commitPrefix(projectRoot);
    const message = await aiCommitSubject(projectRoot, options) ?? await generatedCommitSubject(projectRoot);
    return prefix && !/^[a-z]+(?:\([^)]+\))?!?: /i.test(message) ? `${prefix}: ${message}` : message;
}
async function aiCommitSubject(projectRoot, options) {
    if (!options.commitMessageProvider || !options.workspacePath || !options.logPath)
        return undefined;
    const workspacePath = (0, node_path_1.join)(options.workspacePath, safePathPart(projectRoot));
    await (0, promises_1.mkdir)(workspacePath, { recursive: true });
    await (0, promises_1.writeFile)(options.logPath, "", { flag: "a" });
    const result = await options.commitMessageProvider.executeTask({
        taskId: (0, ids_1.createId)("commit-message"),
        role: "validator",
        workerId: "commit-message",
        instruction: [
            "Generate one informative git commit subject from the staged code changes.",
            "Do not use the user task text. Use only the changed files and diff summary.",
            "Describe the actual behavior changed, not just files touched.",
            "Prefer specific domain nouns, functions, routes, components, or tests visible in the diff.",
            "Avoid generic subjects like update project files, update vendor detail, add tests, or fix bug.",
            "Return only HERDR_COMMIT_JSON followed by one JSON object like {\"subject\":\"fix vendor verification button\"}.",
            "Subject rules: lowercase imperative, no period, max 72 characters.",
            "",
            await stagedDiffSummary(projectRoot)
        ].join("\n"),
        workspacePath,
        logPath: options.logPath,
        metadata: { projectRoot }
    });
    if (!result.success)
        return undefined;
    return sanitizeCommitSubject(await readCommitSubject(options.logPath));
}
async function stagedDiffSummary(projectRoot) {
    const [nameStatus, stat, diff] = await Promise.all([
        gitOutput(projectRoot, ["diff", "--cached", "--name-status"]),
        gitOutput(projectRoot, ["diff", "--cached", "--stat"]),
        gitOutput(projectRoot, ["diff", "--cached", "--unified=1", "--no-ext-diff"])
    ]);
    return [`Changed files:\n${nameStatus}`, `Diff stat:\n${stat}`, `Diff:\n${diff.slice(0, 12000)}`].join("\n\n");
}
async function readCommitSubject(logPath) {
    try {
        const text = await (0, promises_1.readFile)(logPath, "utf8");
        const markerIndex = text.lastIndexOf("HERDR_COMMIT_JSON");
        if (markerIndex < 0)
            return undefined;
        const afterMarker = text.slice(markerIndex + "HERDR_COMMIT_JSON".length);
        const start = afterMarker.indexOf("{");
        const end = afterMarker.indexOf("}", start);
        if (start < 0 || end < start)
            return undefined;
        const parsed = JSON.parse(afterMarker.slice(start, end + 1));
        return typeof parsed.subject === "string" ? parsed.subject : undefined;
    }
    catch {
        return undefined;
    }
}
function sanitizeCommitSubject(subject) {
    const clean = subject?.replace(/\s+/g, " ").trim().replace(/\.$/, "");
    return clean ? clean.slice(0, 72) : undefined;
}
async function generatedCommitSubject(projectRoot) {
    const entries = (await gitOutput(projectRoot, ["diff", "--cached", "--name-status"]))
        .split(/\r?\n/)
        .map(parseNameStatus)
        .filter((entry) => Boolean(entry));
    const action = entries.every((entry) => entry.status === "A")
        ? "add"
        : entries.every((entry) => entry.status === "D")
            ? "remove"
            : "update";
    return `${action} ${commitScope(entries.map((entry) => entry.path))}`;
}
function parseNameStatus(line) {
    const [status, ...paths] = line.trim().split(/\s+/);
    const path = paths.at(-1);
    return status && path ? { status: status[0], path } : undefined;
}
function commitScope(paths) {
    const tokens = paths.flatMap(pathTokens);
    const counts = tokens.reduce((map, token) => map.set(token, (map.get(token) ?? 0) + 1), new Map());
    const ranked = unique(tokens)
        .sort((left, right) => (counts.get(right) ?? 0) - (counts.get(left) ?? 0))
        .slice(0, 3);
    return ranked.length ? ranked.join(" ") : "project files";
}
function pathTokens(path) {
    return path
        .replace(/\.[^.]+$/, "")
        .split(/[/_.-]+/)
        .map((part) => part.toLowerCase())
        .filter((part) => part.length > 2 && !commitScopeStopWords.has(part));
}
function safePathPart(value) {
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
async function commitPrefix(projectRoot) {
    try {
        const subjects = (await gitOutput(projectRoot, ["log", "-12", "--format=%s"]))
            .split(/\r?\n/)
            .map((line) => line.match(/^([a-z]+)(?:\([^)]+\))?!?: /i)?.[1]?.toLowerCase())
            .filter((prefix) => Boolean(prefix));
        const counts = subjects.reduce((map, prefix) => map.set(prefix, (map.get(prefix) ?? 0) + 1), new Map());
        return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    }
    catch {
        return undefined;
    }
}
function shouldSkipDirectory(name) {
    return new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", ".pi", "logs", "workspace"]).has(name);
}
function unique(values) {
    return [...new Set(values)];
}
function errorMessage(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
