import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PaneHandle {
  id: string;
  mode: "herdr" | "local";
}

export class HerdRAdapter {
  constructor(private readonly rootPaneId = process.env.HERDR_PANE_ID) {}

  async isAvailable(): Promise<boolean> {
    if (process.env.HERDR_ENV !== "1") return false;
    try {
      await execFileAsync("herdr", ["pane", "list"]);
      return true;
    } catch {
      return false;
    }
  }

  async createWorkerPane(label: string, command: string): Promise<PaneHandle> {
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

  async startAgent(label: string, cwd: string, argv: string[]): Promise<PaneHandle> {
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

  async readAgent(target: string, lines = 200): Promise<string> {
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
    } catch {
      return "";
    }
  }

  async sendText(paneId: string, text: string): Promise<void> {
    await execFileAsync("herdr", ["pane", "send-text", paneId, text]);
  }

  async sendKeys(paneId: string, keys: string): Promise<void> {
    await execFileAsync("herdr", ["pane", "send-keys", paneId, keys]);
  }

  async waitForAgentDone(paneId: string, timeoutMs: number): Promise<boolean> {
    const startedAt = Date.now();
    let sawWorking = false;

    while (Date.now() - startedAt < timeoutMs) {
      const status = await this.agentStatus(paneId);
      if (status === "working") sawWorking = true;
      if (status === "done") return true;
      if (status === "idle" && (sawWorking || Date.now() - startedAt > 5000)) return true;

      await sleep(1000);
    }

    return false;
  }

  async closePane(paneId: string): Promise<boolean> {
    try {
      await execFileAsync("herdr", ["pane", "close", paneId]);
      return true;
    } catch {
      return false;
    }
  }

  async agentStatus(paneId: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync("herdr", ["pane", "get", paneId]);
      return parseAgentStatus(stdout, paneId);
    } catch {
      try {
        const { stdout } = await execFileAsync("herdr", ["pane", "list"]);
        return parseAgentStatus(stdout, paneId);
      } catch {
        return undefined;
      }
    }
  }
}

export function parsePaneId(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as {
      result?: {
        pane?: {
          pane_id?: string;
          id?: string;
        };
      };
    };
    return parsed.result?.pane?.pane_id ?? parsed.result?.pane?.id;
  } catch {
    return undefined;
  }
}

export function parseAgentId(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as {
      result?: {
        agent?: {
          pane_id?: string;
          terminal_id?: string;
          id?: string;
        };
        pane?: {
          pane_id?: string;
          id?: string;
        };
      };
    };
    return parsed.result?.agent?.pane_id
      ?? parsed.result?.agent?.terminal_id
      ?? parsed.result?.agent?.id
      ?? parsed.result?.pane?.pane_id
      ?? parsed.result?.pane?.id;
  } catch {
    return undefined;
  }
}

export function parseAgentStatus(stdout: string, paneId: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return findAgentStatus(parsed, paneId);
  } catch {
    return undefined;
  }
}

function findAgentStatus(value: unknown, paneId: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  const id = record.pane_id ?? record.id;
  const status = record.agent_status;
  if (id === paneId && typeof status === "string") return status;

  for (const child of Object.values(record)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = findAgentStatus(item, paneId);
        if (found) return found;
      }
    } else if (child && typeof child === "object") {
      const found = findAgentStatus(child, paneId);
      if (found) return found;
    }
  }

  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
