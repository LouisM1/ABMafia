import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accept, createGame, emit, pause, playerView, resume } from '../server/engine.js';
import { chooseTurn, ConversationController, inferAddressee, metadata, revision, speech } from '../server/conversation.js';
import type { Completion, Reservation, SpeechResult, Turn } from '../server/conversation.js';
import { conversationContext, MODEL, openaiAction } from '../server/ai.js';
import { Storage } from '../server/storage.js';
import type { Game, PersonaPrompt } from '../shared/types.js';

const names = ['Bryan Johnson', 'Josie Zayner', 'Sam Altman', 'Palmer Luckey', 'Liv Boeree', 'Cyan Banister', 'Ryan Beiermeister', 'Ryan Petersen', 'Tim Urban', 'Dylan Field', 'Trae Stephens'];
const personas: PersonaPrompt[] = names.map((name, i) => ({ id: `ai${i}`, name, text: 'Test portrayal', behaviours: [], examples: [] }));
function game() { const g = createGame('test', personas, 'Louis', 'quick', MODEL, 0, n => n - 1); g.phase = 'DISCUSSION'; g.phaseId = 'discussion'; g.deadline = 60_000; return g; }
function say(g: Game, actor = 'p0', addressedTo: string | null = null, text = 'Explain that claim.') {
  accept(g, actor, { type: 'Speak', text, addressedTo, commandId: randomUUID(), phaseId: g.phaseId }, 1);
}
function complete(g: Game, turn: Turn, outcome: 'Speak' | 'Pass', addressedTo: string | null = null) {
  if (outcome === 'Speak') accept(g, turn.playerId, { type: 'Speak', text: 'One concrete point.', addressedTo, replyTo: turn.replyTo, commandId: randomUUID(), phaseId: g.phaseId }, 1);
  emit(g, 'ConversationOpportunityCompleted', 'Private turn.', [], turn.playerId, { ...turn, outcome } satisfies Completion);
}
function harness(g = game()) {
  let now = 1000;
  const requests: { r: Reservation; resolve: (value: SpeechResult) => void; reject: (error: Error) => void }[] = [];
  const timers: (() => void)[] = [];
  const logs: string[] = [];
  const controller = new ConversationController({
    get: () => g,
    request: (_state, r) => new Promise((resolve, reject) => requests.push({ r, resolve, reject })),
    publish: (_state, r, result) => complete(g, r.turn, result.type, result.addressedTo),
    fail: (_state, message) => pause(g, now, message),
    log: event => { logs.push(event); },
  }, () => now, fn => { timers.push(fn); return () => {}; });
  return { g, controller, requests, timers, logs, advance: (ms: number) => { now += ms; }, start: () => controller.run(g.id) };
}
const reply: SpeechResult = { type: 'Speak', text: 'A fresh point.', targets: [], addressedTo: null };
const pass: SpeechResult = { type: 'Pass', text: '', targets: [], addressedTo: null };

test('direct accusations route before unrelated players and do not depend on secret roles', () => {
  const g = game(); say(g, 'p0', 'p2', 'Josie, why should we trust you?');
  const turn = chooseTurn(g)!; assert.equal(turn.playerId, 'p2'); assert.equal(turn.reason, 'answer a direct message');
  g.players.forEach(p => p.role = 'Mafia'); g.investigations.p2 = { p1: 'Sheriff' };
  assert.deepEqual(chooseTurn(g), turn);
});
test('deterministic aliases reject ambiguous Ryan and multiple names; explicit targets win', () => {
  const g = game();
  for (const text of ['Ryan, explain.', 'Sam and Josie disagree.', 'Ryan Beiermeister, ask Ryan.', 'Nobody here.']) assert.equal(inferAddressee(text, g.players), null);
  assert.equal(inferAddressee('Ryan Petersen, explain.', g.players), 'p8');
  assert.equal(inferAddressee('Josie’s claim?', g.players), 'p2');
  say(g, 'p0', 'p7', 'Ryan and Josie, explain.'); assert.equal(metadata(speech(g).at(-1)).addressedTo, 'p7');
  say(g, 'p0', null, 'Josie, explain.'); assert.equal(metadata(speech(g).at(-1)).addressedTo, 'p2');
  g.players[7].alive = false; assert.equal(inferAddressee('Ryan?', g.players), null);
});
test('human interruption holds reservation until settlement and discards stale reply', async () => {
  const h = harness(); const first = h.start(); assert.equal(h.requests.length, 1);
  say(h.g, 'p0', 'p2'); h.controller.published(h.g); h.controller.cancel(h.g.id, 'new human speech');
  h.advance(1000); await h.start(); assert.equal(h.requests.length, 1);
  h.requests[0].resolve(reply); await first;
  assert.equal(speech(h.g).length, 1); assert.equal(h.g.status, 'RUNNING');
  const second = h.start(); assert.equal(h.requests[1].r.turn.playerId, 'p2');
  h.requests[1].resolve(reply); await second;
  assert.equal(speech(h.g).at(-1)?.actor, 'p2'); assert.ok(h.logs.some(x => x.includes('STALE')));
});
for (const change of ['pause', 'pause-resume', 'elimination', 'phase', 'deadline', 'cancel', 'human-revision'] as const) test(`late reply cannot escape ${change}`, async () => {
  const h = harness(); const run = h.start();
  if (change === 'pause') pause(h.g, 1000, 'Pause');
  if (change === 'pause-resume') { h.controller.cancel(h.g.id, 'pause'); pause(h.g, 1000, 'Pause'); resume(h.g, 1001); }
  if (change === 'elimination') h.g.players[1].alive = false;
  if (change === 'phase') { h.g.phase = 'NOMINATIONS'; h.g.phaseId = 'new'; }
  if (change === 'deadline') h.advance(60_000);
  if (change === 'cancel') h.controller.cancel(h.g.id, 'leave');
  if (change === 'human-revision') say(h.g);
  const before = speech(h.g).length;
  h.requests[0].resolve(reply); await run;
  assert.equal(speech(h.g).length, before); assert.equal(h.controller.hasPending(h.g.id), false);
});
test('private events and request counters do not invalidate speech', async () => {
  const h = harness(); const run = h.start();
  emit(h.g, 'PrivateDiagnostic', 'private', [], 'p4'); h.g.aiCalls++; h.g.version++;
  h.requests[0].resolve(reply); await run; assert.equal(speech(h.g).length, 1);
});
test('all passes remain private and wait for new dialogue', async () => {
  const h = harness();
  for (let i = 0; i < 11; i++) { const run = h.start(); assert.equal(h.requests.length, i + 1); h.requests[i].resolve(pass); await run; }
  await h.start(); assert.equal(h.requests.length, 11); assert.equal(speech(h.g).length, 0);
  assert.ok(!playerView(h.g, 'p0').events.some(e => e.type === 'ConversationOpportunityCompleted'));
  say(h.g, 'p0', 'p1'); h.controller.published(h.g); h.advance(800);
  const run = h.start(); assert.equal(h.requests[11].r.turn.playerId, 'p1'); h.requests[11].resolve(pass); await run;
});
test('two directed replies invite another player; fresh human direction overrides fairness', () => {
  const g = game(); say(g, 'p0', 'p1'); complete(g, chooseTurn(g)!, 'Speak', 'p2'); complete(g, chooseTurn(g)!, 'Speak', 'p1');
  const third = chooseTurn(g)!; assert.equal(third.playerId, 'p3'); assert.equal(third.reason, 'contribute another perspective');
  say(g, 'p0', 'p2'); assert.equal(chooseTurn(g)!.playerId, 'p2');
});
test('fairness orders by fewest opportunities, oldest opportunity, then seat; no consecutive turns', () => {
  const g = game();
  for (let i = 1; i <= 11; i++) { const turn = chooseTurn(g)!; assert.equal(turn.playerId, `p${i}`); complete(g, turn, 'Speak'); }
  assert.equal(chooseTurn(g)!.playerId, 'p1');
  complete(g, chooseTurn(g)!, 'Speak'); assert.equal(chooseTurn(g)!.playerId, 'p2');
});
test('800ms public gap and four seconds for a human reply use the supplied clock', async () => {
  const h = harness(); say(h.g); h.controller.published(h.g);
  await h.start(); h.advance(799); await h.start(); assert.equal(h.requests.length, 0);
  h.advance(1); const run = h.start(); h.requests[0].resolve({ ...reply, addressedTo: 'p0' }); await run;
  h.advance(3999); await h.start(); assert.equal(h.requests.length, 1);
  h.advance(1); const next = h.start(); h.requests[1].resolve(pass); await next;
});
test('open-phase timeout pauses once and retains the slot until transport settles', async () => {
  const h = harness(); const run = h.start(); h.timers[0](); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.g.status, 'PAUSED'); assert.match(h.g.pauseReason!, /timed out.*resume/);
  assert.equal(h.controller.hasPending(h.g.id), true);
  h.requests[0].resolve(reply); await run; assert.equal(speech(h.g).length, 0);
  await h.start(); assert.equal(h.requests.length, 1);
});
test('transport failures pause, intentional cancellation errors do not', async () => {
  for (const intentional of [true, false]) {
    const h = harness(); const run = h.start(); if (intentional) h.controller.cancel(h.g.id, 'human speech');
    h.requests[0].reject(new Error('Connection failed')); await run;
    assert.equal(h.g.status, intentional ? 'RUNNING' : 'PAUSED');
  }
});
test('defense restricts floor and allows one accepted AI defense including legacy speech', () => {
  const g = game(); g.phase = 'DEFENSE_1'; g.nominees = ['p2', 'p3'];
  assert.equal(chooseTurn(g)!.playerId, 'p2'); assert.throws(() => say(g, 'p1'));
  say(g, 'p2'); assert.equal(chooseTurn(g), undefined); assert.throws(() => say(g, 'p2'));
  g.phase = 'DEFENSE_2'; g.phaseId = 'defense2'; assert.equal(chooseTurn(g)!.playerId, 'p3');
});
test('invalid references, private references, eliminated targets and changed command payloads are rejected', () => {
  const g = game(); say(g); const ref = revision(g);
  const c = { type: 'Speak' as const, text: 'Answer.', commandId: 'same', phaseId: g.phaseId, replyTo: ref, addressedTo: 'p1' };
  accept(g, 'p0', c, 1); assert.equal(accept(g, 'p0', c, 2), false);
  for (const change of [{ replyTo: null }, { addressedTo: 'p2' }, { text: 'Changed' }]) assert.throws(() => accept(g, 'p0', { ...c, ...change }, 2), /reused/);
  emit(g, 'SpeechPublished', 'private speech', ['p0']); const privateRef = g.events.at(-1)!.seq;
  for (const replyTo of [9999, privateRef, 1, 1.5]) assert.throws(() => accept(g, 'p0', { ...c, commandId: randomUUID(), replyTo }, 2), /public speech/);
  g.players[1].alive = false; assert.throws(() => accept(g, 'p0', { ...c, commandId: randomUUID() }, 2), /living/);
});
test('recovery preserves atomic turn records, pass eligibility and secret boundaries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mafia-conversation-')); const store = new Storage(join(dir, 'test.sqlite'));
  try {
    const g = game(); say(g, 'p0', 'p1'); complete(g, chooseTurn(g)!, 'Pass'); complete(g, chooseTurn(g)!, 'Speak'); complete(g, chooseTurn(g)!, 'Pass');
    const expected = chooseTurn(g); store.save(g);
    const restored = store.recover(5000)[0]; assert.equal(restored.status, 'PAUSED'); assert.deepEqual(chooseTurn(restored), expected);
    assert.deepEqual(restored.events.filter(e => e.type === 'ConversationOpportunityCompleted'), g.events.filter(e => e.type === 'ConversationOpportunityCompleted'));
    assert.equal((store.db.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n, restored.events.length);
    restored.players[0].alive = false;
    assert.ok(!playerView(restored, 'p0').events.some(e => e.type === 'ConversationOpportunityCompleted'));
    const view = playerView(restored, 'p6'); assert.equal(view.players[1].role, undefined);
    assert.equal(view.events.some(e => e.type === 'ConversationOpportunityCompleted'), false);
    const prompt = JSON.stringify(conversationContext(view, expected!)); assert.ok(!prompt.includes('RolesAssigned')); assert.ok(!prompt.includes('ConversationOpportunityCompleted'));
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});
test('speech context keeps last 40 messages plus old reference, with names and engine facts separate', () => {
  const g = game(); say(g, 'p0'); const old = revision(g);
  for (let i = 0; i < 45; i++) say(g, 'p1', null, `Claim ${i}`);
  const c = conversationContext(playerView(g, 'p5'), { playerId: 'p5', reason: 'answer a direct message', replyTo: old, revision: revision(g) });
  assert.equal(c.playerDialogue.length, 41); assert.equal(c.playerDialogue[0].id, old); assert.equal(c.playerDialogue[0].speaker, 'Louis');
  assert.ok(c.engineFacts.events.every(e => e.type !== 'SpeechPublished')); assert.equal(c.engineFacts.players[0].role, undefined);
});
test('live adapter requests Speak/Pass, target IDs, and purposeful attributed context', async () => {
  const g = game(); say(g, 'p0', 'p2'); const turn = chooseTurn(g)!;
  const mock: typeof fetch = async (_url, init) => {
    const body = JSON.parse(init!.body as string), input = JSON.parse(body.input);
    assert.deepEqual(body.text.format.schema.properties.type.enum, ['Speak', 'Pass']);
    assert.equal(input.authorizedGameView.opportunity.replyTo, revision(g));
    assert.match(body.instructions, /does not establish/);
    return new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(pass) }] }] }));
  };
  assert.deepEqual(await openaiAction('test', MODEL, personas[1], playerView(g, 'p2'), 'Speak', new AbortController().signal, mock, 'test', turn), pass);
});
