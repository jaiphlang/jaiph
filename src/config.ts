import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

type TomlPrimitive = string | number | boolean;
type TomlSection = Record<string, TomlPrimitive>;
type TomlDoc = Record<string, TomlSection>;

export type JaiphConfig = {
  agent?: {
    defaultModel?: string;
    command?: string;
  };
  run?: {
    debug?: boolean;
    logsDir?: string;
  };
};

function parseTomlValue(raw: string): TomlPrimitive {
  const trimmed = raw.trim();
  if ((trimmed.startsWith(`"`) && trimmed.endsWith(`"`)) || (trimmed.startsWith(`'`) && trimmed.endsWith(`'`))) {
    return trimmed.slice(1, -1).replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, `"`).replace(/\\\\/g, `\\`);
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  return trimmed;
}

function parseToml(source: string): TomlDoc {
  const doc: TomlDoc = {};
  let currentSection = "";
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      currentSection = line.slice(1, -1).trim().toLowerCase();
      if (!doc[currentSection]) {
        doc[currentSection] = {};
      }
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!match) {
      continue;
    }
    const key = match[1].trim();
    const value = parseTomlValue(match[2]);
    if (!doc[currentSection]) {
      doc[currentSection] = {};
    }
    doc[currentSection][key] = value;
  }
  return doc;
}

function toConfig(doc: TomlDoc): JaiphConfig {
  const agentSection = doc.agent ?? {};
  const runSection = doc.run ?? {};
  const cfg: JaiphConfig = {};
  if (typeof agentSection.default_model === "string" || typeof agentSection.command === "string") {
    cfg.agent = {};
    if (typeof agentSection.default_model === "string") {
      cfg.agent.defaultModel = agentSection.default_model;
    }
    if (typeof agentSection.command === "string") {
      cfg.agent.command = agentSection.command;
    }
  }
  if (typeof runSection.debug === "boolean" || typeof runSection.logs_dir === "string") {
    cfg.run = {};
    if (typeof runSection.debug === "boolean") {
      cfg.run.debug = runSection.debug;
    }
    if (typeof runSection.logs_dir === "string") {
      cfg.run.logsDir = runSection.logs_dir;
    }
  }
  return cfg;
}

function mergeConfig(base: JaiphConfig, override: JaiphConfig): JaiphConfig {
  const out: JaiphConfig = {
    agent: { ...(base.agent ?? {}) },
    run: { ...(base.run ?? {}) },
  };
  if (override.agent) {
    out.agent = { ...(out.agent ?? {}), ...override.agent };
  }
  if (override.run) {
    out.run = { ...(out.run ?? {}), ...override.run };
  }
  if (out.agent && Object.keys(out.agent).length === 0) {
    delete out.agent;
  }
  if (out.run && Object.keys(out.run).length === 0) {
    delete out.run;
  }
  return out;
}

function readConfigFile(path: string): JaiphConfig {
  if (!existsSync(path)) {
    return {};
  }
  const source = readFileSync(path, "utf8");
  return toConfig(parseToml(source));
}

export function resolveConfigPaths(workspaceRoot: string): { globalPath?: string; localPath: string } {
  const xdg = process.env.XDG_CONFIG_HOME;
  const home = process.env.HOME;
  const globalPath = xdg ? join(xdg, "jaiph", "config.toml") : (home ? join(home, ".config", "jaiph", "config.toml") : undefined);
  return {
    globalPath,
    localPath: join(resolve(workspaceRoot), ".jaiph", "config.toml"),
  };
}

export function loadJaiphConfig(workspaceRoot: string): JaiphConfig {
  const { globalPath, localPath } = resolveConfigPaths(workspaceRoot);
  const globalConfig = globalPath ? readConfigFile(globalPath) : {};
  const localConfig = readConfigFile(localPath);
  return mergeConfig(globalConfig, localConfig);
}
