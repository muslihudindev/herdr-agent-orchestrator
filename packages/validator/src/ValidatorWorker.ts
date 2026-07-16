import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { EventBus } from "../../event-bus/src/EventBus";
import { Provider } from "../../providers/src/Provider";
import { createId } from "../../shared/src/ids";
import { ProviderTask, TaskPlan } from "../../shared/src/types";
import { BaseWorker } from "../../workers/src/BaseWorker";

export class ValidatorWorker extends BaseWorker {
  constructor(provider: Provider, eventBus: EventBus, logPath: string) {
    super("validator", "validator", provider, eventBus, logPath);
  }

  async validate(taskId: string, plan: TaskPlan, workspacePath: string) {
    const packageJsonExists = await exists("package.json");
    const instruction = [
      "You are the Validator. Review completed work, run available checks, and verify acceptance criteria.",
      "Task Manager must not run tests. Executors may add or update tests. You own final verification.",
      "Check that changes for the requested user role do not regress or unintentionally change behavior for other user roles.",
      packageJsonExists ? "Run the project's configured tests, lint, and build commands when available." : "No package.json found; perform repository-level validation.",
      "",
      "Acceptance criteria:",
      ...plan.acceptanceCriteria.map((item) => `- ${item}`)
    ].join("\n");

    const providerTask: ProviderTask = {
      taskId: createId("provider"),
      role: "validator",
      workerId: this.id,
      instruction,
      workspacePath,
      logPath: this.logPath,
      metadata: { taskId, plan }
    };

    const result = await normalizeValidationResult(await this.executeProviderTask(providerTask), this.logPath);
    this.eventBus.publish(result.success ? "ValidationPassed" : "ValidationFailed", { taskId, result }, this.id);
    return result;
  }
}

async function normalizeValidationResult<T extends { success: boolean; exitCode: number; summary: string }>(result: T, logPath: string): Promise<T> {
  if (!result.success) return result;
  try {
    const text = await readFile(logPath, "utf8");
    const lastValidation = text.slice(Math.max(0, text.lastIndexOf("Validation result:")));
    if (/\bnot accepted\b|\bvalidation failed\b|Validation Failed/i.test(lastValidation)) {
      return { ...result, success: false, exitCode: result.exitCode || 1, summary: summarizeValidatorRejection(lastValidation) };
    }
  } catch {
    return result;
  }
  return result;
}

function summarizeValidatorRejection(text: string): string {
  const clean = text
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split(/\n\[codex\] exited with|\nworker validator started/)[0]
    .trim();
  const lines = clean.split(/\r?\n/).filter((line) => line.trim()).slice(0, 14);
  return `Validator rejected work:\n${lines.join("\n")}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(join(".", path));
    return true;
  } catch {
    return false;
  }
}
