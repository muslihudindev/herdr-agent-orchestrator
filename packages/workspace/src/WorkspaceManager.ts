import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

export class WorkspaceManager {
  constructor(private readonly root = "workspace") {}

  async prepareRun(taskId: string): Promise<string> {
    const path = join(this.root, taskId);
    await mkdir(path, { recursive: true });
    return path;
  }

  async prepareWorker(taskId: string, workerId: string): Promise<string> {
    const path = join(this.root, taskId, workerId);
    await mkdir(path, { recursive: true });
    return path;
  }

  async cleanupRun(taskId: string): Promise<void> {
    await rm(join(this.root, taskId), { recursive: true, force: true });
  }
}
