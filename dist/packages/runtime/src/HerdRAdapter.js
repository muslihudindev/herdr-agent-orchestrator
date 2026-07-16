"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HerdRAdapter = void 0;
exports.parsePaneId = parsePaneId;
exports.parseAgentId = parseAgentId;
exports.parseAgentStatus = parseAgentStatus;
const node_child_process_1 = require("node:child_process");
const node_util_1 = require("node:util");
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
class HerdRAdapter {
    rootPaneId;
    constructor(rootPaneId = process.env.HERDR_PANE_ID) {
        this.rootPaneId = rootPaneId;
    }
    async isAvailable() {
        if (process.env.HERDR_ENV !== "1")
            return false;
        try {
            await execFileAsync("herdr", ["pane", "list"]);
            return true;
        }
        catch {
            return false;
        }
    }
    async createWorkerPane(label, command) {
        if (!(await this.isAvailable()) || !this.rootPaneId) {
            return { id: label, mode: "local" };
        }
        const { stdout } = await execFileAsync("herdr", [
            "pane",
            "split",
            this.rootPaneId,
            "--direction",
            "right",
            "--no-focus"
        ]);
        const paneId = parsePaneId(stdout) ?? label;
        await execFileAsync("herdr", ["pane", "run", paneId, command]);
        return { id: paneId, mode: "herdr" };
    }
    async startAgent(label, cwd, argv) {
        if (!(await this.isAvailable())) {
            return { id: label, mode: "local" };
        }
        const { stdout } = await execFileAsync("herdr", [
            "agent",
            "start",
            label,
            "--cwd",
            cwd,
            "--split",
            "right",
            "--no-focus",
            "--",
            ...argv
        ]);
        return { id: parsePaneId(stdout) ?? parseAgentId(stdout) ?? label, mode: "herdr" };
    }
    async readAgent(target, lines = 200) {
        try {
            const { stdout } = await execFileAsync("herdr", [
                "agent",
                "read",
                target,
                "--source",
                "recent-unwrapped",
                "--lines",
                String(lines)
            ]);
            return stdout;
        }
        catch {
            return "";
        }
    }
    async sendText(paneId, text) {
        await execFileAsync("herdr", ["pane", "send-text", paneId, text]);
    }
    async sendKeys(paneId, keys) {
        await execFileAsync("herdr", ["pane", "send-keys", paneId, keys]);
    }
    async waitForAgentDone(paneId, timeoutMs) {
        const startedAt = Date.now();
        let sawWorking = false;
        while (Date.now() - startedAt < timeoutMs) {
            const status = await this.agentStatus(paneId);
            if (status === "working")
                sawWorking = true;
            if (status === "done")
                return true;
            if (status === "idle" && (sawWorking || Date.now() - startedAt > 5000))
                return true;
            await sleep(1000);
        }
        return false;
    }
    async closePane(paneId) {
        try {
            await execFileAsync("herdr", ["pane", "close", paneId]);
            return true;
        }
        catch {
            return false;
        }
    }
    async agentStatus(paneId) {
        try {
            const { stdout } = await execFileAsync("herdr", ["pane", "get", paneId]);
            return parseAgentStatus(stdout, paneId);
        }
        catch {
            try {
                const { stdout } = await execFileAsync("herdr", ["pane", "list"]);
                return parseAgentStatus(stdout, paneId);
            }
            catch {
                return undefined;
            }
        }
    }
}
exports.HerdRAdapter = HerdRAdapter;
function parsePaneId(stdout) {
    try {
        const parsed = JSON.parse(stdout);
        return parsed.result?.pane?.pane_id ?? parsed.result?.pane?.id;
    }
    catch {
        return undefined;
    }
}
function parseAgentId(stdout) {
    try {
        const parsed = JSON.parse(stdout);
        return parsed.result?.agent?.pane_id
            ?? parsed.result?.agent?.terminal_id
            ?? parsed.result?.agent?.id
            ?? parsed.result?.pane?.pane_id
            ?? parsed.result?.pane?.id;
    }
    catch {
        return undefined;
    }
}
function parseAgentStatus(stdout, paneId) {
    try {
        const parsed = JSON.parse(stdout);
        return findAgentStatus(parsed, paneId);
    }
    catch {
        return undefined;
    }
}
function findAgentStatus(value, paneId) {
    if (!value || typeof value !== "object")
        return undefined;
    const record = value;
    const id = record.pane_id ?? record.id;
    const status = record.agent_status;
    if (id === paneId && typeof status === "string")
        return status;
    for (const child of Object.values(record)) {
        if (Array.isArray(child)) {
            for (const item of child) {
                const found = findAgentStatus(item, paneId);
                if (found)
                    return found;
            }
        }
        else if (child && typeof child === "object") {
            const found = findAgentStatus(child, paneId);
            if (found)
                return found;
        }
    }
    return undefined;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
