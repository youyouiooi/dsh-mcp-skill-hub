import { fileURLToPath } from 'node:url';

const MCP_PACKAGE = '@deepseek-ai/dsh-mcp-client';
const STDIO_GUARD = fileURLToPath(new URL('./stdio-startup-guard.js', import.meta.url));
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;
const METHODS = new Set([
  'status', 'healthCheck', 'setEnabled', 'reconnect', 'disconnect',
  'importJson', 'editableConnectionConfig', 'reconfigureConnection', 'migrate',
]);

function asError(cause) {
  return cause instanceof Error ? cause : new Error(String(cause?.message ?? cause));
}

function normalizeServerName(value) {
  const name = String(value ?? '').trim();
  if (!SERVER_NAME.test(name)) {
    throw new Error(`Invalid serverName "${name}": use 1-32 letters, digits, underscores or hyphens`);
  }
  return name;
}

function normalizeConfig(raw, fallbackName) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('MCP connection config must be an object');
  const transport = raw.transport ?? raw.type ?? (raw.command ? 'stdio' : 'streamable-http');
  const serverName = normalizeServerName(raw.serverName ?? raw.name ?? fallbackName);
  if (transport === 'sse') throw new Error(`Connection "${serverName}": legacy SSE is not supported by the lightweight backend; use streamable-http`);
  if (transport === 'stdio') {
    if (!raw.command || typeof raw.command !== 'string') throw new Error(`Connection "${serverName}": stdio command is required`);
    return {
      transport: 'stdio', serverName, command: raw.command,
      args: Array.isArray(raw.args) ? raw.args.map(String) : [],
      env: raw.env && typeof raw.env === 'object'
        ? (process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1', ...raw.env } : { ...raw.env })
        : (process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
      failOnStartupError: false,
      ...(raw.toolCallTimeoutMs ? { toolCallTimeoutMs: raw.toolCallTimeoutMs } : {}),
      ...(raw.reconnect ? { reconnect: raw.reconnect } : {}),
    };
  }
  if (transport !== 'streamable-http' && transport !== 'http') {
    throw new Error(`Connection "${serverName}": unsupported transport "${transport}"`);
  }
  if (!raw.url || typeof raw.url !== 'string') throw new Error(`Connection "${serverName}": streamable-http url is required`);
  let parsed;
  try { parsed = new URL(raw.url); } catch { throw new Error(`Connection "${serverName}": invalid URL`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`Connection "${serverName}": URL must use HTTP(S)`);
  return {
    transport: 'streamable-http', serverName, url: raw.url,
    headers: raw.headers && typeof raw.headers === 'object' ? { ...raw.headers } : {},
    failOnStartupError: false,
    ...(raw.toolCallTimeoutMs ? { toolCallTimeoutMs: raw.toolCallTimeoutMs } : {}),
    ...(raw.reconnect ? { reconnect: raw.reconnect } : {}),
  };
}

function importCandidates(text) {
  let value;
  try { value = JSON.parse(String(text)); } catch (cause) { throw new Error(`Invalid JSON: ${cause.message}`); }
  const dictionary = value?.mcpServers ?? value?.servers;
  if (dictionary && typeof dictionary === 'object' && !Array.isArray(dictionary)) {
    return Object.entries(dictionary).map(([name, config]) => normalizeConfig(config, name));
  }
  if (Array.isArray(value)) return value.map((config) => normalizeConfig(config));
  return [normalizeConfig(value)];
}

export function createMcpBackend(ctx) {
  let queue = Promise.resolve();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function entries() {
    return Array.from(ctx.loader.entries())
      .filter((entry) => (entry.options?.name ?? entry.name) === MCP_PACKAGE)
      .sort((a, b) => String(a.id ?? a.options?.id).localeCompare(String(b.id ?? b.options?.id)));
  }
  function configOf(entry) {
    return entry?.options?.config ?? entry?.config ?? {};
  }
  function disabledOf(entry) {
    return entry?.options?.disabled === true || entry?.disabled === true;
  }
  function resolveEntry(key) {
    const id = String(key ?? '');
    const entry = entries().find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`MCP connection not found: ${id}`);
    return entry;
  }
  function exclusive(operation) {
    const run = queue.then(operation, operation);
    queue = run.then(() => undefined, () => undefined);
    return run;
  }
  function toolNames(serverName) {
    const prefix = `mcp__${serverName}__`;
    try {
      return (ctx.tools?.definitions() ?? []).map((tool) => tool.name).filter((name) => name.startsWith(prefix));
    } catch {
      return [];
    }
  }
  function endpointOf(config) {
    const raw = config.transport === 'stdio'
      ? [config.command, ...(config.args ?? [])].join(' ')
      : config.url;
    return String(raw ?? '').replace(/(Authorization:\s*Bearer\s+)[^\s"']+/gi, '$1<redacted>');
  }
  function publicItem(entry) {
    const config = configOf(entry);
    const enabled = !disabledOf(entry);
    const tools = enabled ? toolNames(config.serverName) : [];
    const state = !enabled ? 'disabled' : tools.length ? 'connected' : 'pending';
    return {
      key: entry.id,
      name: config.serverName || entry.id,
      serverName: config.serverName || entry.id,
      connectorId: 'host',
      kind: config.transport,
      transport: config.transport,
      endpoint: endpointOf(config),
      enabled,
      injectionMode: 'global',
      injectionLabel: 'global',
      authMode: config.headers?.Authorization ? 'bearer' : 'none',
      lastError: null,
      connectionState: state,
      healthMessage: tools.length ? `${tools.length} tools registered` : null,
      toolCount: tools.length,
      canEditConfiguration: true,
      canRename: false,
    };
  }
  async function status() {
    return { ok: true, detail: { items: entries().map(publicItem), backend: 'host', scope: 'global' } };
  }
  async function update(key, patch) {
    await ctx.loader.update(String(key), patch);
  }
  async function waitForTools(serverName, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    do {
      if (toolNames(serverName).length) return true;
      await sleep(200);
    } while (Date.now() < deadline);
    return toolNames(serverName).length > 0;
  }

  function withStartupGuard(config) {
    if (config.transport !== 'stdio') return config;
    const args = Array.isArray(config.args) ? config.args : [];
    if (args[0] === STDIO_GUARD) return config;
    const separator = args.indexOf('--');
    const hasConnectorGuard = separator >= 0 && String(args[0] ?? '').replace(/\\/g, '/')
      .includes('dsh-mcp-connector/lib/stdio-startup-guard.js');
    const command = hasConnectorGuard ? args[separator + 1] : config.command;
    const commandArgs = hasConnectorGuard ? args.slice(separator + 2) : args;
    if (!command) throw new Error(`Connection "${config.serverName}": stdio command is required`);
    return {
      ...config,
      command: process.execPath,
      args: [STDIO_GUARD, '--timeout-ms', '60000', '--', String(command), ...commandArgs.map(String)],
      env: process.versions.electron
        ? { ...(config.env ?? {}), ELECTRON_RUN_AS_NODE: '1' }
        : { ...(config.env ?? {}) },
    };
  }

  const api = {
    status,
    async migrate() {
      return exclusive(async () => {
        const migrated = [];
        for (const entry of entries()) {
          const previous = configOf(entry);
          const next = withStartupGuard(previous);
          if (JSON.stringify(next) === JSON.stringify(previous)) continue;
          await update(entry.id, { config: next });
          migrated.push(entry.id);
        }
        return { ok: true, message: `Migrated ${migrated.length} connection(s) to the built-in stdio startup guard`, detail: { migrated } };
      });
    },
    async healthCheck() {
      // dsh-mcp-client exposes no health API. Tool presence is the only honest
      // core runtime signal; automatic reconnection remains owned by that package.
      return status();
    },
    async setEnabled({ key, enabled }) {
      return exclusive(async () => {
        const entry = resolveEntry(key);
        await update(entry.id, { disabled: !enabled });
        return { ok: true, message: enabled ? 'Connection enabled' : 'Connection disabled' };
      });
    },
    async reconnect({ key }) {
      return exclusive(async () => {
        const entry = resolveEntry(key);
        if (disabledOf(entry)) throw new Error('Connection is disabled; enable it before reconnecting');
        const config = configOf(entry);
        await update(entry.id, { disabled: true });
        try {
          await update(entry.id, { disabled: false, config: { ...config } });
        } catch (cause) {
          throw new Error(`Reconnect failed; the entry may remain disabled: ${asError(cause).message}`);
        }
        const registered = await waitForTools(config.serverName);
        return {
          ok: true,
          message: registered ? 'Reconnected; tools are registered' : 'Recreated the connection; tool registration is still pending or the server is unavailable',
        };
      });
    },
    async disconnect({ key }) {
      return exclusive(async () => {
        const entry = resolveEntry(key);
        await ctx.loader.remove(entry.id);
        return { ok: true, message: 'Connection removed' };
      });
    },
    async importJson({ json }) {
      return exclusive(async () => {
        const candidates = importCandidates(json);
        const existingNames = new Set(entries().map((entry) => configOf(entry).serverName));
        const keys = [];
        const skipped = [];
        for (const config of candidates) {
          if (existingNames.has(config.serverName)) { skipped.push(config.serverName); continue; }
          let id = `mcp-skill-hub-${config.serverName}`;
          let suffix = 2;
          while (entries().some((entry) => entry.id === id)) id = `mcp-skill-hub-${config.serverName}-${suffix++}`;
          await ctx.loader.create({ id, name: MCP_PACKAGE, config: withStartupGuard(config), disabled: false });
          existingNames.add(config.serverName);
          keys.push(id);
        }
        return { ok: true, message: `Imported ${keys.length} connection(s)`, detail: { keys, skipped } };
      });
    },
    async editableConnectionConfig({ key }) {
      const entry = resolveEntry(key);
      return { ok: true, json: JSON.stringify(configOf(entry), null, 2) };
    },
    async reconfigureConnection({ key, json }) {
      return exclusive(async () => {
        const entry = resolveEntry(key);
        const previous = configOf(entry);
        const candidates = importCandidates(json);
        if (candidates.length !== 1) throw new Error('Edit exactly one connection config');
        const next = candidates[0];
        if (next.serverName !== previous.serverName) {
          throw new Error('serverName is immutable because it determines tool names; remove and recreate the connection to rename it');
        }
        await update(entry.id, { config: withStartupGuard(next), disabled: false });
        await waitForTools(next.serverName, 2000);
        return { ok: true, message: 'Connection configuration saved' };
      });
    },
  };

  return {
    async invoke(method, params) {
      if (!METHODS.has(method)) throw new Error(`Unknown MCP method: ${method}`);
      return api[method](params ?? {});
    },
  };
}
