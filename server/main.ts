import { ConversationController } from './conversation.js';
import type { SpeechResult } from './conversation.js';
import Fastify from 'fastify';
import { debugEnabled, debugLog } from './logging.js';
import { loadEnvFile } from 'node:process';
import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Storage } from './storage.js';
import { accept, createGame, emit, legalActions, living, pause, playerView, resume, RuleError, tick } from './engine.js';
import { loadPersonas } from './personas.js';
import { MODEL, openaiAction } from './ai.js';
import type { Action, Command, Game, View } from '../shared/types.js';
import type { ServerResponse } from 'node:http';

const ROOT = resolve(process.env.ABMAFIA_ROOT || process.cwd());
try { loadEnvFile(resolve(ROOT, '.env')); } catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}
const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim() || '';
const PORT = Number(process.env.PORT || 4317);
const storage = new Storage(resolve(ROOT, 'data/mafia.sqlite'));
const personas = loadPersonas(ROOT);
const games = new Map(storage.recover(Date.now()).reverse().map(g => [g.id, g]));
const streams = new Map<string, Set<ServerResponse>>();
const pending = new Map<string, AbortController>();
const performed = new Map<string, number>();
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
  if (streams.get(g.id)?.size) debugLog('SERVER → LIVE UPDATE', { gameId: g.id, version: g.version, phase: g.phase, status: g.status, clients: streams.get(g.id)!.size });
  const payload = `data: ${JSON.stringify(playerView(g, 'p0'))}\n\n`;
  for (const stream of streams.get(g.id) || []) {
    if (stream.destroyed || stream.writableLength > 1_000_000) { stream.end(); continue; }
    stream.write(payload);
  }
}
function commit(g: Game, fn: (draft: Game) => void) {
  const draft = structuredClone(g); fn(draft); draft.version++;
  if (draft.status === 'RUNNING') draft.remaining = Math.max(0, draft.deadline - Date.now());
  storage.save(draft); games.set(draft.id, draft);
  for (const event of draft.events.slice(g.events.length)) debugLog('GAME · EVENT', { gameId: g.id, ...event });
  send(draft); return draft;
}
function stopRequests(id: string) {
  conversation.cancel(id, 'game control or phase change');
  for (const [key, ctrl] of pending) if (key.startsWith(id + ':')) ctrl.abort();
}
app.addHook('onRequest', async (request, reply) => {
  if (request.url.split('?')[0] !== '/api/client-log') debugLog('BROWSER → REQUEST', { requestId: request.id, method: request.method, path: request.url.split('?')[0] });
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
app.addHook('preValidation', async request => {
  if (request.url.split('?')[0] !== '/api/client-log' && request.body !== undefined)
    debugLog('BROWSER → BODY', { requestId: request.id, body: request.body });
});
app.addHook('onSend', async (request, reply, payload) => {
  if (debugEnabled() && request.url.startsWith('/api/') && request.url.split('?')[0] !== '/api/client-log') {
    let body: unknown = payload;
    if (typeof payload === 'string') { try { body = JSON.parse(payload); } catch { /* Preserve text errors. */ } }
    debugLog('SERVER → RESPONSE', { requestId: request.id, status: reply.statusCode, durationMs: Math.round(reply.elapsedTime), body });
  }
  return payload;
});
app.addHook('onResponse', async (request, reply) => {
  if (!request.url.startsWith('/api/')) debugLog('SERVER → RESPONSE', { requestId: request.id, status: reply.statusCode, durationMs: Math.round(reply.elapsedTime) });
});
app.setErrorHandler((error, request, reply) => {
  debugLog('SERVER × ERROR', { requestId: request.id, error });
  const validation = error instanceof Error && 'validation' in error;
  reply.code(error instanceof RuleError || validation ? 400 : 500)
    .send({ error: error instanceof RuleError ? error.message : validation ? 'Invalid request.' : 'The server could not complete that request.' });
});
app.get('/api/session', async request => ({
  debug: debugEnabled(), connected: !!OPENAI_API_KEY, model: MODEL,
  players: personas.map(p => ({ id: p.id, name: p.name })),
  game: latest(request.session) ? playerView(latest(request.session)!, 'p0') : null,
}));
// Only active in debug mode; bounded per browser session to avoid telemetry floods.
const clientLogRates = new Map<string, { count: number; until: number }>();
app.post<{ Body: { event: string; message: string } }>('/api/client-log', {
  schema: { body: { type: 'object', additionalProperties: false, required: ['event','message'], properties: {
    event: { type: 'string', maxLength: 80 }, message: { type: 'string', maxLength: 4000 },
  } } },
}, async (request, reply) => {
  if (!debugEnabled()) return reply.code(204).send();
  const now = Date.now();
  for (const [session, rate] of clientLogRates) if (rate.until <= now) clientLogRates.delete(session);
  const rate = clientLogRates.get(request.session) || { count: 0, until: now + 10_000 };
  clientLogRates.set(request.session, rate);
  if (++rate.count > 10) return reply.code(429).send({ error: 'Diagnostic rate limit.' });
  let details: unknown = request.body.message;
  try { details = JSON.parse(request.body.message); } catch { /* Bounded text diagnostic. */ }
  debugLog('BROWSER · DIAGNOSTIC', { event: request.body.event, details });
  return reply.code(204).send();
});
app.post<{ Body: { name: string; speed: 'standard' | 'quick' } }>('/api/games', {
  schema: { body: { type: 'object', additionalProperties: false, required: ['name', 'speed'], properties: {
    name: { type: 'string', minLength: 1, maxLength: 30 }, speed: { enum: ['standard', 'quick'] },
  } } },
}, async request => {
  if (!OPENAI_API_KEY) throw new RuleError('Set OPENAI_API_KEY in .env and restart the server first.');
  const old = latest(request.session);
  if (old && ['RUNNING', 'PAUSED'].includes(old.status)) throw new RuleError('Leave the current game before starting another.');
  const g = createGame(request.session, personas, request.body.name, request.body.speed, MODEL);
  storage.save(g); games.set(g.id, g);
  for (const event of g.events) debugLog('GAME · EVENT', { gameId: g.id, ...event });
  return playerView(g, 'p0');
});
app.get<{ Params: { id: string } }>('/api/games/:id', async request => playerView(owned(request.params.id, request.session), 'p0'));
app.get<{ Params: { id: string } }>('/api/games/:id/events', async (request, reply) => {
  const g = owned(request.params.id, request.session);
  debugLog('SERVER → STREAM OPEN', { requestId: request.id, gameId: g.id, version: g.version, status: 200 });
  reply.hijack();
  reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const set = streams.get(g.id) || new Set<ServerResponse>(); streams.set(g.id, set); set.add(reply.raw);
  reply.raw.write(`data: ${JSON.stringify(playerView(g, 'p0'))}\n\n`);
  const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15_000);
  reply.raw.on('close', () => { clearInterval(heartbeat); set.delete(reply.raw); debugLog('SERVER · STREAM CLOSED', { requestId: request.id, gameId: g.id }); });
});
app.post<{ Params: { id: string }; Body: Command }>('/api/games/:id/actions', {
  schema: { body: { type: 'object', additionalProperties: false, required: ['commandId', 'phaseId', 'type'], properties: {
    commandId: { type: 'string', minLength: 1, maxLength: 100 }, phaseId: { type: 'string', maxLength: 150 },
    type: { enum: ['Point','Protect','Investigate','SkipAbility','Speak','Nominate','Vote'] },
    replyTo: { type: ['integer', 'null'], minimum: 1 }, addressedTo: { type: ['string', 'null'], maxLength: 20 },
    targets: { type: 'array', maxItems: 2, items: { type: 'string', maxLength: 20 } }, text: { type: 'string', maxLength: 600 },
  } } },
}, async request => {
  const g = owned(request.params.id, request.session);
  if (request.body.type === 'Speak' && !g.receipts[request.body.commandId]) {
    if (Date.now() - (speechTimes.get(g.id) || 0) < 1000) throw new RuleError('Give the table a moment before speaking again.');
  }
  let accepted = false;
  const draft = commit(g, d => { accepted = accept(d, 'p0', request.body, Date.now()); });
  if (accepted && request.body.type === 'Speak') {
    speechTimes.set(g.id, Date.now());
    conversation.published(draft);
    conversation.cancel(g.id, 'new human speech');
  }
  return playerView(draft, 'p0');
});
app.post<{ Params: { id: string }; Body: { operation: 'pause' | 'resume' | 'leave' } }>('/api/games/:id/control', {
  schema: { body: { type: 'object', additionalProperties: false, required: ['operation'], properties: { operation: { enum: ['pause', 'resume', 'leave'] } } } },
}, async request => {
  const g = owned(request.params.id, request.session);
  const op = request.body.operation;
  if (op === 'resume' && (g as { mode: string }).mode !== 'openai') throw new RuleError('This old practice game is archived. Start a new game.');
  if (op === 'resume' && !OPENAI_API_KEY) throw new RuleError('Set OPENAI_API_KEY in .env and restart the server first.');
  if (op === 'resume' && g.aiCalls >= 200) throw new RuleError('This game reached its 200-request limit. Start a new game to continue playing.');
  stopRequests(g.id);
  return playerView(commit(g, d => {
    if (op === 'pause') pause(d, Date.now(), 'You paused the game.');
    if (op === 'resume') resume(d, Date.now());
    if (op === 'leave') { d.status = 'ABANDONED'; d.remaining = 0; }
  }), 'p0');
});

async function runAI(g: Game, playerId: string, type: Action['type'], taskKey: string) {
  const requestId = randomUUID();
  const trace = { requestId, gameId: g.id, player: g.players.find(p => p.id === playerId)!.name, phase: g.phase, action: type };
  const ctrl = new AbortController(); pending.set(taskKey, ctrl);
  const timeout = setTimeout(() => ctrl.abort(), Math.min(15_000, Math.max(100, g.deadline - Date.now() - 100)));
  try {
    if (g.aiCalls >= 200) throw new Error('This game reached its 200-request limit. Leave the game to start another.');
    if (!OPENAI_API_KEY) throw new Error('API key needed. Set OPENAI_API_KEY in .env and restart the server, then resume.');
    g = commit(games.get(g.id)!, d => { d.aiCalls++; });
    const view = playerView(g, playerId);
    const persona = g.personas[g.players.find(p => p.id === playerId)!.personaId];
    const action = await openaiAction(OPENAI_API_KEY, g.model, persona, view, type, ctrl.signal, fetch, requestId);
    const current = games.get(g.id)!;
    if (ctrl.signal.aborted || current.status !== 'RUNNING' || current.phaseId !== g.phaseId || Date.now() >= current.deadline) {
      debugLog('GAME · AI RESULT DISCARDED', { ...trace, reason: 'Cancelled, paused, or phase deadline passed.' }); return;
    }
    if (action.type !== type) throw new RuleError('AI returned a different action type.');
    commit(current, draft => accept(draft, playerId, { ...action, type, commandId: randomUUID(), phaseId: g.phaseId }, Date.now()));
    debugLog('GAME ✓ AI ACTION ACCEPTED', { ...trace, result: action });
    performed.set(taskKey, (performed.get(taskKey) || 0) + 1);
  } catch (error) {
    debugLog('GAME × AI ACTION FAILED', { ...trace, cancelled: ctrl.signal.aborted, error });
    const current = games.get(g.id)!;
    if (current.status !== 'RUNNING' || current.phaseId !== g.phaseId || ctrl.signal.aborted) return;
    const message = error instanceof RuleError ? 'An AI response was not a legal action. Resume to retry.' :
      error instanceof Error ? error.message : 'The AI request failed.';
    commit(current, d => pause(d, Date.now(), message)); stopRequests(g.id);
  } finally { clearTimeout(timeout); if (pending.get(taskKey) === ctrl) pending.delete(taskKey); }
}
// Speech uses its own reservation lifecycle; other legal actions keep the existing scheduler.
const conversation = new ConversationController({
  get: id => games.get(id)!,
  request: async (state, r) => {
    const key = `${state.id}:speech:${r.id}`;
    pending.set(key, r.ctrl);
    try {
      let g = games.get(state.id)!;
      if (g.aiCalls >= 200) throw new Error('This game reached its 200-request limit. Leave the game to start another.');
      if (!OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY in .env and restart the server, then resume.');
      g = commit(g, d => { d.aiCalls++; });
      const player = g.players.find(p => p.id === r.turn.playerId)!;
      return await openaiAction(OPENAI_API_KEY, g.model, g.personas[player.personaId], playerView(g, player.id), 'Speak', r.ctrl.signal, fetch, r.id, r.turn) as SpeechResult;
    } finally { if (pending.get(key) === r.ctrl) pending.delete(key); }
  },
  publish: (state, r, result) => {
    commit(games.get(state.id)!, d => {
      if (result.type === 'Speak') accept(d, r.turn.playerId, { ...result, type: 'Speak', commandId: r.id, phaseId: r.phaseId }, Date.now());
      emit(d, 'ConversationOpportunityCompleted', 'Private conversation opportunity completed.', [], r.turn.playerId, { ...r.turn, outcome: result.type });
    });
  },
  fail: (g, message) => { commit(games.get(g.id)!, d => pause(d, Date.now(), message)); stopRequests(g.id); },
  log: debugLog,
});
function schedule(g: Game) {
  const now = Date.now();
  if (g.status !== 'RUNNING' || now >= g.deadline - 250 || pending.size >= 4) return;
  if (g.phase === 'DISCUSSION' || g.phase.startsWith('DEFENSE')) {
    void conversation.run(g.id).catch(error => debugLog('CONVERSATION × RUNNER ERROR', { gameId: g.id, error }));
    return;
  }
  for (const p of living(g).filter(p => !p.human)) {
    if (pending.size >= 4) break;
    const type = legalActions(g, p.id)[0]?.type;
    if (!type) continue;
    const taskKey = `${g.id}:${g.phaseId}:${p.id}`;
    if (pending.has(taskKey)) continue;
    const count = performed.get(taskKey) || 0;
    if (type === 'Point' && (count >= 2 || (count === 1 && g.deadline - now > g.timing.mafia / 2))) continue;
    void runAI(g, p.id, type, taskKey);
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
  } catch (error) { debugLog('SERVER × RUNNER ERROR', { error }); console.error('Game runner stopped a tick after a storage or engine error.'); }
}, 200);

// Serve only the build's enumerated files. No arbitrary filesystem path or directory listing.
const clientRoot = resolve(ROOT, 'build/client');
const index = readFileSync(resolve(clientRoot, 'index.html'));
const loungeDemo = readFileSync(resolve(clientRoot, 'lounge-demo.html'));
const assets = new Map(readdirSync(resolve(clientRoot, 'assets')).map(name => [name, readFileSync(resolve(clientRoot, 'assets', name))]));
app.get('/', async (_request, reply) => reply.type('text/html').send(index));
app.get('/lounge-demo.html', async (_request, reply) => reply.type('text/html').send(loungeDemo));
app.get<{ Params: { name: string } }>('/assets/:name', async (request, reply) => {
  const name = request.params.name, content = assets.get(name);
  if (!content) return reply.code(404).send();
  const mime = name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.png') ? 'image/png' : 'application/octet-stream';
  return reply.header('Cache-Control', 'public, max-age=31536000, immutable').type(mime).send(content);
});
await app.listen({ port: PORT, host: '127.0.0.1' });
console.log(`ABMafia is ready at http://127.0.0.1:${PORT}`);
if (debugEnabled()) console.log('Live terminal logging ON: browser requests, game secrets, and full OpenAI prompts/responses. API keys and session credentials are redacted.');
debugLog('SERVER · READY', { model: MODEL, keyLoaded: !!OPENAI_API_KEY, gamesRecovered: games.size });
async function shutdown() {
  debugLog('SERVER · STOPPING');
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
