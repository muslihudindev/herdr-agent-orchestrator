"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TribeManagerConfigLoader = void 0;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
class TribeManagerConfigLoader {
    configPath;
    constructor(configPath = process.env.PI_ORCHESTRATION_TRIBE_MANAGER_PATH ?? "config/tribe-manager.yaml") {
        this.configPath = configPath;
    }
    async objectiveForProject(projectRoot) {
        return (await this.configForProject(projectRoot))?.objective;
    }
    async configForProject(projectRoot) {
        const projects = await this.loadProjects();
        const normalizedRoot = (0, node_path_1.resolve)(projectRoot);
        const matchingPath = Object.keys(projects)
            .map((path) => (0, node_path_1.resolve)(path))
            .filter((path) => normalizedRoot === path || normalizedRoot.startsWith(`${path}/`))
            .sort((left, right) => right.length - left.length)[0];
        if (!matchingPath)
            return undefined;
        const config = projects[matchingPath];
        const objective = config?.objective.trim();
        return objective ? config : undefined;
    }
    async loadProjects() {
        let text = "";
        try {
            text = await (0, promises_1.readFile)(this.configPath, "utf8");
        }
        catch {
            return {};
        }
        const projects = {};
        let section = "";
        let currentProject = "";
        for (const rawLine of text.split(/\r?\n/)) {
            const line = rawLine.replace(/\s+#.*$/, "");
            if (!line.trim())
                continue;
            const indent = rawLine.match(/^ */)?.[0].length ?? 0;
            const trimmed = line.trim();
            if (indent === 0 && trimmed.endsWith(":")) {
                section = trimmed.slice(0, -1);
                currentProject = "";
                continue;
            }
            if (section !== "projects")
                continue;
            if (indent === 2 && trimmed.endsWith(":")) {
                currentProject = stripQuotes(trimmed.slice(0, -1));
                projects[(0, node_path_1.resolve)(currentProject)] = { objective: "" };
                continue;
            }
            if (indent > 2 && currentProject) {
                const [key, ...rest] = trimmed.split(":");
                const value = stripQuotes(rest.join(":").trim());
                const config = projects[(0, node_path_1.resolve)(currentProject)];
                if (key.trim() === "objective")
                    config.objective = value;
                if (key.trim() === "objective_id")
                    config.objectiveId = Number(value);
                if (key.trim() === "user_id")
                    config.userId = Number(value);
            }
        }
        return projects;
    }
}
exports.TribeManagerConfigLoader = TribeManagerConfigLoader;
function stripQuotes(value) {
    const trimmed = value.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}
