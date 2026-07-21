export type RoleName = "task_manager" | "executor" | "validator";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type TaskPhase =
  | "queued"
  | "investigating"
  | "impact_analysis"
  | "regression_planning"
  | "awaiting_plan_approval"
  | "creating_baseline"
  | "baseline_validation"
  | "implementing"
  | "implementation_validation"
  | "regression_review"
  | "repairing"
  | "awaiting_publish_approval"
  | "publishing"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";

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
  | "TaskCancelled"
  | SafetyPlatformEventType;

export type SafetyPlatformEventType =
  | "task.investigation.started"
  | "task.investigation.completed"
  | "task.impact.completed"
  | "task.regression_matrix.completed"
  | "task.risk_approval.requested"
  | "task.risk_approval.received"
  | "task.baseline.started"
  | "task.baseline.passed"
  | "task.baseline.failed"
  | "executor.scope_violation"
  | "validation.started"
  | "validation.completed"
  | "validator.finding.created"
  | "validator.changes_requested"
  | "task.publish_approval.requested"
  | "task.publish_approval.received"
  | "git.publish.started"
  | "git.publish.completed"
  | "git.publish.failed";

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
  safety: SafetyConfig;
  validation: ValidationConfig;
  git: GitConfig;
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
  assignmentType?: ExecutorAssignmentType;
  fileScope?: FileScope;
  requiredValidation?: ValidationRecord[];
  validatorFindingIds?: string[];
  severity?: ValidatorFindingSeverity;
  regressionScenarioIds?: string[];
}

export interface TaskPlan {
  request: string;
  summary?: string;
  clarificationQuestions?: string[];
  detectedTechnology: string[];
  currentBehavior?: string[];
  requestedBehavior?: string[];
  impactAnalysis?: TaskSafetyAnalysis;
  regressionMatrix?: RegressionMatrixEntry[];
  riskLevel?: RiskLevel;
  approvalRequired?: boolean;
  approvalReasons?: string[];
  implementationPlan?: string[];
  baselineTestPlan?: ValidationRecord[];
  validationPlan?: ValidationRecord[];
  executorAssignments?: Subtask[];
  fileOwnership?: FileScope[];
  rollbackPlan?: string[];
  nonCodeTask?: boolean;
  characterizationRequired?: boolean;
  characterizationSkipReason?: string;
  subtasks: Subtask[];
  executorCount: number;
  acceptanceCriteria: string[];
}

export interface CodeReference {
  file: string;
  line?: number;
  symbol?: string;
  description?: string;
}

export interface ContractImpact {
  name: string;
  kind: "api" | "database" | "event" | "message" | "ui" | "other";
  impact: string;
  breaking: boolean;
}

export interface DatabaseImpact {
  table?: string;
  migrationRequired: boolean;
  description: string;
}

export interface EventImpact {
  name: string;
  payloadChanged: boolean;
  description: string;
}

export interface RegressionRisk {
  area: string;
  scenario: string;
  riskLevel: RiskLevel;
  reason: string;
}

export interface TestCoverageGap {
  area: string;
  scenario: string;
  requiredTestType: RegressionMatrixEntry["requiredTestType"];
  reason: string;
}

export interface TaskSafetyAnalysis {
  currentBehavior: string[];
  requestedBehavior: string[];
  entryPoints: CodeReference[];
  directDependencies: CodeReference[];
  indirectDependencies: CodeReference[];
  sharedCallers: CodeReference[];
  affectedRoles: string[];
  affectedStatuses: string[];
  apiContracts: ContractImpact[];
  databaseImpacts: DatabaseImpact[];
  eventImpacts: EventImpact[];
  uiImpacts: CodeReference[];
  regressionRisks: RegressionRisk[];
  testCoverageGaps: TestCoverageGap[];
  riskLevel: RiskLevel;
  approvalReasons: string[];
}

export interface RegressionMatrixEntry {
  id: string;
  area: string;
  scenario: string;
  existingBehavior: string;
  expectedBehaviorAfterChange: string;
  riskLevel: RiskLevel;
  requiredTestType: "unit" | "integration" | "contract" | "e2e" | "manual";
  relatedFiles: string[];
  coveredByTest?: string;
  validationStatus: "pending" | "passed" | "failed" | "skipped" | "not_applicable";
}

export interface ValidationRecord {
  command: string;
  category: "format" | "lint" | "typecheck" | "build" | "unit" | "integration" | "contract" | "e2e" | "security" | "custom";
  required: boolean;
  startedAt?: string;
  completedAt?: string;
  exitCode?: number;
  status: "pending" | "running" | "passed" | "failed" | "skipped" | "blocked";
  outputSummary?: string;
  skipReason?: string;
}

export type ExecutorAssignmentType = "characterization_tests" | "implementation" | "feature_tests" | "repair";

export interface FileScope {
  allowedFiles: string[];
  allowedDirectories: string[];
  readOnlyFiles?: string[];
  forbiddenFiles?: string[];
}

export type ValidatorFindingSeverity = "critical" | "high" | "medium" | "low" | "informational";

export interface ValidatorFinding {
  id: string;
  severity: ValidatorFindingSeverity;
  title: string;
  description: string;
  files: CodeReference[];
  regressionScenarioIds?: string[];
}

export interface RepairRequest {
  id: string;
  findingIds: string[];
  severity: ValidatorFindingSeverity;
  expectedCorrection: string;
  requiredValidation: ValidationRecord[];
  approvedScope: FileScope;
  regressionScenarioIds: string[];
}

export interface ValidatorResult {
  decision: "approved" | "approved_with_known_risks" | "changes_requested" | "blocked";
  validationStatus: "fully_validated" | "partially_validated" | "validation_failed" | "validation_blocked";
  findings: ValidatorFinding[];
  commands: ValidationRecord[];
  regressionMatrixResults: RegressionMatrixEntry[];
  changedFiles: string[];
  scopeViolations: string[];
  remainingRisks: string[];
  requiredRepairs: RepairRequest[];
}

export interface SafetyConfig {
  requireImpactAnalysis: boolean;
  requireRegressionMatrix: boolean;
  requireCharacterizationTestsForLegacyChanges: boolean;
  requireIndependentValidation: boolean;
  highRisk: {
    requireExplicitApproval: boolean;
    fileChangeThreshold: number;
    lineChangeThreshold: number;
    changeTypes: string[];
  };
}

export interface ValidationConfig {
  blockOnCriticalFindings: boolean;
  blockOnHighFindings: boolean;
  failOnRequiredTestFailure: boolean;
  allowPartialValidation: boolean;
  maximumRepairAttempts: number;
}

export interface GitConfig {
  publishMode: "manual_approval" | "automatic_after_validation" | "commit_only_after_approval" | "disabled";
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
  phase?: TaskPhase;
  safetyAnalysis?: TaskSafetyAnalysis;
  regressionMatrix?: RegressionMatrixEntry[];
  baselineValidation?: ValidationRecord[];
  finalValidation?: ValidationRecord[];
  validatorDecision?: ValidatorResult;
  approvedFileScope?: FileScope[];
  actualChangedFiles?: string[];
  publishApproval?: "pending" | "approved" | "rejected" | "not_required";
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
