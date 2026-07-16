"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigLoader = void 0;
const promises_1 = require("node:fs/promises");
class ConfigLoader {
    rolesPath;
    providersPath;
    constructor(rolesPath = process.env.PI_ORCHESTRATION_ROLES_PATH ?? "config/roles.yaml", providersPath = process.env.PI_ORCHESTRATION_PROVIDERS_PATH ?? "config/providers.yaml") {
        this.rolesPath = rolesPath;
        this.providersPath = providersPath;
    }
    async load() {
        const [rolesText, providersText] = await Promise.all([
            (0, promises_1.readFile)(this.rolesPath, "utf8"),
            (0, promises_1.readFile)(this.providersPath, "utf8")
        ]);
        const rolesYaml = parseSimpleYaml(rolesText);
        const providersYaml = parseSimpleYaml(providersText);
        return {
            roles: normalizeRoles(rolesYaml.roles ?? {}),
            providers: normalizeProviders(providersYaml.providers ?? {})
        };
    }
}
exports.ConfigLoader = ConfigLoader;
function normalizeRoles(input) {
    const required = ["task_manager", "executor", "validator"];
    const roles = {};
    for (const name of required) {
        const item = input[name];
        if (!item) {
            throw new Error(`Missing role config: ${name}`);
        }
        roles[name] = {
            provider: String(item.provider),
            replicas: Number(item.replicas)
        };
    }
    return roles;
}
function normalizeProviders(input) {
    const providers = {};
    for (const [name, item] of Object.entries(input)) {
        providers[name] = {
            command: String(item.command),
            args: Array.isArray(item.args) ? item.args.map(String) : [],
            env: {},
            keepPaneOpen: item.keepPaneOpen === "true",
            interactive: item.interactive === "true",
            closePaneOnDone: item.closePaneOnDone === "true",
            timeoutMs: item.timeoutMs === undefined ? undefined : Number(item.timeoutMs)
        };
    }
    return providers;
}
function parseSimpleYaml(text) {
    const root = {};
    let section = "";
    let item = "";
    let lastKey = "";
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.replace(/\s+#.*$/, "");
        if (!line.trim())
            continue;
        const indent = rawLine.match(/^ */)?.[0].length ?? 0;
        const trimmed = line.trim();
        if (indent === 0 && trimmed.endsWith(":")) {
            section = trimmed.slice(0, -1);
            root[section] = {};
            continue;
        }
        if (indent === 2 && trimmed.endsWith(":")) {
            item = trimmed.slice(0, -1);
            root[section][item] = {};
            continue;
        }
        if (indent === 4) {
            const [key, ...rest] = trimmed.split(":");
            lastKey = key.trim();
            const value = rest.join(":").trim();
            root[section][item][lastKey] = value === "[]" ? [] : coerceValue(value);
            continue;
        }
        if (indent === 6 && trimmed.startsWith("- ")) {
            const existing = root[section][item][lastKey];
            const list = Array.isArray(existing) ? existing : [];
            list.push(trimmed.slice(2).trim());
            root[section][item][lastKey] = list;
        }
    }
    return root;
}
function coerceValue(value) {
    if (/^\d+$/.test(value))
        return Number(value);
    return value;
}
