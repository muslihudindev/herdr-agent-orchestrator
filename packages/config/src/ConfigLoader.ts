import { readFile } from "node:fs/promises";
import { GitConfig, PlatformConfig, ProviderConfig, RoleConfig, RoleName, SafetyConfig, ValidationConfig } from "../../shared/src/types";

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
      providers: normalizeProviders(providersYaml.providers ?? {}),
      safety: normalizeSafety(providersText),
      validation: normalizeValidation(providersText),
      git: normalizeGit(providersText)
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

function normalizeSafety(text: string): SafetyConfig {
  const values = flatSectionValues(text, "safety");
  return {
    requireImpactAnalysis: bool(values["require_impact_analysis"], true),
    requireRegressionMatrix: bool(values["require_regression_matrix"], true),
    requireCharacterizationTestsForLegacyChanges: bool(values["require_characterization_tests_for_legacy_changes"], true),
    requireIndependentValidation: bool(values["require_independent_validation"], true),
    highRisk: {
      requireExplicitApproval: bool(values["high_risk.require_explicit_approval"], true),
      fileChangeThreshold: num(values["high_risk.file_change_threshold"], 15),
      lineChangeThreshold: num(values["high_risk.line_change_threshold"], 500),
      changeTypes: list(values["high_risk.change_types"], [
        "database_schema",
        "data_migration",
        "public_api",
        "authentication",
        "authorization",
        "payment",
        "event_payload",
        "dependency_upgrade",
        "destructive_operation",
        "breaking_change"
      ])
    }
  };
}

function normalizeValidation(text: string): ValidationConfig {
  const values = flatSectionValues(text, "validation");
  return {
    blockOnCriticalFindings: bool(values["block_on_critical_findings"], true),
    blockOnHighFindings: bool(values["block_on_high_findings"], true),
    failOnRequiredTestFailure: bool(values["fail_on_required_test_failure"], true),
    allowPartialValidation: bool(values["allow_partial_validation"], true),
    maximumRepairAttempts: num(values["maximum_repair_attempts"], 2)
  };
}

function normalizeGit(text: string): GitConfig {
  const values = flatSectionValues(text, "git");
  const publishMode = values["publish_mode"];
  return {
    publishMode: publishMode === "automatic_after_validation" || publishMode === "commit_only_after_approval" || publishMode === "disabled"
      ? publishMode
      : "manual_approval"
  };
}

function flatSectionValues(text: string, section: string): Record<string, string | string[]> {
  const values: Record<string, string | string[]> = {};
  const parents: string[] = [];
  let inSection = false;
  let lastKey = "";

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "");
    if (!line.trim()) continue;

    const indent = rawLine.match(/^ */)?.[0].length ?? 0;
    const trimmed = line.trim();
    if (indent === 0) {
      inSection = trimmed === `${section}:`;
      parents.length = 0;
      lastKey = "";
      continue;
    }
    if (!inSection) continue;
    if (indent === 2 && trimmed.endsWith(":")) {
      parents[0] = trimmed.slice(0, -1);
      parents.length = 1;
      lastKey = parents.join(".");
      continue;
    }
    if ((indent === 2 || indent === 4) && trimmed.includes(":")) {
      const [key, ...rest] = trimmed.split(":");
      const value = rest.join(":").trim();
      const parent = indent === 4 ? `${parents[0]}.` : "";
      lastKey = `${parent}${key.trim()}`;
      values[lastKey] = value === "[]" ? [] : value;
      continue;
    }
    if (indent >= 4 && trimmed.startsWith("- ")) {
      const current = values[lastKey];
      const items = Array.isArray(current) ? current : [];
      items.push(trimmed.slice(2).trim());
      values[lastKey] = items;
    }
  }

  return values;
}

function bool(value: string | string[] | undefined, fallback: boolean): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function num(value: string | string[] | undefined, fallback: number): number {
  return typeof value === "string" && /^\d+$/.test(value) ? Number(value) : fallback;
}

function list(value: string | string[] | undefined, fallback: string[]): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) return value.split(",").map((item) => item.trim()).filter(Boolean);
  return fallback;
}
