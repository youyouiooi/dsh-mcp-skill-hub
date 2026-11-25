import { readFile, readdir, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createMcpBackend } from './mcp-backend.js';

export const inject = ['webServer', 'tools'];

const UI_FILE = fileURLToPath(new URL('./ui/index.html', import.meta.url));
const ROUTE_PREFIX = '/mcp-skill-hub';
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function dshHome() {
  return process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh');
}
function agentsHome() {
  return process.env.DSH_AGENTS_HOME ? resolve(process.env.DSH_AGENTS_HOME) : join(homedir(), '.agents');
}
function userSkillRoots() {
  return [join(dshHome(), 'skills'), join(agentsHome(), 'skills')];
}
function projectSkillRoots(cwd) {
  if (!cwd || typeof cwd !== 'string') return [];
  const root = resolve(cwd);
  return [join(root, '.dsh', 'skills'), join(root, '.agents', 'skills')];
}
function insideRoot(target, root) {
  return resolve(target).startsWith(resolve(root) + sep);
}
function writeJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
async function readJsonBody(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  try { return JSON.parse(text || '{}'); } catch { return {}; }
}
function revealPath(path) {
  if (process.platform === 'win32') {
    spawn('explorer.exe', [`/select,${path}`], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', ['-R', path], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [join(path, '..')], { detached: true, stdio: 'ignore' }).unref();
  }
}

// Some preset-scoped skill providers are not visible to this global plugin
// context. Scan the same well-known local roots as a fallback so user skills
// still appear in this global sidebar panel.
function parseLocalSkill(raw, file, source) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return undefined;
  const name = match[1].match(/^name:\s*(.+?)\s*$/m)?.[1]?.trim();
  const description = match[1].match(/^description:\s*(.+?)\s*$/m)?.[1]?.trim();
  if (!name || !description || !SKILL_NAME.test(name)) return undefined;
  return {
    name,
    description: description.replace(/^(["'])(.*)\1$/, '$2'),
    invocation: { modelInvocable: true, userInvocable: true },
    source,
    provider: 'filesystem',
    path: file,
    resourceBase: { kind: 'directory', path: join(file, '..') },
    content: raw.slice(match[0].length),
  };
}
async function scanLocalRoot(root, source) {
  const result = [];
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return result; }
  for (const entry of entries) {
    if (entry.name === '.system') continue;
    const file = entry.isDirectory() ? join(root, entry.name, 'SKILL.md')
      : entry.isFile() && entry.name.endsWith('.md') ? join(root, entry.name) : undefined;
    if (!file) continue;
    try {
      const skill = parseLocalSkill(await readFile(file, 'utf8'), file, source);
      if (skill) result.push(skill);
    } catch { /* ignore an incomplete or unreadable skill */ }
  }
  return result;
}
async function scanLocalSkills(cwd) {
  const groups = [
    [userSkillRoots()[0], 'user-dsh'],
    [userSkillRoots()[1], 'user-agents'],
    ...projectSkillRoots(cwd).map((root, index) => [root, index === 0 ? 'project-dsh' : 'project-agents']),
  ];
  const batches = await Promise.all(groups.map(([root, source]) => scanLocalRoot(root, source)));
  const byName = new Map();
  // Project entries win over user entries, matching the normal skill ranks.
  for (const skill of batches.flat().reverse()) if (!byName.has(skill.name)) byName.set(skill.name, skill);
  return [...byName.values()];
}

/** Host half: serves the management page and the skill/MCP helper APIs. */
export function apply(ctx) {
  const mcp = createMcpBackend(ctx);
  // Older Connector entries may point at its stdio startup-guard script.
  // Unwrap them once so removing/disabling Connector leaves no runtime dependency.
  mcp.invoke('migrate').then((result) => {
    if (result.detail?.migrated?.length) ctx.logger?.info?.(`[mcp-skill-hub] ${result.message}`);
  }).catch((cause) => ctx.logger?.warn?.(`[mcp-skill-hub] MCP migration failed: ${cause?.message ?? cause}`));

  async function listSkills(cwd) {
    const local = await scanLocalSkills(cwd);
    const byName = new Map(local.map((skill) => [skill.name, skill]));
    const skills = ctx.get('skills');
    let complete = false;
    if (skills) {
      const snapshot = await skills.snapshot(cwd ? { cwd } : {});
      complete = snapshot.complete;
      for (const skill of snapshot.skills) {
        if (byName.has(skill.name)) continue;
        byName.set(skill.name, {
          name: skill.name,
          description: skill.description,
          whenToUse: skill.whenToUse,
          invocation: skill.invocation,
          source: skill.source,
          provider: skill.provider,
          path: skill.path,
          resourceBase: skill.resourceBase,
        });
      }
    }
    return {
      ok: true,
      complete,
      skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
      ...(skills ? {} : { warning: 'skills service unavailable; showing local filesystem skills only' }),
    };
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    try {
      if ((path === ROUTE_PREFIX || path === ROUTE_PREFIX + '/ui/' || path === ROUTE_PREFIX + '/ui/index.html') && method === 'GET') {
        const html = await readFile(UI_FILE, 'utf8');
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': "frame-ancestors 'self'",
        });
        res.end(html);
        return;
      }

      if (path === ROUTE_PREFIX + '/api/skills' && method === 'GET') {
        writeJson(res, 200, await listSkills(url.searchParams.get('cwd') || undefined));
        return;
      }

      if (path === ROUTE_PREFIX + '/api/skills/get' && method === 'GET') {
        const name = url.searchParams.get('name') || '';
        const cwd = url.searchParams.get('cwd') || undefined;
        const skills = ctx.get('skills');
        const local = (await scanLocalSkills(cwd)).find((skill) => skill.name === name);
        const definition = local ?? (skills ? await skills.get(name, cwd ? { cwd } : {}) : undefined);
        if (!definition) { writeJson(res, 404, { ok: false, error: `skill not found: ${name}` }); return; }
        writeJson(res, 200, {
          ok: true,
          skill: {
            name: definition.name,
            description: definition.description,
            whenToUse: definition.whenToUse,
            invocation: definition.invocation,
            source: definition.source,
            provider: definition.provider,
            path: definition.path,
            resourceBase: definition.resourceBase,
            content: definition.content,
          },
        });
        return;
      }

      if (path === ROUTE_PREFIX + '/api/skills/create' && method === 'POST') {
        const body = await readJsonBody(req);
        const name = String(body.name || '').trim();
        const description = String(body.description || '').trim();
        const content = String(body.content || '');
        const scope = body.scope === 'project' ? 'project' : 'user';
        if (!SKILL_NAME.test(name)) { writeJson(res, 400, { ok: false, error: 'invalid skill name: use kebab-case, e.g. my-skill' }); return; }
        if (!description) { writeJson(res, 400, { ok: false, error: 'description is required' }); return; }
        let root;
        if (scope === 'project') {
          const roots = projectSkillRoots(body.cwd);
          if (roots.length === 0) { writeJson(res, 400, { ok: false, error: 'project scope requires a cwd (project directory)' }); return; }
          root = roots[0];
        } else {
          root = userSkillRoots()[0];
        }
        const dir = join(root, name);
        const file = join(dir, 'SKILL.md');
        try {
          await stat(dir);
          writeJson(res, 409, { ok: false, error: `skill directory already exists: ${dir}` });
          return;
        } catch { /* not present: good */ }
        await mkdir(dir, { recursive: true });
        const frontmatter = `---\nname: ${name}\ndescription: ${description.replace(/\n/g, ' ')}\n---\n\n`;
        await writeFile(file, frontmatter + (content || `# ${name}\n\nDescribe when and how to use this skill.\n`), 'utf8');
        writeJson(res, 200, { ok: true, path: file });
        return;
      }

      if (path === ROUTE_PREFIX + '/api/skills/delete' && method === 'POST') {
        const body = await readJsonBody(req);
        const target = String(body.path || '');
        if (!target) { writeJson(res, 400, { ok: false, error: 'path is required' }); return; }
        const roots = [...userSkillRoots(), ...projectSkillRoots(body.cwd)];
        if (!roots.some((root) => insideRoot(target, root))) {
          writeJson(res, 403, { ok: false, error: 'refused: path is not inside a known skills directory' });
          return;
        }
        await rm(resolve(target), { recursive: true, force: true });
        writeJson(res, 200, { ok: true });
        return;
      }

      if (path === ROUTE_PREFIX + '/api/skills/reveal' && method === 'POST') {
        const body = await readJsonBody(req);
        const target = String(body.path || '');
        if (!target) { writeJson(res, 400, { ok: false, error: 'path is required' }); return; }
        revealPath(resolve(target));
        writeJson(res, 200, { ok: true });
        return;
      }

      if (path === ROUTE_PREFIX + '/api/mcp' && method === 'POST') {
        const body = await readJsonBody(req);
        writeJson(res, 200, await mcp.invoke(String(body.method || ''), body.params));
        return;
      }

      if (path === ROUTE_PREFIX + '/api/mcp/manager' && method === 'GET') {
        writeJson(res, 200, { ok: true, available: true, backend: 'host', independent: true });
        return;
      }

      writeJson(res, 404, { ok: false, error: 'not found: ' + path });
    } catch (cause) {
      ctx.logger?.warn?.(`[mcp-skill-hub] ${method} ${path} failed: ${cause?.message ?? cause}`);
      writeJson(res, 500, { ok: false, error: String(cause?.message ?? cause) });
    }
  }

  const dispose = ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: handle });
  ctx.effect(() => () => dispose(), 'mcp-skill-hub: web routes');
  ctx.logger?.info?.('[mcp-skill-hub] management routes registered at ' + ROUTE_PREFIX);
}
