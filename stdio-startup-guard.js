// Stdio MCP startup watchdog. stdout is reserved for JSON-RPC; secrets are never logged.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const separator = argv.indexOf('--');
const timeoutMs = Number(argv[1]);
if (argv[0] !== '--timeout-ms' || separator !== 2
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 2_147_483_647 || !argv[separator + 1]) {
  process.stderr.write('[mcp-skill-hub stdio] Invalid invocation\n');
  process.exit(2);
}
const command = argv[separator + 1];
const args = argv.slice(separator + 2);
const startupMethods = new Set(['server/discover', 'initialize', 'tools/list']);
let child;
let stopping = false;
let discovered = false;
let killer;
let closeTimer;
const pending = new Map();

function clearPending() {
  for (const { timer } of pending.values()) clearTimeout(timer);
  pending.clear();
}
function forceStop() {
  if (!child) return;
  if (process.platform === 'win32') {
    if (child.exitCode !== null || killer) return;
    killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    killer.on('error', () => child.kill('SIGKILL'));
    killer.on('close', () => {
      killer = undefined;
      if (child.exitCode !== null) process.exit(process.exitCode ?? 0);
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}
function stop(reason, code = 0) {
  if (stopping) return;
  stopping = true;
  clearPending();
  if (reason) process.stderr.write(`[mcp-skill-hub stdio] ${reason}\n`);
  process.exitCode = code;
  if (!child || child.exitCode !== null) process.exit(code);
  if (process.platform === 'win32') forceStop();
  else child.stdin.end();
  closeTimer = setTimeout(forceStop, 300);
  setTimeout(() => process.exit(code), 2500).unref();
}
function serverEnv() {
  if (process.env.ELECTRON_RUN_AS_NODE === undefined) return process.env;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
function spawnServer(executable, executableArgs, options) {
  // Windows npm executables are .cmd shims and require cmd.exe. The guard
  // itself runs under Electron-as-Node, but the child receives a clean env.
  if (process.platform === 'win32' && /^(npx|npm|pnpm)(?:\.cmd)?$/i.test(executable)) {
    return spawn('cmd.exe', ['/c', executable, ...executableArgs], options);
  }
  return spawn(executable, executableArgs, options);
}
function launch() {
  let launchFailed = false;
  let protocolSeen = false;
  let startupStderr = '';
  const flushStderr = () => {
    if (!launchFailed && startupStderr) process.stderr.write(startupStderr);
    startupStderr = '';
  };
  child = spawnServer(command, args, {
    cwd: process.cwd(), env: serverEnv(),
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    detached: process.platform !== 'win32',
  });
  child.stderr.on('data', (data) => {
    if (launchFailed) return;
    if (protocolSeen) process.stderr.write(data);
    else startupStderr = (startupStderr + data.toString()).slice(-65536);
  });
  child.on('error', (error) => {
    launchFailed = true;
    startupStderr = '';
    stop(error.code === 'ENOENT'
      ? 'Server launch failed (ENOENT): check the executable and PATH on the DSH host'
      : 'Server launch failed', 1);
  });
  child.stdin.on('error', () => stop('Server input closed', 1));
  const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
  output.on('line', (line) => {
    try {
      const message = JSON.parse(line);
      protocolSeen = true;
      flushStderr();
      if (Object.hasOwn(message, 'id') && !message.method) {
        const request = pending.get(message.id);
        if (request) {
          clearTimeout(request.timer);
          pending.delete(message.id);
          if (request.method === 'tools/list' && !message.error && !message.result?.nextCursor) {
            discovered = true;
            clearPending();
          }
        }
      }
    } catch { /* Non-protocol stdout belongs to the child, not this adapter. */ }
    if (!stopping) process.stdout.write(`${line}\n`);
  });
  child.on('close', (code) => {
    flushStderr();
    clearPending();
    clearTimeout(closeTimer);
    if (process.platform !== 'win32') forceStop();
    if (!killer) process.exit(stopping ? (process.exitCode ?? 0) : (code ?? 1));
  });
}
process.stdout.on('error', () => stop(undefined, 0));
process.on('SIGTERM', () => stop(undefined, 0));
process.on('SIGINT', () => stop(undefined, 0));
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('close', () => stop(undefined, 0));
input.on('line', (line) => {
  if (stopping || !line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { stop('Invalid JSON-RPC input', 1); return; }
  if (!child) launch();
  if (stopping) return;
  if (!discovered && startupMethods.has(message.method) && Object.hasOwn(message, 'id')) {
    clearTimeout(pending.get(message.id)?.timer);
    const timer = setTimeout(() => stop(`${message.method} exceeded ${timeoutMs}ms; stopped server`, 1), timeoutMs);
    pending.set(message.id, { method: message.method, timer });
  }
  child.stdin.write(`${line}\n`);
});
