import { readFile } from "node:fs/promises";
import { PlatformConfig, ProviderConfig, RoleConfig, RoleName } from "../../shared/src/types";

type ParsedYaml = Record<string, Record<string, Record<string, string | number | string[]>>>;

export class ConfigLoader {
  constructor(
    private readonly rolesPath = process.env.PI_ORCHESTRATION_ROLES_PATH ?? "config/roles.yaml",
    private readonly providersPath = process.env.PI_ORCHESTRATION_PROVIDERS_PATH ?? "config/providers.yaml"
  ) {}

  async load(): Promise<PlatformConfig> {
    const [rolesText, providersText] = await Promise.all([
      readFile(this.rolesPath, "utf8"),
      readFile(this.providersPath, "utf8")
    ]);

    const rolesYaml = parseSimpleYaml(rolesText);
    const providersYaml = parseSimpleYaml(providersText);

    return {
      roles: normalizeRoles(rolesYaml.roles ?? {}),
      providers: normalizeProviders(providersYaml.providers ?? {})
    };
  }
}

function normalizeRoles(input: Record<string, Record<string, string | number | string[]>>): Record<RoleName, RoleConfig> {
  const required: RoleName[] = ["task_manager", "executor", "validator"];
  const roles = {} as Record<RoleName, RoleConfig>;

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

function normalizeProviders(input: Record<string, Record<string, string | number | string[]>>): Record<string, ProviderConfig> {
  const providers: Record<string, ProviderConfig> = {};

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

function parseSimpleYaml(text: string): ParsedYaml {
  const root: ParsedYaml = {};
  let section = "";
  let item = "";
  let lastKey = "";

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "");
    if (!line.trim()) continue;

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

function coerceValue(value: string): string | number | string[] {
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}
