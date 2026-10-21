import { randomUUID } from 'node:crypto';
import type { Action, Event, Game, Player } from '../shared/types.js';

export type SpeechMeta = { replyTo?: number | null; addressedTo?: string | null };
export type Turn = { playerId: string; reason: 'answer a direct message' | 'contribute another perspective' | 'open discussion' | 'defend nomination'; replyTo: number | null; revision: number };
export type Completion = Turn & { outcome: 'Speak' | 'Pass' };
export type SpeechResult = Omit<Action, 'type'> & { type: 'Speak' | 'Pass' };
type PublicPlayer = Pick<Player, 'id' | 'name' | 'seat' | 'alive' | 'human'>;
export type ConversationState = Pick<Game, 'id' | 'status' | 'phase' | 'phaseId' | 'deadline' | 'nominees'> & { players: PublicPlayer[]; events: Event[] };
export const speech = (g: ConversationState) => g.events.filter(e => e.type === 'SpeechPublished' && e.audience === 'public');
export const revision = (g: ConversationState) => speech(g).at(-1)?.seq || 0;
export const metadata = (e?: Event): SpeechMeta => e?.data && typeof e.data === 'object' ? e.data as SpeechMeta : {};
const turns = (g: ConversationState) => g.events.filter(e => e.phaseId === g.phaseId && e.type === 'ConversationOpportunityCompleted');

// Full names take precedence over their own first/last-name fragments. Ambiguous aliases
// (including either Ryan) stay ambiguous even when one of those players is dead.
export function inferAddressee(text: string, players: PublicPlayer[]): string | null {
  const words = text.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) || [];
  const names = players.map(p => ({ p, words: Array.from(p.name.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) || []) }));
  const hits = new Set<string>();
  let ambiguous = false;
  for (let i = 0; i < words.length; i++) {
    const full = names.filter(n => n.words.length > 1 && n.words.every((w, j) => words[i + j] === w));
    if (full.length) {
      const longest = Math.max(...full.map(n => n.words.length));
      const matches = full.filter(n => n.words.length === longest);
      if (matches.length !== 1) ambiguous = true;
      matches.forEach(n => hits.add(n.p.id)); i += longest - 1;
    } else {
      const matches = names.filter(n => n.words.includes(words[i]));
      if (matches.length > 1) ambiguous = true;
      matches.forEach(n => hits.add(n.p.id));
    }
  }
  const id = [...hits][0];
  return !ambiguous && hits.size === 1 && players.find(p => p.id === id)?.alive ? id : null;
}

// Only public roster/dialogue plus completed opportunities enter the selector.
export function chooseTurn(g: ConversationState): Turn | undefined {
  const messages = speech(g), latest = messages.at(-1), rev = revision(g);
  const records = turns(g);
  const completed = records.map(e => ({ ...e.data as Completion, seq: e.seq }));
  const phaseSpeech = messages.filter(e => e.phaseId === g.phaseId);
  const nominee = g.phase === 'DEFENSE_1' ? g.nominees[0] : g.phase === 'DEFENSE_2' ? g.nominees[1] : undefined;
  if (nominee) {
    const p = g.players.find(p => p.id === nominee && p.alive && !p.human);
    if (p && !phaseSpeech.some(e => e.actor === p.id)) return { playerId: p.id, reason: 'defend nomination', replyTo: null, revision: rev };
    return;
  }
  if (g.phase !== 'DISCUSSION') return;
  const freshHuman = latest && g.players.find(p => p.id === latest.actor)?.human;
  const last = completed.at(-1);
  let eligible = g.players.filter(p => p.alive && !p.human &&
    !completed.some(t => t.playerId === p.id && t.outcome === 'Pass' && t.revision === rev) &&
    (freshHuman || (last ? p.id !== last.playerId : p.id !== latest?.actor)));
  // Legacy speech also counts, without double-counting new speech with a turn record.
  const counts = (id: string) => completed.filter(t => t.playerId === id).length + phaseSpeech.filter(e => e.actor === id && !records.some(t => t.actor === id && (t.data as Completion).outcome === 'Speak' && t.seq === e.seq + 1)).length;
  const oldest = (id: string) => Math.max(0, ...completed.filter(t => t.playerId === id).map(t => t.seq), ...phaseSpeech.filter(e => e.actor === id).map(e => e.seq));
  const tail = completed.slice(-2);
  const breakExchange = !freshHuman && tail.length === 2 && tail.every(t => t.reason === 'answer a direct message');
  if (breakExchange) eligible = eligible.filter(p => !tail.some(t => t.playerId === p.id));
  const target = metadata(latest).addressedTo;
  const directed = eligible.find(p => p.id === target && !completed.some(t => t.playerId === p.id && t.replyTo === latest?.seq));
  if (directed) return { playerId: directed.id, reason: 'answer a direct message', replyTo: latest!.seq, revision: rev };
  const p = eligible.sort((a, b) => counts(a.id) - counts(b.id) || oldest(a.id) - oldest(b.id) || a.seat - b.seat)[0];
  if (p) return { playerId: p.id, reason: phaseSpeech.length ? 'contribute another perspective' : 'open discussion', replyTo: latest?.seq || null, revision: rev };
}

export type Reservation = { id: string; phaseId: string; turn: Turn; ctrl: AbortController; cancellation?: string };
type Hooks = {
  get: (id: string) => ConversationState;
  request: (g: ConversationState, reservation: Reservation) => Promise<SpeechResult>;
  publish: (g: ConversationState, reservation: Reservation, result: SpeechResult) => void;
  fail: (g: ConversationState, message: string) => void;
  log: (event: string, data: unknown) => void;
};
export class ConversationController {
  private pending = new Map<string, Reservation>();
  private publications = new Map<string, { revision: number; at: number }>();
  constructor(private hooks: Hooks, private now = Date.now, private timer = (fn: () => void, ms: number) => { const id = setTimeout(fn, ms); return () => clearTimeout(id); }) {}
  hasPending(id: string) { return this.pending.has(id); }
  published(g: ConversationState) { this.publications.set(g.id, { revision: revision(g), at: this.now() }); }
  cancel(id: string, reason: string) {
    const r = this.pending.get(id);
    if (!r || r.cancellation) return;
    r.cancellation = reason; r.ctrl.abort();
    this.hooks.log('CONVERSATION · INTERRUPTION', { gameId: id, reservationId: r.id, reason });
  }
  private current(g: ConversationState, r: Reservation) {
    return this.pending.get(g.id) === r && !r.ctrl.signal.aborted && g.status === 'RUNNING' && g.phaseId === r.phaseId &&
      this.now() < g.deadline && revision(g) === r.turn.revision &&
      g.players.some(p => p.id === r.turn.playerId && p.alive && !p.human) &&
      (g.phase === 'DISCUSSION' || (g.phase === 'DEFENSE_1' ? g.nominees[0] : g.phase === 'DEFENSE_2' ? g.nominees[1] : undefined) === r.turn.playerId);
  }
  async run(id: string): Promise<void> {
    const g = this.hooks.get(id);
    if (this.hasPending(id) || g.status !== 'RUNNING' || this.now() >= g.deadline - 250) return;
    const latest = speech(g).at(-1);
    if (latest) {
      if (this.publications.get(id)?.revision !== latest.seq) this.published(g);
      const humanTarget = !g.players.find(p => p.id === latest.actor)?.human && g.players.find(p => p.id === metadata(latest).addressedTo)?.human;
      if (this.now() - this.publications.get(id)!.at < (humanTarget ? 4000 : 800)) return;
    }
    const turn = chooseTurn(g); if (!turn) return;
    const r: Reservation = { id: randomUUID(), phaseId: g.phaseId, turn, ctrl: new AbortController() };
    this.pending.set(id, r);
    this.hooks.log('CONVERSATION · SELECTED', { gameId: id, reservationId: r.id, player: g.players.find(p => p.id === turn.playerId)?.name, ...turn });
    // Race the transport against cancellation: a broken transport cannot stall a timeout.
    // On intentional interruption we still await transport settlement before releasing the slot.
    let timeoutReject: (error: Error) => void = () => {};
    const timeout = new Promise<never>((_, reject) => { timeoutReject = reject; });
    const clear = this.timer(() => {
      if (r.cancellation) return;
      r.cancellation = 'timeout'; r.ctrl.abort(); timeoutReject(new Error('Speech request timed out. Check your connection or OpenAI service, then resume to retry.'));
    }, Math.min(15_000, Math.max(1, g.deadline - this.now())));
    let transport: Promise<SpeechResult> | undefined;
    try {
      transport = this.hooks.request(g, r);
      const result = await Promise.race([transport, timeout]);
      const current = this.hooks.get(id);
      if (!this.current(current, r)) {
        this.hooks.log('CONVERSATION · STALE RESULT DISCARDED', { gameId: id, reservationId: r.id, revision: revision(current), expectedRevision: turn.revision }); return;
      }
      if (result.type !== 'Speak' && !(result.type === 'Pass' && g.phase === 'DISCUSSION')) throw new Error('AI returned an invalid speech decision. Resume to retry.');
      if (result.type === 'Pass' && (result.text || result.targets?.length || result.addressedTo != null)) throw new Error('AI returned an invalid pass. Resume to retry.');
      this.hooks.publish(current, r, { ...result, replyTo: turn.replyTo });
      if (result.type === 'Speak') this.published(this.hooks.get(id));
      this.hooks.log(result.type === 'Pass' ? 'CONVERSATION · PASS' : 'CONVERSATION ✓ ACCEPTED REPLY', { gameId: id, reservationId: r.id, ...turn, result });
    } catch (error) {
      const current = this.hooks.get(id);
      if ((r.cancellation && r.cancellation !== 'timeout') || current.status !== 'RUNNING' || current.phaseId !== r.phaseId || this.now() >= current.deadline || revision(current) !== turn.revision || !current.players.some(p => p.id === turn.playerId && p.alive)) return;
      this.hooks.fail(current, error instanceof Error ? error.message : 'AI speech failed. Resume to retry.');
    } finally {
      clear();
      // Keep the reservation until even a cancellation-ignoring transport settles.
      if (transport) await transport.catch(() => {});
      if (this.pending.get(id) === r) this.pending.delete(id);
    }
  }
}
