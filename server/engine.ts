import { inferAddressee } from './conversation.js';
import { randomInt, randomUUID } from 'node:crypto';
import type { Action, Command, Event, Game, Legal, PersonaPrompt, Phase, Player, Role, Timing, View } from '../shared/types.js';

export const RULES_VERSION = 'abmafia.v1';
export const STANDARD: Timing = { mafia: 20_000, ability: 30_000, discussion: 60_000, nominations: 30_000, defense: 15_000, vote: 30_000 };
// Quick changes only the draft's configurable night/ballot windows; discussion and defenses retain their agreed durations.
export const QUICK: Timing = { ...STANDARD, mafia: 8_000, ability: 10_000, nominations: 20_000, vote: 20_000 };
export type Draw = (upper: number) => number;
export const secureDraw: Draw = upper => randomInt(upper);
export class RuleError extends Error {}
function requireRule(condition: unknown, message: string): asserts condition { if (!condition) throw new RuleError(message); }
export function living(g: Game) { return g.players.filter(p => p.alive); }
export function emit(g: Game, type: string, text: string, audience: Event['audience'] = 'public', actor?: string, data?: unknown) {
  g.events.push({ seq: g.events.length + 1, round: g.round, phaseId: g.phaseId, type, text, audience, actor, ...(data === undefined ? {} : { data }) });
}
function duration(g: Game, phase: Phase) {
  return phase === 'MAFIA' ? g.timing.mafia : phase === 'ANGEL' || phase === 'SHERIFF' ? g.timing.ability :
    phase === 'DISCUSSION' ? g.timing.discussion : phase === 'NOMINATIONS' ? g.timing.nominations :
    phase === 'VOTE' ? g.timing.vote : g.timing.defense;
}
export function activeSpeaker(g: Game) { return g.phase === 'DEFENSE_1' ? g.nominees[0] : g.phase === 'DEFENSE_2' ? g.nominees[1] : undefined; }
function open(g: Game, phase: Phase, now: number) {
  g.phase = phase; g.phaseId = `${g.id}:${g.events.length + 1}:${phase}`; g.deadline = now + duration(g, phase); g.remaining = duration(g, phase);
  g.abilityDone = false;
  const labels: Record<Phase, string> = {
    MAFIA: 'Night falls. Mafia, choose your target in silence.', ANGEL: 'Angel, choose someone to protect.',
    SHERIFF: 'Sheriff, choose someone to investigate.', DISCUSSION: 'The table is open. You have one minute.',
    NOMINATIONS: 'Secret ballot. Nominate two different living players.',
    DEFENSE_1: `${g.players.find(p => p.id === g.nominees[0])?.name}, your defense.`,
    DEFENSE_2: `${g.players.find(p => p.id === g.nominees[1])?.name}, your defense.`,
    VOTE: `Public vote${g.voteAttempt === 2 ? ' · second attempt' : ''}. Choose one nominee.`,
  };
  emit(g, 'PhaseOpened', labels[phase]);
}
function choose(g: Game, candidates: string[], count: number, purpose: string, draw: Draw) {
  const pool = [...candidates], result: string[] = [];
  for (let i = 0; i < count; i++) result.push(pool.splice(draw(pool.length), 1)[0]);
  emit(g, 'RandomSelection', purpose, [], undefined, { candidates, selected: result });
  return result;
}
export function createGame(session: string, personas: PersonaPrompt[], name: string, speed: Game['speed'], model: string, now = Date.now(), draw = secureDraw): Game {
  requireRule(personas.length === 11 && new Set(personas.map(p => p.id)).size === 11, 'Eleven unique personas are required.');
  const roles: Role[] = ['Mafia', 'Mafia', 'Mafia', 'Angel', 'Sheriff', ...Array<Role>(7).fill('Townsperson')];
  for (let i = roles.length - 1; i > 0; i--) { const j = draw(i + 1); [roles[i], roles[j]] = [roles[j], roles[i]]; }
  const roster = [{ id: 'human', name: name.trim() || 'You' }, ...personas];
  const players = roster.map((p, seat) => ({ id: `p${seat}`, name: p.name, personaId: p.id, seat, human: seat === 0, alive: true, role: roles[seat] }));
  const g: Game = {
    id: randomUUID(), session, version: 0, rulesVersion: RULES_VERSION, mode: 'openai', model, speed,
    timing: { ...(speed === 'quick' ? QUICK : STANDARD) }, status: 'RUNNING', remaining: 0,
    round: 1, phase: 'MAFIA', phaseId: '', deadline: 0, players, personas: Object.fromEntries(personas.map(p => [p.id, p])),
    pointers: {}, firstPointer: null, kill: null, protection: null, previousProtection: null, abilityDone: false,
    investigations: {}, nominations: {}, nominees: [], votes: {}, voteAttempt: 1, events: [], receipts: {}, aiCalls: 0,
  };
  emit(g, 'GameCreated', 'Twelve seats. Three Mafia. Trust carefully. OpenAI personas are active.');
  emit(g, 'RolesAssigned', 'Roles assigned.', [], undefined, players.map(p => ({ id: p.id, role: p.role })));
  open(g, 'MAFIA', now);
  return g;
}
export function legalActions(g: Game, id: string): Legal {
  const p = g.players.find(p => p.id === id);
  if (!p?.alive || g.status !== 'RUNNING') return [];
  const ids = living(g).map(p => p.id);
  if (g.phase === 'MAFIA' && p.role === 'Mafia') return [{ type: 'Point', targets: living(g).filter(p => p.role !== 'Mafia').map(p => p.id), count: 1 }];
  if (g.phase === 'ANGEL' && p.role === 'Angel' && !g.abilityDone)
    return [{ type: 'Protect', targets: ids.filter(id => id !== g.previousProtection), count: 1 }, { type: 'SkipAbility', targets: [], count: 0 }];
  if (g.phase === 'SHERIFF' && p.role === 'Sheriff' && !g.abilityDone)
    return [{ type: 'Investigate', targets: ids.filter(target => target !== id), count: 1 }, { type: 'SkipAbility', targets: [], count: 0 }];
  if (g.phase === 'DISCUSSION' || activeSpeaker(g) === id) return [{ type: 'Speak', targets: [], count: 0 }];
  if (g.phase === 'NOMINATIONS' && !g.nominations[id]) return [{ type: 'Nominate', targets: ids, count: 2 }];
  if (g.phase === 'VOTE' && !g.votes[id]) return [{ type: 'Vote', targets: g.nominees, count: 1 }];
  return [];
}
export function checkWinner(g: Game) {
  const alive = living(g), mafia = alive.filter(p => p.role === 'Mafia').length;
  const winner = mafia === 0 ? 'Town' : mafia >= alive.length - mafia ? 'Mafia' : undefined;
  if (!winner) return false;
  g.status = 'FINISHED'; g.winner = winner; g.remaining = 0;
  emit(g, 'GameFinished', `${winner} wins. All roles are now revealed.`);
  return true;
}
function eliminate(g: Game, id: string, cause: string) {
  const p = g.players.find(p => p.id === id)!;
  requireRule(p.alive, 'Player has already been eliminated.');
  p.alive = false;
  emit(g, 'PlayerEliminated', `${p.name} ${cause}. Their role remains hidden.`, 'public', id);
}
function nextNight(g: Game, now: number) {
  g.round++; g.pointers = {}; g.firstPointer = null; g.kill = null; g.protection = null;
  g.nominations = {}; g.nominees = []; g.votes = {}; g.voteAttempt = 1;
  open(g, 'MAFIA', now);
}
function selectNominees(g: Game, now: number, draw: Draw) {
  const totals: Record<string, number> = Object.fromEntries(living(g).map(p => [p.id, 0]));
  Object.values(g.nominations).flat().forEach(id => totals[id]++);
  const chosen: string[] = [];
  for (const score of [...new Set(Object.values(totals))].sort((a, b) => b - a)) {
    const group = Object.keys(totals).filter(id => totals[id] === score), needed = 2 - chosen.length;
    if (!needed) break;
    chosen.push(...(group.length > needed ? choose(g, group, needed, 'Nomination cutoff tie', draw) : group));
  }
  g.nominees = chosen.sort((a, b) => g.players.find(p => p.id === a)!.seat - g.players.find(p => p.id === b)!.seat);
  emit(g, 'NomineesSelected', `On trial: ${g.nominees.map(id => g.players.find(p => p.id === id)!.name).join(' and ')}.`);
  open(g, 'DEFENSE_1', now);
}
function resolveVote(g: Game, now: number, draw: Draw) {
  const [a, b] = g.nominees;
  const countA = Object.values(g.votes).filter(id => id === a).length;
  const countB = Object.values(g.votes).filter(id => id === b).length;
  if (countA === countB && g.voteAttempt === 1) {
    g.voteAttempt = 2; g.votes = {};
    emit(g, 'VoteTied', 'A tie. Both nominees will defend again before a fresh vote.');
    open(g, 'DEFENSE_1', now); return;
  }
  const victim = countA === countB ? choose(g, [a, b], 1, 'Second vote tie', draw)[0] : countA > countB ? a : b;
  eliminate(g, victim, 'was eliminated by the town');
  if (!checkWinner(g)) nextNight(g, now);
}
export function pause(g: Game, now: number, reason: string) {
  if (g.status !== 'RUNNING') return;
  g.remaining = Math.max(0, g.deadline - now); g.status = 'PAUSED'; g.pauseReason = reason;
  emit(g, 'GamePaused', reason);
}
export function resume(g: Game, now: number) {
  requireRule(g.status === 'PAUSED', 'Game is not paused.');
  g.status = 'RUNNING'; g.deadline = now + (g.remaining || duration(g, g.phase));
  delete g.pauseReason; emit(g, 'GameResumed', 'Play resumed.');
}
export function tick(g: Game, now: number, draw = secureDraw) {
  if (g.status !== 'RUNNING' || now < g.deadline) return false;
  switch (g.phase) {
    case 'MAFIA': {
      if (!g.firstPointer) { pause(g, now, 'No Mafia choice was received. Resume to retry the pending phase.'); break; }
      const pointers = living(g).filter(p => p.role === 'Mafia').map(p => g.pointers[p.id]);
      g.kill = pointers[0] && pointers.every(p => p === pointers[0]) ? pointers[0] : g.firstPointer;
      emit(g, 'KillSelected', 'Mafia target selected.', [], undefined, { target: g.kill });
      open(g, 'ANGEL', now); break;
    }
    case 'ANGEL': open(g, 'SHERIFF', now); break;
    case 'SHERIFF':
      if (g.kill === g.protection) emit(g, 'DawnAnnounced', 'Dawn breaks. Nobody died.');
      else if (g.kill) eliminate(g, g.kill, 'was killed during the night');
      g.previousProtection = g.protection;
      if (!checkWinner(g)) open(g, 'DISCUSSION', now);
      break;
    case 'DISCUSSION': open(g, 'NOMINATIONS', now); break;
    case 'NOMINATIONS':
      if (living(g).every(p => g.nominations[p.id])) selectNominees(g, now, draw);
      else pause(g, now, 'A required nomination is missing. Existing ballots are saved; resume to collect the rest.');
      break;
    case 'DEFENSE_1': open(g, 'DEFENSE_2', now); break;
    case 'DEFENSE_2': g.votes = {}; open(g, 'VOTE', now); break;
    case 'VOTE':
      if (living(g).every(p => g.votes[p.id])) resolveVote(g, now, draw);
      else pause(g, now, 'A required vote is missing. Existing votes are saved; resume to collect the rest.');
      break;
  }
  return true;
}
export function accept(g: Game, actor: string, c: Command, now: number, draw = secureDraw) {
  const fingerprint = JSON.stringify({ phaseId: c.phaseId, type: c.type, targets: c.targets || [], text: c.text || '', ...(c.replyTo !== undefined ? { replyTo: c.replyTo } : {}), ...(c.addressedTo !== undefined ? { addressedTo: c.addressedTo } : {}) });
  const prior = g.receipts[c.commandId];
  if (prior) { requireRule(prior.actor === actor && prior.fingerprint === fingerprint, 'Command ID was reused.'); return false; }
  requireRule(c.phaseId === g.phaseId, 'That phase has ended.');
  requireRule(g.status === 'RUNNING' && now < g.deadline, 'The action window is closed.');
  const legal = legalActions(g, actor).find(a => a.type === c.type);
  requireRule(legal, 'That action is not available.');
  const targets = c.targets || [];
  requireRule(targets.length === legal.count && new Set(targets).size === targets.length && targets.every(id => legal.targets.includes(id)), 'Choose the required number of legal targets.');
  requireRule(c.type === 'Speak' || !c.text, 'This action does not permit speech.');
  requireRule(c.type === 'Speak' || (c.replyTo === undefined && c.addressedTo === undefined), 'Only speech permits conversation references.');
  if (c.type === 'Speak') {
    requireRule(c.replyTo == null || (Number.isSafeInteger(c.replyTo) && g.events.some(e => e.seq === c.replyTo && e.type === 'SpeechPublished' && e.audience === 'public')), 'Reply must reference an existing public speech message.');
    requireRule(c.addressedTo == null || g.players.some(p => p.id === c.addressedTo && p.alive), 'Address a living player or the table.');
    requireRule(g.phase === 'DISCUSSION' || g.players.find(p => p.id === actor)!.human || !g.events.some(e => e.phaseId === g.phaseId && e.type === 'SpeechPublished' && e.actor === actor), 'Only one AI defense is allowed.');
  }
  if (c.type === 'Speak') requireRule(typeof c.text === 'string' && c.text.trim().length > 0 && c.text.length <= 600, 'Speech must be 1–600 characters.');
  const name = g.players.find(p => p.id === actor)!.name;
  switch (c.type) {
    case 'Point':
      g.pointers[actor] = targets[0]; g.firstPointer ??= targets[0];
      emit(g, 'PointerAccepted', `${name} points.`, g.players.filter(p => p.role === 'Mafia').map(p => p.id), actor, { target: targets[0] }); break;
    case 'Protect':
      g.protection = targets[0]; g.abilityDone = true;
      emit(g, 'ProtectionSubmitted', 'Your protection is locked in.', [actor], actor, { target: targets[0] }); break;
    case 'Investigate': {
      const target = g.players.find(p => p.id === targets[0])!;
      (g.investigations[actor] ??= {})[target.id] = target.role; g.abilityDone = true;
      emit(g, 'InvestigationResolved', `${target.name} is ${target.role}.`, [actor], actor, { target: target.id, role: target.role }); break;
    }
    case 'SkipAbility': g.abilityDone = true; emit(g, 'AbilitySkipped', 'You skipped this ability.', [actor], actor); break;
    case 'Speak': emit(g, 'SpeechPublished', c.text!.trim(), 'public', actor, { replyTo: c.replyTo ?? null, addressedTo: c.addressedTo ?? (g.players.find(p => p.id === actor)!.human ? inferAddressee(c.text!, g.players) : null) }); break;
    case 'Nominate': g.nominations[actor] = targets; emit(g, 'NominationSubmitted', 'Your nominations are locked in.', [actor], actor, { targets }); break;
    case 'Vote':
      g.votes[actor] = targets[0];
      emit(g, 'VoteCast', `${name} voted for ${g.players.find(p => p.id === targets[0])!.name}.`, 'public', actor, { target: targets[0] }); break;
  }
  g.receipts[c.commandId] = { actor, fingerprint };
  if (g.phase === 'NOMINATIONS' && living(g).every(p => g.nominations[p.id])) selectNominees(g, now, draw);
  if (g.phase === 'VOTE' && living(g).every(p => g.votes[p.id])) resolveVote(g, now, draw);
  return true;
}
export function playerView(g: Game, id: string, now = Date.now()): View {
  const p = g.players.find(p => p.id === id)!;
  // Only the human gets an omniscient spectator view. Dead AI retain restricted knowledge.
  const spectator = p.human && (!p.alive || g.status === 'FINISHED');
  const known = g.investigations[id] || {};
  return {
    id: g.id, version: g.version, status: g.status, phase: g.phase, phaseId: g.phaseId, round: g.round,
    deadline: g.deadline, remaining: g.status === 'RUNNING' ? Math.max(0, g.deadline - now) : g.remaining,
    serverNow: now, pauseReason: g.pauseReason, mode: g.mode, model: g.model, speed: g.speed, winner: g.winner, aiCalls: g.aiCalls,
    self: id, spectator,
    players: g.players.map(({ role, ...other }) => ({ ...other, ...(
      spectator || other.id === id || (p.role === 'Mafia' && role === 'Mafia') || known[other.id] ? { role } : {}
    ) })),
    events: g.events.filter(e => e.type !== 'ConversationOpportunityCompleted' && (spectator || e.audience === 'public' || e.audience.includes(id)))
      .map(({ audience: _, ...e }) => ({ ...e, audience: 'public' as const })),
    legal: legalActions(g, id), nominees: g.nominees, votes: g.votes, ownNomination: g.nominations[id],
    ...(p.role === 'Mafia' || spectator ? { pointers: g.pointers } : {}),
    ...(p.role === 'Angel' || spectator ? { protection: g.protection } : {}),
    investigations: known, activeSpeaker: activeSpeaker(g),
  };
}
