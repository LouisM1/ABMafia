import Fastify from 'fastify';
import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Storage } from './storage.js';
import { accept, createGame, legalActions, living, pause, playerView, resume, RuleError, tick } from './engine.js';
import { loadPersonas } from './personas.js';
import { MODEL, openaiAction, practiceAction } from './ai.js';
import type { Action, Command, Game, View } from '../shared/types.js';
import type { ServerResponse } from 'node:http';

const ROOT = resolve(process.env.ABMAFIA_ROOT || process.cwd());
const PORT = Number(process.env.PORT || 4317);
const storage = new Storage(resolve(ROOT, 'data/mafia.sqlite'));
const personas = loadPersonas(ROOT);
const games = new Map(storage.recover(Date.now()).reverse().map(g => [g.id, g]));
const keys = new Map<string, string>(); // Deliberately never persisted or included in API responses.
const streams = new Map<string, Set<ServerResponse>>();
const pending = new Map<string, AbortController>();
const performed = new Map<string, number>();
const lastSpeech = new Map<string, number>();
const speechTimes = new Map<string, number>();
const app = Fastify({ logger: false, bodyLimit: 16_384 });
const SESSION = 'abmafia_session';
declare module 'fastify' { interface FastifyRequest { session: string } }
app.decorateRequest('session', '');

function latest(session: string) { return [...games.values()].filter(g => g.session === session).at(-1); }
function owned(id: string, session: string) {
  const g = games.get(id);
  if (!g || g.session !== session) throw new RuleError('Game not found.');
  return g;
}
function send(g: Game) {
  const payload = `data: ${JSON.stringify(playerView(g, 'p0'))}\n\n`;
  for (const stream of streams.get(g.id) || []) {
    if (stream.destroyed || stream.writableLength > 1_000_000) { stream.end(); continue; }
    stream.write(payload);
  }
}
function commit(g: Game, fn: (draft: Game) => void) {
  const draft = structuredClone(g); fn(draft); draft.version++;
  if (draft.status === 'RUNNING') draft.remaining = Math.max(0, draft.deadline - Date.now());
  storage.save(draft); games.set(draft.id, draft); send(draft); return draft;
}
function stopRequests(id: string) {
  for (const [key, ctrl] of pending) if (key.startsWith(id + ':')) ctrl.abort();
}
app.addHook('onRequest', async (request, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'same-origin');
  reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  // Local app: reject unexpected hosts and cross-origin writes, including DNS rebinding attempts.
  const host = request.headers.host || '';
  if (![`localhost:${PORT}`, `127.0.0.1:${PORT}`].includes(host)) return reply.code(403).send({ error: 'Local connections only.' });
  if (request.method !== 'GET' && request.headers.origin && ![`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`].includes(request.headers.origin))
    return reply.code(403).send({ error: 'Origin not allowed.' });
  if (!request.url.startsWith('/api/')) return;
  reply.header('Cache-Control', 'no-store');
  const match = request.headers.cookie?.match(/(?:^|;\s*)abmafia_session=([a-f0-9]{64})(?:;|$)/);
  let token = match?.[1];
  if (!token || !storage.hasSession(token)) {
    token = randomBytes(32).toString('hex'); storage.addSession(token);
    reply.header('Set-Cookie', `${SESSION}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`);
  }
  request.session = token;
});
app.setErrorHandler((error, _request, reply) => {
  const validation = error instanceof Error && 'validation' in error;
  reply.code(error instanceof RuleError || validation ? 400 : 500)
    .send({ error: error instanceof RuleError ? error.message : validation ? 'Invalid request.' : 'The server could not complete that request.' });
});
app.get('/api/session', async request => ({
  connected: keys.has(request.session), model: MODEL,
  players: personas.map(p => ({ id: p.id, name: p.name })),
  game: latest(request.session) ? playerView(latest(request.session)!, 'p0') : null,
}));
app.post<{ Body: { apiKey: string } }>('/api/key', {
  schema: { body: { type: 'object', additionalProperties: false, required: ['apiKey'], properties: { apiKey: { type: 'string', maxLength: 512 } } } },
}, async request => {
  const value = request.body.apiKey.trim();
  if (value && (value.length < 20 || !/^[\x21-\x7e]+$/.test(value))) throw new RuleError('Enter a valid API key.');
  if (value) keys.set(request.session, value);
  else {
    keys.delete(request.session);
    const game = latest(request.session);
    if (game?.mode === 'openai' && game.status === 'RUNNING') {
      stopRequests(game.id);
      commit(game, draft => pause(draft, Date.now(), 'API key removed. Reconnect it to resume.'));
    }
  }
  return { connected: !!value };
});
app.post<{ Body: { name: string; mode: 'practice' | 'openai'; speed: 'standard' | 'quick' } }>('/api/games', {
  schema: { body: { type: 'object', additionalProperties: false, required: ['name', 'mode', 'speed'], properties: {
    name: { type: 'string', minLength: 1, maxLength: 30 }, mode: { enum: ['practice', 'openai'] }, speed: { enum: ['standard', 'quick'] },
  } } },
}, async request => {
  if (request.body.mode === 'openai' && !keys.has(request.session)) throw new RuleError('Add your API key in Model router first.');
  const old = latest(request.session);
  if (old && ['RUNNING', 'PAUSED'].includes(old.status)) throw new RuleError('Leave the current game before starting another.');
  const g = createGame(request.session, personas, request.body.name, request.body.mode, request.body.speed, MODEL);
  storage.save(g); games.set(g.id, g); return playerView(g, 'p0');
});
app.get<{ Params: { id: string } }>('/api/games/:id', async request => playerView(owned(request.params.id, request.session), 'p0'));
app.get<{ Params: { id: string } }>('/api/games/:id/events', async (request, reply) => {
  const g = owned(request.params.id, request.session);
  reply.hijack();
  reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const set = streams.get(g.id) || new Set<ServerResponse>(); streams.set(g.id, set); set.add(reply.raw);
  reply.raw.write(`data: ${JSON.stringify(playerView(g, 'p0'))}\n\n`);
  const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15_000);
  request.raw.on('close', () => { clearInterval(heartbeat); set.delete(reply.raw); });
});
app.post<{ Params: { id: string }; Body: Command }>('/api/games/:id/actions', {
  schema: { body: { type: 'object', additionalProperties: false, required: ['commandId', 'phaseId', 'type'], properties: {
    commandId: { type: 'string', minLength: 1, maxLength: 100 }, phaseId: { type: 'string', maxLength: 150 },
    type: { enum: ['Point','Protect','Investigate','SkipAbility','Speak','Nominate','Vote'] },
    targets: { type: 'array', maxItems: 2, items: { type: 'string', maxLength: 20 } }, text: { type: 'string', maxLength: 600 },
  } } },
}, async request => {
  const g = owned(request.params.id, request.session);
  if (request.body.type === 'Speak' && !g.receipts[request.body.commandId]) {
    if (Date.now() - (speechTimes.get(g.id) || 0) < 1000) throw new RuleError('Give the table a moment before speaking again.');
  }
  const draft = commit(g, d => { accept(d, 'p0', request.body, Date.now()); });
  if (request.body.type === 'Speak') speechTimes.set(g.id, Date.now());
  return playerView(draft, 'p0');
});
app.post<{ Params: { id: string }; Body: { operation: 'pause' | 'resume' | 'leave' } }>('/api/games/:id/control', {
  schema: { body: { type: 'object', additionalProperties: false, required: ['operation'], properties: { operation: { enum: ['pause', 'resume', 'leave'] } } } },
}, async request => {
  const g = owned(request.params.id, request.session);
  const op = request.body.operation;
  if (op === 'resume' && g.mode === 'openai' && !keys.has(request.session)) throw new RuleError('Reconnect your API key first.');
  if (op === 'resume' && g.aiCalls >= 200) throw new RuleError('This game reached its 200-request limit. Start a new game to continue playing.');
  stopRequests(g.id);
  return playerView(commit(g, d => {
    if (op === 'pause') pause(d, Date.now(), 'You paused the game.');
    if (op === 'resume') resume(d, Date.now());
    if (op === 'leave') { d.status = 'ABANDONED'; d.remaining = 0; }
  }), 'p0');
});

async function runAI(g: Game, playerId: string, type: Action['type'], taskKey: string) {
  const ctrl = new AbortController(); pending.set(taskKey, ctrl);
  const timeout = setTimeout(() => ctrl.abort(), Math.min(15_000, Math.max(100, g.deadline - Date.now() - 100)));
  try {
    if (g.mode === 'openai') {
      if (g.aiCalls >= 200) throw new Error('This game reached its 200-request limit. Leave the game to start another.');
      if (!keys.has(g.session)) throw new Error('API key needed. Reconnect it in Model router, then resume.');
      g = commit(games.get(g.id)!, d => { d.aiCalls++; });
    }
    const view = playerView(g, playerId);
    const persona = g.personas[g.players.find(p => p.id === playerId)!.personaId];
    const action = g.mode === 'practice' ? practiceAction(view, type) :
      await openaiAction(keys.get(g.session)!, g.model, persona, view, type, ctrl.signal);
    const current = games.get(g.id)!;
    if (ctrl.signal.aborted || current.status !== 'RUNNING' || current.phaseId !== g.phaseId || Date.now() >= current.deadline) return;
    commit(current, draft => accept(draft, playerId, { ...action, commandId: randomUUID(), phaseId: g.phaseId }, Date.now()));
    performed.set(taskKey, (performed.get(taskKey) || 0) + 1);
    if (type === 'Speak') { lastSpeech.set(g.id, Date.now()); lastSpeech.set(`${g.id}:${playerId}`, Date.now()); }
  } catch (error) {
    const current = games.get(g.id)!;
    if (current.status !== 'RUNNING' || current.phaseId !== g.phaseId || ctrl.signal.aborted) return;
    const message = error instanceof RuleError ? 'An AI response was not a legal action. Resume to retry.' :
      error instanceof Error ? error.message : 'The AI request failed.';
    commit(current, d => pause(d, Date.now(), message)); stopRequests(g.id);
  } finally { clearTimeout(timeout); pending.delete(taskKey); }
}
function schedule(g: Game) {
  const now = Date.now();
  if (g.status !== 'RUNNING' || now >= g.deadline - 250) return;
  const speaking = g.phase === 'DISCUSSION' || g.phase.startsWith('DEFENSE');
  const tasks = living(g).filter(p => !p.human).sort((a, b) =>
    (lastSpeech.get(`${g.id}:${a.id}`) || 0) - (lastSpeech.get(`${g.id}:${b.id}`) || 0));
  if (speaking && (now - (lastSpeech.get(g.id) || 0) < (g.mode === 'practice' ? 3500 : 800) ||
      [...pending.keys()].some(k => k.startsWith(g.id + ':')))) return;
  for (const p of tasks) {
    if (pending.size >= 4) break;
    const legal = legalActions(g, p.id), type = legal[0]?.type;
    if (!type) continue;
    const taskKey = `${g.id}:${g.phaseId}:${p.id}`;
    if (pending.has(taskKey)) continue;
    const count = performed.get(taskKey) || 0;
    if ((type === 'Speak' && count >= (g.phase === 'DISCUSSION' ? 2 : 1)) || (type === 'Point' && count >= 2)) continue;
    if (type === 'Point' && count === 1 && g.deadline - now > g.timing.mafia / 2) continue;
    void runAI(g, p.id, type, taskKey);
    if (speaking) break;
  }
}
let checkpoint = Date.now();
const interval = setInterval(() => {
  try {
    for (const g of games.values()) {
      if (g.status !== 'RUNNING') continue;
      if (Date.now() >= g.deadline) {
        stopRequests(g.id); commit(g, d => { tick(d, Date.now()); });
      } else if (Date.now() - checkpoint > 1000) {
        g.remaining = Math.max(0, g.deadline - Date.now()); storage.save(g);
      }
      schedule(games.get(g.id)!);
    }
    if (Date.now() - checkpoint > 1000) checkpoint = Date.now();
  } catch { console.error('Game runner stopped a tick after a storage or engine error.'); }
}, 200);

// Serve only the build's enumerated files. No arbitrary filesystem path or directory listing.
const clientRoot = resolve(ROOT, 'build/client');
const index = readFileSync(resolve(clientRoot, 'index.html'));
const assets = new Map(readdirSync(resolve(clientRoot, 'assets')).map(name => [name, readFileSync(resolve(clientRoot, 'assets', name))]));
app.get('/', async (_request, reply) => reply.type('text/html').send(index));
app.get<{ Params: { name: string } }>('/assets/:name', async (request, reply) => {
  const name = request.params.name, content = assets.get(name);
  if (!content) return reply.code(404).send();
  const mime = name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : 'application/octet-stream';
  return reply.header('Cache-Control', 'public, max-age=31536000, immutable').type(mime).send(content);
});
await app.listen({ port: PORT, host: '127.0.0.1' });
console.log(`ABMafia is ready at http://127.0.0.1:${PORT}`);
async function shutdown() {
  clearInterval(interval);
  for (const g of games.values()) {
    stopRequests(g.id);
    if (g.status === 'RUNNING') commit(g, d => pause(d, Date.now(), 'Server stopped. Resume when you return.'));
  }
  for (const clients of streams.values()) for (const stream of clients) stream.end();
  await app.close(); storage.close(); process.exit(0);
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
