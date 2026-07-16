import { ProviderExecutionResult, ProviderStatus, ProviderTask } from "../../shared/src/types";

export interface Provider {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  executeTask(task: ProviderTask): Promise<ProviderExecutionResult>;
  streamLogs(taskId: string, onChunk: (chunk: string) => void): Promise<() => void>;
  cancelTask(taskId: string): Promise<void>;
  healthCheck(): Promise<boolean>;
  getStatus(): Promise<ProviderStatus>;
}
