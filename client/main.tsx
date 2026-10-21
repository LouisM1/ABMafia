import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Action, Event, View } from '../shared/types';
import { enableClientDebug, reportClient } from './diagnostics';
import { Lounge } from './lounge';
import './style.css';

const PHASES: Record<string, string> = { MAFIA: 'Mafia coordination', ANGEL: 'Angel protection', SHERIFF: 'Sheriff investigation', DISCUSSION: 'Table discussion', NOMINATIONS: 'Secret nominations', DEFENSE_1: 'First defense', DEFENSE_2: 'Second defense', VOTE: 'Elimination vote' };
const ACTIONS: Record<string, string> = { Point: 'Confirm target', Protect: 'Protect player', Investigate: 'Investigate player', Nominate: 'Submit nominations', Vote: 'Cast vote' };
const PUBLIC_EVENTS = new Set(['SpeechPublished', 'GameCreated', 'PhaseOpened', 'PlayerEliminated', 'NomineesSelected', 'VoteTied', 'GamePaused', 'GameResumed', 'DawnAnnounced', 'VoteCast', 'GameFinished']);
type Session = { debug: boolean; connected: boolean; model: string; players: { id: string; name: string }[]; game: View | null };
type Reply = { playerId: string; messageId?: number };
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}
function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [game, setGame] = useState<View | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [targets, setTargets] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [reply, setReply] = useState<Reply | null>(null);
  const [now, setNow] = useState(Date.now());
  const [offset, setOffset] = useState(0);
  const [online, setOnline] = useState(true);
  const [speaker, setSpeaker] = useState<string>();
  const log = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const stickToBottom = useRef(true);
  const activeGameId = useRef<string | null>(null);
  function receive(view: View) {
    setGame(previous => previous?.id === view.id && previous.version > view.version ? previous : view);
    setOffset(view.serverNow - Date.now());
  }
  useEffect(() => {
    api<Session>('/session').then(s => {
      enableClientDebug(s.debug); setSession(s);
      if (s.game && s.game.status !== 'ABANDONED') { activeGameId.current = s.game.id; receive(s.game); }
    }).catch(e => setError(e.message));
  }, []);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (!game?.id) return;
    let active = true;
    const id = game.id, stream = new EventSource(`/api/games/${id}/events`);
    stream.onopen = () => { if (active) setOnline(true); reportClient('stream-connected', { gameId: id }); };
    stream.onmessage = event => {
      if (!active || activeGameId.current !== id) return;
      try { receive(JSON.parse(event.data)); setOnline(true); }
      catch (error) { reportClient('stream-invalid', { error }); }
    };
    stream.onerror = () => { if (active) setOnline(false); reportClient('stream-reconnecting', { gameId: id }); };
    return () => { active = false; stream.close(); };
  }, [game?.id]);
  useEffect(() => { setTargets([]); setMessage(''); setReply(null); stickToBottom.current = true; }, [game?.id, game?.phaseId]);
  const lastSpeech = game?.events.filter(e => e.type === 'SpeechPublished').at(-1);
  useEffect(() => {
    setSpeaker(lastSpeech?.actor);
    const timeout = setTimeout(() => setSpeaker(undefined), 4000);
    return () => clearTimeout(timeout);
  }, [game?.id, lastSpeech?.seq]);
  useEffect(() => { if (log.current && stickToBottom.current) log.current.scrollTop = log.current.scrollHeight; }, [game?.events.length]);
  useEffect(() => { if (reply && !game?.players.some(p => p.id === reply.playerId && p.alive)) setReply(null); }, [game?.players, reply]);
  async function attempt(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError('');
    try { await fn(); }
    catch (e) { reportClient('action-error', { error: e }); setError(e instanceof Error ? e.message : 'Something went wrong.'); }
    finally { setBusy(false); }
  }
  async function start() {
    await attempt(async () => {
      if (!session?.connected) throw new Error('Add OPENAI_API_KEY to the project’s .env file, then restart the server and refresh this page.');
      const view = await api<View>('/games', { name: 'You', speed: 'quick' });
      activeGameId.current = view.id; setOnline(true); receive(view);
    });
  }
  async function control(operation: 'pause' | 'resume' | 'leave') {
    if (!game) return;
    await attempt(async () => {
      const view = await api<View>(`/games/${game.id}/control`, { operation });
      if (operation === 'leave') { activeGameId.current = null; setGame(null); setOnline(true); }
      else receive(view);
    });
  }
  async function action(type: Action['type']) {
    if (!game) return;
    await attempt(async () => {
      const view = await api<View>(`/games/${game.id}/actions`, {
        commandId: crypto.randomUUID(), phaseId: game.phaseId, type,
        targets: type === 'Speak' || type === 'SkipAbility' ? [] : targets,
        ...(type === 'Speak' ? { text: message, addressedTo: reply?.playerId ?? null, replyTo: reply?.messageId ?? null } : {}),
      });
      receive(view); setTargets([]); setMessage(''); setReply(null); stickToBottom.current = true;
      if (type === 'Speak') composer.current?.focus();
    });
  }
  const players = game?.players ?? [{ id: 'p0', personaId: 'human', name: 'You', seat: 0, human: true, alive: true }, ...(session?.players ?? []).map((p, i) => ({ ...p, personaId: p.id, id: `p${i + 1}`, seat: i + 1, human: false, alive: true }))];
  const legal = game?.legal[0];
  const running = game?.status === 'RUNNING';
  const canSpeak = !!(running && online && legal?.type === 'Speak');
  const canChoose = !!(running && online && legal && legal.count > 0);
  const self = game?.players.find(p => p.id === game.self);
  const night = !!game && ['MAFIA', 'ANGEL', 'SHERIFF'].includes(game.phase) && game.status !== 'FINISHED';
  const seconds = game ? Math.max(0, Math.ceil((running ? game.deadline - now - offset : game.remaining) / 1000)) : 0;
  const selected = canChoose ? targets : reply ? [reply.playerId] : [];
  const eligible = busy ? [] : canChoose ? legal!.targets : canSpeak ? players.filter(p => p.alive && !p.human).map(p => p.id) : [];
  function choose(id: string) {
    if (busy) return;
    if (canChoose && legal?.targets.includes(id)) setTargets(old => old.includes(id) ? old.filter(t => t !== id) : legal.count === 1 ? [id] : old.length < legal.count ? [...old, id] : [old[1], id]);
    else if (canSpeak && id !== game?.self && players.some(p => p.id === id && p.alive)) { setReply({ playerId: id }); composer.current?.focus(); }
  }
  function replyTo(event: Event) {
    if (!canSpeak || !event.actor || !players.some(p => p.id === event.actor && p.alive)) return;
    setReply({ playerId: event.actor, messageId: event.seq }); composer.current?.focus();
  }
  const speakerName = players.find(p => p.id === game?.activeSpeaker)?.name;
  const waiting = !game ? 'Start a game to join the conversation.' : game.status === 'FINISHED' ? 'The game is over.' : game.status === 'PAUSED' ? 'Resume the game to continue.' : game.spectator ? 'You’re watching as a spectator.' : night ? 'Night falls. The table is silent.' : speakerName ? `${speakerName} has the floor.` : game.phase === 'NOMINATIONS' ? 'Choose two players to nominate.' : game.phase === 'VOTE' ? 'Cast your vote at the table.' : 'Waiting for the table…';
  const events = game?.events.filter(e => PUBLIC_EVENTS.has(e.type)) ?? [];
  return <div class="app-shell">
    <header class="topbar">
      <a href="/" class="brand" aria-label="ABMafia home"><span class="brand-mark">♠</span><span>ABMAFIA</span></a>
      <span class="edition">THE PRIVATE TABLE</span>
      <div class="top-actions">
        {game && game.status !== 'FINISHED' ? <><button class="quiet" disabled={busy} onClick={() => void control(running ? 'pause' : 'resume')}>{running ? 'Pause game' : 'Resume game'}</button><button class="quiet leave" disabled={busy} onClick={() => void control('leave')}>Leave table</button></> : <span class="header-note">One human. Eleven AI. Three liars.</span>}
      </div>
    </header>
    {error && <div role="alert" class="notice error">{error}<button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
    {!online && game && <div role="status" class="notice">Reconnecting to the table. Your accepted actions are saved.</div>}
    {game?.status === 'PAUSED' && <div role="status" class="notice">{game.pauseReason}<button disabled={busy} onClick={() => void control('resume')}>Resume ↗</button></div>}
    <main class="game-layout">
      <section class="play-area" aria-label="Mafia game table">
        <div class="scene-wrap">
          <Lounge players={players} selected={selected} eligible={eligible} speaking={running ? game?.activeSpeaker || speaker : undefined} night={night} onChoose={choose}/>
          <div class="scene-heading">
            <div class="scene-eyebrow">{game ? `ROUND ${game.round} · ${players.filter(p => p.alive).length} AT THE TABLE` : 'WELCOME TO THE CLUB'}</div>
            <h1>{game?.winner ? `${game.winner} wins.` : game ? PHASES[game.phase] : 'Trust is a gamble.'}</h1>
            {!game && <p>Take your seat. Read the room.<br/>Find the Mafia before they find you.</p>}
          </div>
          {game && game.status !== 'FINISHED' && <div class="phase-clock" aria-label={running ? `${seconds} seconds remaining` : 'Game paused'}>{running ? `${seconds}s` : 'Paused'}</div>}
          <div class="scene-footnote">{game ? self?.alive ? 'YOUR SEAT IS AT THE FRONT OF THE TABLE' : 'EMPTY CHAIRS MARK ELIMINATED PLAYERS' : 'TWELVE SEATS. ONE TABLE. TRUST CAREFULLY.'}</div>
        </div>
        <div class="table-controls">
          {!game ? <div class="start-row"><div><h2>A seat is waiting.</h2><p>3 Mafia · 1 Angel · 1 Sheriff · 7 Townspeople</p></div><button class="primary start-game" disabled={busy || !session} onClick={() => void start()}>{busy ? 'Taking your seat…' : 'Start game'} <span>↗</span></button><small>Live AI opponents · Uses your configured OpenAI account.</small></div> : <>
            <div class="role-line"><span class={`role-card ${self?.role === 'Mafia' ? 'mafia' : ''}`}><small>{game.spectator ? 'SPECTATOR · YOUR ROLE' : 'YOUR SECRET ROLE'}</small><strong>{self?.role}</strong></span><div class="phase-instructions">
              <h2>{game.status === 'FINISHED' ? `${game.winner} takes the table.` : game.status === 'PAUSED' ? 'The table is paused.' : game.spectator ? 'Watch the surviving players.' : canChoose ? legal?.count === 2 ? 'Nominate two different players.' : 'Choose a player.' : canSpeak ? game.activeSpeaker ? 'Your defense. Make it count.' : 'The floor is open.' : game.ownNomination && game.phase === 'NOMINATIONS' ? 'Nominations submitted.' : game.votes[game.self] && game.phase === 'VOTE' ? 'Your vote is in.' : 'Read the room.'}</h2>
              <p>{game.spectator ? 'All roles are revealed to you. Living players keep their own private knowledge.' : canChoose ? legal?.type === 'Point' ? 'Only Mafia see your target. You can revise it until dawn.' : legal?.type === 'Vote' ? 'Your vote is public and final.' : 'Your choice is private.' : canSpeak ? 'Speak in the chat. Click a guest to address them directly.' : waiting}</p>
            </div>{game.status === 'FINISHED' && <button class="primary" disabled={busy} onClick={() => void start()}>New game ↗</button>}</div>
            {canChoose && <div class="action-row"><span>{targets.length ? targets.map(id => players.find(p => p.id === id)?.name).join(' + ') : 'Select at the table or below'} <small>({targets.length}/{legal!.count})</small></span><button class="primary" disabled={busy || targets.length !== legal!.count} onClick={() => void action(legal!.type)}>{ACTIONS[legal!.type]}</button>{game.legal.some(a => a.type === 'SkipAbility') && <button class="quiet" disabled={busy} onClick={() => void action('SkipAbility')}>Skip tonight</button>}</div>}
            <div class="player-roster" aria-label="Players and legal targets">{game.players.map(p => <button key={p.id} class={`roster-player ${!p.alive ? 'eliminated' : ''} ${selected.includes(p.id) ? 'selected' : ''} ${eligible.includes(p.id) ? 'eligible' : ''}`} disabled={!eligible.includes(p.id)} onClick={() => choose(p.id)} aria-label={`${p.name}${!p.alive ? ', eliminated' : ''}${p.role ? ', ' + p.role : ''}`} aria-pressed={selected.includes(p.id)}><span class="seat-dot"/><span>{p.human ? 'You' : p.name}<small>{!p.alive ? 'Eliminated' : p.role || (game.nominees.includes(p.id) ? 'Nominated' : 'At the table')}</small></span></button>)}</div>
            {(Object.keys(game.investigations || {}).length > 0 || Object.keys(game.pointers || {}).length > 0 || game.protection) && <div class="private-knowledge"><span>YOUR PRIVATE INFORMATION</span>{Object.entries(game.investigations || {}).map(([id, role]) => <p key={id}>{players.find(p => p.id === id)?.name}: {role}</p>)}{Object.entries(game.pointers || {}).map(([id, target]) => <p key={id}>{players.find(p => p.id === id)?.name} → {players.find(p => p.id === target)?.name}</p>)}{game.protection && <p>Protected: {players.find(p => p.id === game.protection)?.name}</p>}</div>}
          </>}
        </div>
      </section>
      <aside class="chat-panel" aria-label="Live game chat">
        <header class="chat-heading"><div><span class="eyebrow">EVERY WORD COUNTS</span><h2>At the table</h2></div><span class={`connection ${game && online ? 'connected' : ''}`}>{game ? online ? 'Live' : 'Reconnecting' : 'Waiting'}</span></header>
        <div class="messages" ref={log} role="log" aria-label="Game conversation" aria-live="polite" onScroll={() => { const p = log.current; if (p) stickToBottom.current = p.scrollHeight - p.scrollTop - p.clientHeight < 70; }}>
          {!events.length && <div class="empty-chat"><span aria-hidden="true">♣</span><h3>Keep your friends close.</h3><p>Accusations, alibis, and a few very convincing lies.<br/>The conversation appears here when your game begins.</p></div>}
          {events.map(e => {
            const p = game?.players.find(p => p.id === e.actor);
            if (e.type !== 'SpeechPublished') return <article class="moderator-message" key={e.seq}><span>THE DEALER · ROUND {e.round}</span><p>{e.text}</p></article>;
            const meta = e.data as { addressedTo?: string | null; replyTo?: number | null } | undefined;
            const recipient = players.find(p => p.id === meta?.addressedTo);
            return <article class={`chat-message ${p?.human ? 'own-message' : ''}`} key={e.seq}>
              <div class="message-byline"><span class="avatar-initials" aria-hidden="true">{p?.human ? 'Y' : p?.name.split(' ').map(n => n[0]).slice(0, 2).join('')}</span><strong>{p?.human ? 'You' : p?.name || 'Player'}</strong><small>R{e.round}</small></div>
              {recipient && <div class="message-recipient">To {recipient.human ? 'you' : recipient.name}</div>}
              <p>{e.text}</p>
              {canSpeak && p?.alive && !p.human && <button class="reply-button" onClick={() => replyTo(e)} aria-label={`Reply to ${p.name}`}>Reply ↗</button>}
            </article>;
          })}
        </div>
        <form class="chat-composer" onSubmit={e => { e.preventDefault(); if (canSpeak && message.trim() && !busy) void action('Speak'); }}>
          {reply && canSpeak && <div class="reply-to">To {players.find(p => p.id === reply.playerId)?.name}<button type="button" aria-label="Speak to the whole table instead" onClick={() => setReply(null)}>×</button></div>}
          <label class="sr-only" for="speech">Your message</label><textarea id="speech" ref={composer} value={message} maxLength={600} disabled={!canSpeak || busy} placeholder={canSpeak ? 'Make your case…' : waiting} onInput={e => setMessage(e.currentTarget.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (canSpeak && message.trim() && !busy) void action('Speak'); } }}/>
          <div class="composer-footer"><span>{canSpeak ? `${message.length}/600 · Enter to send` : game ? PHASES[game.phase] : 'Your voice belongs here.'}</span><button class="send-button" type="submit" disabled={!canSpeak || busy || !message.trim()} aria-label="Send message">↑</button></div>
        </form>
      </aside>
    </main>
    <footer class="site-footer"><span>ABMAFIA · A GAME OF IMPERFECT INFORMATION</span><span>Fictional AI portrayals · Your seat: Moxie</span></footer>
  </div>;
}
render(<App/>, document.getElementById('app')!);
