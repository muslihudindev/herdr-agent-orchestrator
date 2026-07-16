import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProviderConfig, ProviderExecutionResult, ProviderStatus, ProviderTask } from "../../shared/src/types";
import { Provider } from "./Provider";

export class SimulatedProvider implements Provider {
  readonly name: string;
  private readonly running = new Set<string>();

  constructor(name: string, private readonly config: ProviderConfig) {
    this.name = name;
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    this.running.clear();
  }

  async executeTask(task: ProviderTask): Promise<ProviderExecutionResult> {
    this.running.add(task.taskId);
    await mkdir(task.workspacePath, { recursive: true });
    await appendFile(task.logPath, `[${this.name}] starting ${task.workerId}\n${task.instruction}\n`);

    const artifact = join(task.workspacePath, `${task.workerId}-result.md`);
    await writeFile(
      artifact,
      [
        `# ${task.workerId}`,
        "",
        `Role: ${task.role}`,
        "",
        "Instruction",
        "",
        task.instruction,
        "",
        "Result",
        "",
        "Simulated provider completed the assigned work. Replace the provider in config to run a real coding agent."
      ].join("\n"),
      "utf8"
    );

    await appendFile(task.logPath, `[${this.name}] completed ${task.workerId}\n`);
    this.running.delete(task.taskId);
    return {
      success: true,
      exitCode: 0,
      summary: `${task.workerId} completed by ${this.name}`,
      artifacts: [artifact]
    };
  }

  async streamLogs(_taskId: string, _onChunk: (chunk: string) => void): Promise<() => void> {
    return () => undefined;
  }

  async cancelTask(taskId: string): Promise<void> {
    this.running.delete(taskId);
  }

  async healthCheck(): Promise<boolean> {
    return Boolean(this.config.command);
  }

  async getStatus(): Promise<ProviderStatus> {
    return {
      name: this.name,
      healthy: await this.healthCheck(),
      runningTasks: this.running.size
    };
  }
}
