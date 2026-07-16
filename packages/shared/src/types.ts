export type RoleName = "task_manager" | "executor" | "validator";

export type WorkerStatus =
  | "pending"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type PlatformEventType =
  | "TaskReceived"
  | "WorkerStarted"
  | "WorkerFinished"
  | "WorkerFailed"
  | "ProgressUpdated"
  | "TaskAssigned"
  | "ClarificationRequired"
  | "PlanApprovalRequired"
  | "GitPublishApprovalRequired"
  | "ValidationFailed"
  | "ValidationPassed"
  | "RetryRequested"
  | "ApprovalRequired"
  | "TaskCancelled";

export interface PlatformEvent<TPayload = unknown> {
  id: string;
  type: PlatformEventType;
  timestamp: string;
  workerId?: string;
  payload: TPayload;
}

export interface ProviderConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  keepPaneOpen?: boolean;
  interactive?: boolean;
  closePaneOnDone?: boolean;
  timeoutMs?: number;
}

export interface RoleConfig {
  provider: string;
  replicas: number;
}

export interface PlatformConfig {
  roles: Record<RoleName, RoleConfig>;
  providers: Record<string, ProviderConfig>;
}

export interface ProviderTask {
  taskId: string;
  role: RoleName;
  workerId: string;
  instruction: string;
  workspacePath: string;
  logPath: string;
  metadata: Record<string, unknown>;
}

export interface ProviderExecutionResult {
  success: boolean;
  exitCode: number;
  summary: string;
  artifacts?: string[];
}

export interface ProviderStatus {
  name: string;
  healthy: boolean;
  runningTasks: number;
  message?: string;
}

export interface Subtask {
  id: string;
  title: string;
  description: string;
  roleHint: string;
  dependsOn: string[];
  filesHint: string[];
}

export interface TaskPlan {
  request: string;
  detectedTechnology: string[];
  subtasks: Subtask[];
  executorCount: number;
  acceptanceCriteria: string[];
}

export interface WorkerSnapshot {
  id: string;
  role: RoleName;
  status: WorkerStatus;
  currentTask?: string;
  progress: number;
}

export interface RunSummary {
  taskId: string;
  success: boolean;
  plan: TaskPlan;
  workers: WorkerSnapshot[];
  validationSummary: string;
  approvalRequired: boolean;
  gitPublish?: {
    attempted: boolean;
    committed: boolean;
    pushed: boolean;
    commit?: string;
    remotes: string[];
    repositories?: Array<{
      path: string;
      attempted: boolean;
      committed: boolean;
      pushed: boolean;
      commit?: string;
      remotes: string[];
      summary: string;
    }>;
    summary: string;
  };
  tribeManagerSync?: {
    inProgress: string;
    completion: string;
    taskId?: number;
  };
}
