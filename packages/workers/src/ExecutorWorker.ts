import { EventBus } from "../../event-bus/src/EventBus";
import { Provider } from "../../providers/src/Provider";
import { createId } from "../../shared/src/ids";
import { ProviderTask, Subtask, TaskPlan } from "../../shared/src/types";
import { BaseWorker } from "./BaseWorker";

export class ExecutorWorker extends BaseWorker {
  constructor(id: string, provider: Provider, eventBus: EventBus, logPath: string) {
    super(id, "executor", provider, eventBus, logPath);
  }

  async run(taskId: string, request: string, subtasks: Subtask[], workspacePath: string) {
    const characterization = subtasks.every((task) => task.assignmentType === "characterization_tests");
    const instruction = [
      characterization ? "You are a characterization-test Executor." : "You are an implementation Executor.",
      characterization
        ? "Your purpose is to protect current observable behavior before production code is changed."
        : "Implement only your assigned part of the approved plan.",
      "",
      "Rules:",
      "Make the smallest possible change.",
      "Do not perform unrelated refactoring.",
      "Do not rename unrelated code.",
      "Do not reformat unrelated files.",
      "Do not upgrade dependencies without approval.",
      "Do not change database schemas without approval.",
      "Do not change public APIs without approval.",
      "Do not change authorization behavior without approval.",
      "Do not change event payloads without approval.",
      "Do not delete or weaken existing tests to make the change pass.",
      "Do not modify files outside the assigned scope.",
      "Do not fix unrelated technical debt.",
      characterization ? "Do not modify production behavior." : "Preserve existing behavior listed in the regression matrix.",
      "When unrelated technical debt blocks the task, report it as a separate follow-up recommendation.",
      "Before editing shared code, search for callers and report the result.",
      "Before finishing, inspect your full diff and search again for callers of changed shared code.",
      "Do not run final validation for the full project; Validator owns final test/lint/build verification.",
      "",
      "Original user request:",
      request,
      "",
      "Assigned subtasks:",
      "",
      ...subtasks.map((task) => `- ${task.id}: ${task.title}\n  ${task.description}\n  Type: ${task.assignmentType ?? "implementation"}\n  Scope: ${JSON.stringify(task.fileScope ?? { allowedFiles: task.filesHint, allowedDirectories: [] })}`)
    ].join("\n");

    const providerTask: ProviderTask = {
      taskId: createId("provider"),
      role: "executor",
      workerId: this.id,
      instruction,
      workspacePath,
      logPath: this.logPath,
      metadata: { taskId, request, subtasks }
    };

    this.eventBus.publish("TaskAssigned", { workerId: this.id, subtasks }, this.id);
    return this.executeProviderTask(providerTask);
  }

  async repairValidationFailure(
    taskId: string,
    request: string,
    plan: TaskPlan,
    validationSummary: string,
    workspacePath: string
  ) {
    const instruction = [
      "You are an Executor assigned to repair a failed validation run.",
      "Fix only the finding-specific issue reported by Validator.",
      "Prefer the smallest code or test change that makes the existing acceptance criteria pass.",
      "Do not broadly rewrite the implementation.",
      "Do not modify files outside the approved repair scope.",
      "Do not run final validation for the full project; Validator owns final test/lint/build verification.",
      "Do not coordinate directly with other workers.",
      "",
      "Original user request:",
      request,
      "",
      "Validator failure summary:",
      validationSummary,
      "",
      "Original approved plan:",
      ...plan.subtasks.map((task) => `- ${task.id}: ${task.title}\n  ${task.description}`)
    ].join("\n");

    const repairSubtask: Subtask = {
      id: "repair-validation",
      title: "Repair validation failure",
      description: validationSummary,
      roleHint: "repair",
      dependsOn: [],
      filesHint: []
    };

    const providerTask: ProviderTask = {
      taskId: createId("provider"),
      role: "executor",
      workerId: this.id,
      instruction,
      workspacePath,
      logPath: this.logPath,
      metadata: { taskId, request, plan, validationSummary, repair: true }
    };

    this.eventBus.publish("RetryRequested", { taskId, workerId: this.id, validationSummary }, this.id);
    this.eventBus.publish("TaskAssigned", { workerId: this.id, subtasks: [repairSubtask] }, this.id);
    return this.executeProviderTask(providerTask);
  }
}
