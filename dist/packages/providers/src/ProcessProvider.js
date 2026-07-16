"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProcessProvider = void 0;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const HerdRAdapter_1 = require("../../runtime/src/HerdRAdapter");
class ProcessProvider {
    config;
    name;
    processes = new Map();
    herdr = new HerdRAdapter_1.HerdRAdapter();
    constructor(name, config) {
        this.config = config;
        this.name = name;
    }
    async start() { }
    async stop() {
        for (const process of this.processes.values()) {
            process.kill("SIGTERM");
        }
        this.processes.clear();
    }
    async executeTask(task) {
        await (0, promises_1.mkdir)(task.workspacePath, { recursive: true });
        const promptPath = (0, node_path_1.join)(task.workspacePath, "task.md");
        await (0, promises_1.writeFile)(promptPath, task.instruction, "utf8");
        if ((await this.herdr.isAvailable()) && process.env.HERDR_PANE_ID) {
            return this.executeTaskInHerdRPane(task, promptPath);
        }
        return new Promise((resolve) => {
            const logStream = (0, node_fs_1.createWriteStream)(task.logPath, { flags: "a" });
            const cwd = providerCwd(task);
            const child = (0, node_child_process_1.spawn)(this.config.command, [...this.config.args, task.instruction], {
                cwd,
                env: { ...process.env, ...this.config.env },
                shell: false
            });
            this.processes.set(task.taskId, child);
            child.stdout.pipe(logStream, { end: false });
            child.stderr.pipe(logStream, { end: false });
            child.on("error", (error) => {
                logStream.write(`provider process error: ${error.message}\n`);
                logStream.end();
                this.processes.delete(task.taskId);
                resolve({ success: false, exitCode: 1, summary: error.message });
            });
            child.on("close", (code) => {
                logStream.end();
                this.processes.delete(task.taskId);
                resolve({
                    success: code === 0,
                    exitCode: code ?? 1,
                    summary: `${this.name} exited with ${code ?? 1}`
                });
            });
        });
    }
    async executeTaskInHerdRPane(task, promptPath) {
        if (this.config.interactive) {
            return this.executeInteractiveTaskInHerdRPane(task, promptPath);
        }
        const statusPath = (0, node_path_1.join)(task.workspacePath, ".provider-exit-code");
        const cwd = providerCwd(task);
        const statusTmpPath = `${statusPath}.tmp`;
        const providerCommand = `${shellQuote(this.config.command)} ${this.config.args.map(shellQuote).join(" ")} ${shellQuote(task.instruction)}`;
        const command = [
            "clear",
            `cd ${shellQuote(cwd)}`,
            `printf ${shellQuote(`${task.workerId} (${this.name})\n\n`)} | tee -a ${shellQuote(task.logPath)}`,
            `printf ${shellQuote(`Workspace: ${cwd}\nTask file: ${promptPath}\nLog: ${task.logPath}\n\nRunning provider...\n\n`)} | tee -a ${shellQuote(task.logPath)}`,
            `status_tmp=${shellQuote(statusTmpPath)}`,
            `{ ${providerCommand} 2>&1; printf '%s' "$?" > "$status_tmp"; } | tee -a ${shellQuote(task.logPath)}`,
            `code=$(cat "$status_tmp" 2>/dev/null || printf 1)`,
            `printf '\\n[%s] exited with %s\\n' ${shellQuote(this.name)} "$code" >> ${shellQuote(task.logPath)}`,
            `echo $code > ${shellQuote(statusPath)}`,
            this.config.keepPaneOpen
                ? `printf '\\n%s finished with exit code %s. Pane kept open for inspection.\\n' ${shellQuote(this.name)} "$code"`
                : `printf '\\n%s finished with exit code %s. Continuing orchestration.\\n' ${shellQuote(this.name)} "$code"`,
            this.config.keepPaneOpen ? 'exec "${SHELL:-/bin/sh}"' : "exit $code"
        ].join("; ");
        await this.herdr.createWorkerPane(task.workerId, command);
        const timeoutMs = this.config.timeoutMs ?? 30 * 60 * 1000;
        const exitCode = await waitForExitCode(statusPath, timeoutMs);
        if (exitCode === undefined) {
            const summary = `${task.workerId} timed out waiting for ${this.name} after ${timeoutMs}ms`;
            await (0, promises_1.appendFile)(task.logPath, `${summary}\n`, "utf8");
            return {
                success: false,
                exitCode: 124,
                summary
            };
        }
        return {
            success: exitCode === 0,
            exitCode,
            summary: `${task.workerId} completed by ${this.name} with exit code ${exitCode}`
        };
    }
    async executeInteractiveTaskInHerdRPane(task, promptPath) {
        const cwd = providerCwd(task);
        const timeoutMs = this.config.timeoutMs ?? 30 * 60 * 1000;
        await (0, promises_1.appendFile)(task.logPath, [
            `${task.workerId} (${this.name})`,
            "",
            `Workspace: ${cwd}`,
            `Task file: ${promptPath}`,
            `Log: ${task.logPath}`,
            "",
            "Starting HerdR agent with initial prompt...",
            ""
        ].join("\n"), "utf8");
        const completionMarker = interactiveCompletionMarker(task);
        const pane = await this.herdr.startAgent(task.workerId, cwd, [
            this.config.command,
            ...this.config.args,
            interactivePrompt(task, completionMarker)
        ]);
        await (0, promises_1.appendFile)(task.logPath, `started interactive ${this.name} agent ${pane.id} with initial prompt\n`, "utf8");
        const completed = await waitForInteractiveCompletion(this.herdr, pane.id, interactiveCompletionMarkers(task.instruction, completionMarker), timeoutMs);
        await (0, promises_1.appendFile)(task.logPath, `\n${await this.herdr.readAgent(pane.id)}\n`, "utf8");
        if (!completed) {
            const summary = `${task.workerId} timed out waiting for interactive ${this.name} after ${timeoutMs}ms`;
            await (0, promises_1.appendFile)(task.logPath, `${summary}\n`, "utf8");
            return {
                success: false,
                exitCode: 124,
                summary
            };
        }
        if (this.config.closePaneOnDone) {
            const closed = await this.herdr.closePane(pane.id);
            await (0, promises_1.appendFile)(task.logPath, `${closed ? "closed" : "failed to close"} interactive ${this.name} agent ${pane.id}\n`, "utf8");
        }
        const summary = `${task.workerId} completed by interactive ${this.name}`;
        await (0, promises_1.appendFile)(task.logPath, `${summary}\n`, "utf8");
        return {
            success: true,
            exitCode: 0,
            summary
        };
    }
    async streamLogs(_taskId, _onChunk) {
        return () => undefined;
    }
    async cancelTask(taskId) {
        this.processes.get(taskId)?.kill("SIGTERM");
        this.processes.delete(taskId);
    }
    async healthCheck() {
        return Boolean(this.config.command);
    }
    async getStatus() {
        return {
            name: this.name,
            healthy: await this.healthCheck(),
            runningTasks: this.processes.size
        };
    }
}
exports.ProcessProvider = ProcessProvider;
function providerCwd(task) {
    const metadataRoot = task.metadata.projectRoot;
    if (typeof metadataRoot === "string" && metadataRoot.trim())
        return metadataRoot;
    if (process.env.PI_ORCHESTRATION_PROJECT_ROOT)
        return process.env.PI_ORCHESTRATION_PROJECT_ROOT;
    return task.workspacePath;
}
function shellQuote(value) {
    return `'${value.replace(/'/g, "'\\''")}'`;
}
function interactivePrompt(task, completionMarker) {
    return [
        task.instruction,
        "",
        `When the assigned work is complete, end your final response with ${completionMarker} and stop working. Do not wait for more instructions.`
    ].join("\n");
}
async function waitForInteractiveCompletion(herdr, paneId, completionMarkers, timeoutMs) {
    const startedAt = Date.now();
    let sawWorking = false;
    while (Date.now() - startedAt < timeoutMs) {
        const transcript = await herdr.readAgent(paneId);
        if (completionMarkers.some((marker) => countOccurrences(transcript, marker) >= 2))
            return true;
        const status = await herdr.agentStatus(paneId);
        if (status === "working")
            sawWorking = true;
        if (sawWorking && (status === "done" || status === "idle"))
            return true;
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
}
function interactiveCompletionMarkers(instruction, completionMarker) {
    return [
        completionMarker,
        ...["HERDR_TRIBE_JSON", "HERDR_PLAN_JSON", "HERDR_CLARIFICATION_JSON", "HERDR_COMMIT_JSON"].filter((marker) => instruction.includes(marker))
    ];
}
function interactiveCompletionMarker(task) {
    return `HERDR_DONE_${safeMarkerPart(task.taskId)}_${safeMarkerPart(task.workerId)}`;
}
function safeMarkerPart(value) {
    return value.replace(/[^A-Za-z0-9]+/g, "_");
}
function countOccurrences(text, needle) {
    return text.split(needle).length - 1;
}
async function waitForExitCode(statusPath, timeoutMs) {
    const startedAt = Date.now();
    while (true) {
        try {
            const value = (await (0, promises_1.readFile)(statusPath, "utf8")).trim();
            if (/^\d+$/.test(value))
                return Number(value);
        }
        catch {
            // Wait for the provider pane command to finish and write the exit code.
        }
        if (Date.now() - startedAt >= timeoutMs)
            return undefined;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
}
