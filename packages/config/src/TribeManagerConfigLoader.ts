import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface TribeManagerProjectConfig {
  objective: string;
  objectiveId?: number;
  userId?: number;
}

export class TribeManagerConfigLoader {
  constructor(private readonly configPath = process.env.PI_ORCHESTRATION_TRIBE_MANAGER_PATH ?? "config/tribe-manager.yaml") {}

  async objectiveForProject(projectRoot: string): Promise<string | undefined> {
    return (await this.configForProject(projectRoot))?.objective;
  }

  async configForProject(projectRoot: string): Promise<TribeManagerProjectConfig | undefined> {
    const projects = await this.loadProjects();
    const normalizedRoot = resolve(projectRoot);
    const matchingPath = Object.keys(projects)
      .map((path) => resolve(path))
      .filter((path) => normalizedRoot === path || normalizedRoot.startsWith(`${path}/`))
      .sort((left, right) => right.length - left.length)[0];

    if (!matchingPath) return undefined;
    const config = projects[matchingPath];
    const objective = config?.objective.trim();
    return objective ? config : undefined;
  }

  private async loadProjects(): Promise<Record<string, TribeManagerProjectConfig>> {
    let text = "";
    try {
      text = await readFile(this.configPath, "utf8");
    } catch {
      return {};
    }

    const projects: Record<string, TribeManagerProjectConfig> = {};
    let section = "";
    let currentProject = "";

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.replace(/\s+#.*$/, "");
      if (!line.trim()) continue;

      const indent = rawLine.match(/^ */)?.[0].length ?? 0;
      const trimmed = line.trim();

      if (indent === 0 && trimmed.endsWith(":")) {
        section = trimmed.slice(0, -1);
        currentProject = "";
        continue;
      }

      if (section !== "projects") continue;

      if (indent === 2 && trimmed.endsWith(":")) {
        currentProject = stripQuotes(trimmed.slice(0, -1));
        projects[resolve(currentProject)] = { objective: "" };
        continue;
      }

      if (indent > 2 && currentProject) {
        const [key, ...rest] = trimmed.split(":");
        const value = stripQuotes(rest.join(":").trim());
        const config = projects[resolve(currentProject)];
        if (key.trim() === "objective") config.objective = value;
        if (key.trim() === "objective_id") config.objectiveId = Number(value);
        if (key.trim() === "user_id") config.userId = Number(value);
      }
    }

    return projects;
  }
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
