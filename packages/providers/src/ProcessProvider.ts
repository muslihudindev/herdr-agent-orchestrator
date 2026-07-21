import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createId } from "../../shared/src/ids";
import { ProviderConfig, ProviderExecutionResult, ProviderStatus, ProviderTask } from "../../shared/src/types";
import { HerdRAdapter } from "../../runtime/src/HerdRAdapter";
import { Provider } from "./Provider";

export class ProcessProvider implements Provider {
  readonly name: string;
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly herdr = new HerdRAdapter();

  constructor(name: string, private readonly config: ProviderConfig) {
    this.name = name;
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    for (const process of this.processes.values()) {
      process.kill("SIGTERM");
    }
    this.processes.clear();
  }

  async executeTask(task: ProviderTask): Promise<ProviderExecutionResult> {
    await mkdir(task.workspacePath, { recursive: true });
    const promptPath = join(task.workspacePath, "task.md");
    await writeFile(promptPath, task.instruction, "utf8");

    if ((await this.herdr.isAvailable()) && process.env.HERDR_PANE_ID) {
      return this.executeTaskInHerdRPane(task, promptPath);
    }

    return new Promise((resolve) => {
      const logStream = createWriteStream(task.logPath, { flags: "a" });
      const cwd = providerCwd(task);
      const child = spawn(this.config.command, [...this.config.args, task.instruction], {
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

  private async executeTaskInHerdRPane(task: ProviderTask, promptPath: string): Promise<ProviderExecutionResult> {
    if (this.config.interactive) {
      return this.executeInteractiveTaskInHerdRPane(task, promptPath);
    }

    const statusPath = join(task.workspacePath, ".provider-exit-code");
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
      await appendFile(task.logPath, `${summary}\n`, "utf8");
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

  private async executeInteractiveTaskInHerdRPane(task: ProviderTask, promptPath: string): Promise<ProviderExecutionResult> {
    const cwd = providerCwd(task);
    const timeoutMs = this.config.timeoutMs ?? 30 * 60 * 1000;
    await appendFile(
      task.logPath,
      [
        `${task.workerId} (${this.name})`,
        "",
        `Workspace: ${cwd}`,
        `Task file: ${promptPath}`,
        `Log: ${task.logPath}`,
        "",
        "Starting HerdR agent with initial prompt...",
        ""
      ].join("\n"),
      "utf8"
    );

    const completionMarker = interactiveCompletionMarker(task);
    const pane = await this.startInteractiveAgent(task, cwd, completionMarker);
    if (!pane) {
      const summary = `${task.workerId} failed to start interactive ${this.name}`;
      return { success: false, exitCode: 1, summary };
    }
    await appendFile(task.logPath, `started interactive ${this.name} agent ${pane.id} with initial prompt\n`, "utf8");

    const completed = await waitForInteractiveCompletion(
      this.herdr,
      pane.id,
      interactiveCompletionMarkers(task.instruction, completionMarker),
      timeoutMs
    );
    await appendFile(task.logPath, `\n${await this.herdr.readAgent(pane.id)}\n`, "utf8");
    if (!completed) {
      const summary = `${task.workerId} timed out waiting for interactive ${this.name} after ${timeoutMs}ms`;
      await appendFile(task.logPath, `${summary}\n`, "utf8");
      await this.closeInteractivePane(task, pane.id);
      return {
        success: false,
        exitCode: 124,
        summary
      };
    }

    await this.closeInteractivePane(task, pane.id);

    const summary = `${task.workerId} completed by interactive ${this.name}`;
    await appendFile(task.logPath, `${summary}\n`, "utf8");
    return {
      success: true,
      exitCode: 0,
      summary
    };
  }

  private async startInteractiveAgent(task: ProviderTask, cwd: string, completionMarker: string) {
    const agentLabel = herdrAgentLabel(task);
    await appendFile(task.logPath, `${task.workerId} starting interactive ${this.name} agent ${agentLabel}\n`, "utf8");
    try {
      return await this.herdr.startAgent(agentLabel, cwd, [
        this.config.command,
        ...this.config.args,
        interactivePrompt(task, completionMarker)
      ]);
    } catch (error) {
      await appendFile(
        task.logPath,
        `${task.workerId} failed to start interactive ${this.name} agent ${agentLabel}: ${errorMessage(error)}\n`,
        "utf8"
      );
      return undefined;
    }
  }

  private async closeInteractivePane(task: ProviderTask, paneId: string): Promise<void> {
    if (!this.config.closePaneOnDone) return;
    const closed = await this.herdr.closePane(paneId);
    await appendFile(
      task.logPath,
      `${closed ? "closed" : "failed to close"} interactive ${this.name} agent ${paneId}\n`,
      "utf8"
    );
  }

  async streamLogs(_taskId: string, _onChunk: (chunk: string) => void): Promise<() => void> {
    return () => undefined;
  }

  async cancelTask(taskId: string): Promise<void> {
    this.processes.get(taskId)?.kill("SIGTERM");
    this.processes.delete(taskId);
  }

  async healthCheck(): Promise<boolean> {
    return Boolean(this.config.command);
  }

  async getStatus(): Promise<ProviderStatus> {
    return {
      name: this.name,
      healthy: await this.healthCheck(),
      runningTasks: this.processes.size
    };
  }
}

function providerCwd(task: ProviderTask): string {
  const metadataRoot = task.metadata.projectRoot;
  if (typeof metadataRoot === "string" && metadataRoot.trim()) return metadataRoot;
  if (process.env.PI_ORCHESTRATION_PROJECT_ROOT) return process.env.PI_ORCHESTRATION_PROJECT_ROOT;
  return task.workspacePath;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function herdrAgentLabel(task: ProviderTask): string {
  return `${safeMarkerPart(task.workerId)}-${safeMarkerPart(task.taskId)}-${createId("spawn")}`;
}

function interactivePrompt(task: ProviderTask, completionMarker: string): string {
  return [
    task.instruction,
    "",
    `When the assigned work is complete, end your final response with ${completionMarker} and stop working. Do not wait for more instructions.`
  ].join("\n");
}

async function waitForInteractiveCompletion(
  herdr: HerdRAdapter,
  paneId: string,
  completionMarkers: string[],
  timeoutMs: number
): Promise<boolean> {
  const startedAt = Date.now();
  let sawWorking = false;
  while (Date.now() - startedAt < timeoutMs) {
    const transcript = await herdr.readAgent(paneId);
    if (completionMarkers.some((marker) => countOccurrences(transcript, marker) >= 2)) return true;
    const status = await herdr.agentStatus(paneId);
    if (status === "working") sawWorking = true;
    if (sawWorking && (status === "done" || status === "idle")) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

function interactiveCompletionMarkers(instruction: string, completionMarker: string): string[] {
  return [
    completionMarker,
    ...["HERDR_TRIBE_JSON", "HERDR_PLAN_JSON", "HERDR_CLARIFICATION_JSON", "HERDR_COMMIT_JSON"].filter((marker) =>
      instruction.includes(marker)
    )
  ];
}

function interactiveCompletionMarker(task: ProviderTask): string {
  return `HERDR_DONE_${safeMarkerPart(task.taskId)}_${safeMarkerPart(task.workerId)}`;
}

function safeMarkerPart(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, "_");
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

async function waitForExitCode(statusPath: string, timeoutMs: number): Promise<number | undefined> {
  const startedAt = Date.now();
  while (true) {
    try {
      const value = (await readFile(statusPath, "utf8")).trim();
      if (/^\d+$/.test(value)) return Number(value);
    } catch {
      // Wait for the provider pane command to finish and write the exit code.
    }
    if (Date.now() - startedAt >= timeoutMs) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
