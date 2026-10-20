import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Action, View } from '../shared/types';
import './style.css';

const PHASES: Record<string, string> = { MAFIA: 'Mafia coordination', ANGEL: 'Angel protection', SHERIFF: 'Sheriff investigation', DISCUSSION: 'Table discussion', NOMINATIONS: 'Secret nominations', DEFENSE_1: 'First defense', DEFENSE_2: 'Second defense', VOTE: 'Elimination vote' };
const COLORS = ['#d6b46e','#ae8baf','#87a7a2','#bb916c','#87a090','#b39e83','#bd8080','#919eb2','#bab282','#8d9d6b','#a19080','#bc9d76'];
type Session = { connected: boolean; model: string; players: { id: string; name: string }[]; game: View | null };
async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Request failed.'); return data;
}
function Portrait({ index = 0, initials }: { index?: number; initials: string }) {
  return <div class="portrait" style={{ '--portrait': COLORS[index % COLORS.length] }} aria-hidden="true"><div class="pixel-head"/><div class="pixel-body"/><span>{initials}</span></div>;
}
const initials = (name: string) => name.split(' ').map(x => x[0]).slice(0, 2).join('');
function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [game, setGame] = useState<View | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [router, setRouter] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [name, setName] = useState('You');
  const [mode, setMode] = useState<'openai' | 'practice'>('openai');
  const [speed, setSpeed] = useState<'standard' | 'quick'>('quick');
  const [targets, setTargets] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [now, setNow] = useState(Date.now());
  const [offset, setOffset] = useState(0);
  const [online, setOnline] = useState(true);
  const log = useRef<HTMLDivElement>(null);
  function receive(v: View) {
    setGame(previous => previous && previous.id === v.id && previous.version > v.version ? previous : v);
    setOffset(v.serverNow - Date.now());
  }
  useEffect(() => { api<Session>('/session').then(s => { setSession(s); if (s.game && s.game.status !== 'ABANDONED') receive(s.game); }).catch(e => setError(e.message)); }, []);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (!game?.id) return;
    const stream = new EventSource(`/api/games/${game.id}/events`);
    stream.onmessage = event => { receive(JSON.parse(event.data)); setOnline(true); };
    stream.onerror = () => setOnline(false);
    return () => stream.close();
  }, [game?.id]);
  useEffect(() => { setTargets([]); setMessage(''); }, [game?.phaseId]);
  useEffect(() => {
    const panel = log.current;
    if (panel) panel.scrollTop = panel.scrollHeight;
  }, [game?.events.length]);
  async function attempt(fn: () => Promise<void>) {
    setBusy(true); setError(''); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong.'); } finally { setBusy(false); }
  }
  async function start(chosen = mode) {
    await attempt(async () => {
      if (chosen === 'openai' && !session?.connected) { setRouter(true); return; }
      receive(await api<View>('/games', { name: name.trim() || 'You', mode: chosen, speed }));
    });
  }
  async function control(operation: 'pause' | 'resume' | 'leave') {
    await attempt(async () => {
      const v = await api<View>(`/games/${game!.id}/control`, { operation });
      if (operation === 'leave') setGame(null); else receive(v);
    });
  }
  async function action(type: Action['type']) {
    if (!game) return;
    await attempt(async () => {
      const v = await api<View>(`/games/${game.id}/actions`, {
        commandId: crypto.randomUUID(), phaseId: game.phaseId, type,
        targets: type === 'Speak' || type === 'SkipAbility' ? [] : targets,
        ...(type === 'Speak' ? { text: message } : {}),
      });
      receive(v); setTargets([]); setMessage('');
    });
  }
  const legal = game?.legal[0];
  const seconds = game ? Math.max(0, Math.ceil((game.status === 'RUNNING' ? game.deadline - now - offset : game.remaining) / 1000)) : 0;
  const self = game?.players.find(p => p.id === game.self);
  const canChoose = legal && legal.count > 0 && game?.status === 'RUNNING';
  function choose(id: string) {
    if (!canChoose || !legal.targets.includes(id)) return;
    setTargets(old => old.includes(id) ? old.filter(x => x !== id) : legal.count === 1 ? [id] : old.length < legal.count ? [...old, id] : [old[1], id]);
  }
  const actionLabel: Record<string, string> = { Point: 'Point at target', Protect: 'Protect player', Investigate: 'Investigate player', Nominate: 'Submit nominations', Vote: 'Cast vote' };
  return <div class="app-shell">
    <header class="topbar"><a href="/" class="brand" aria-label="ABMafia home"><span class="brand-icon">♠</span> AB<span>MAFIA</span><i>THE PRIVATE TABLE</i></a>
      <div class="top-actions"><span class="local-dot">LOCAL EDITION</span><button class="subtle" onClick={() => setRouter(true)}>Model router <span class={session?.connected ? 'key-dot ready' : 'key-dot'}/></button></div>
    </header>
    {error && <div role="alert" class="notice error">{error}<button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
    {!online && game && <div role="status" class="notice">Reconnecting to the table… Your accepted actions are saved.</div>}
    {!game ? <main class="lobby">
      <section class="welcome"><div class="eyebrow">ONE HUMAN. ELEVEN AI. THREE LIARS.</div><h1>A seat at<br/>the table.</h1><p class="intro">Read the room. Make your case.<br/>Find the Mafia before they find you.</p>
        <div class="setup">
          <label>Your name<input value={name} maxLength={30} onInput={e => setName(e.currentTarget.value)} placeholder="Your name"/></label>
          <div class="setup-row"><label>Players<select value={mode} onChange={e => setMode(e.currentTarget.value as typeof mode)}><option value="openai">OpenAI personas</option><option value="practice">Practice bots · free</option></select></label>
          <label>Pace<select value={speed} onChange={e => setSpeed(e.currentTarget.value as typeof speed)}><option value="quick">Quick nights</option><option value="standard">Standard</option></select></label></div>
          <button class="primary enter" disabled={busy || !session} onClick={() => void start()}>Take your seat <span>↗</span></button>
          <button class="practice-link" disabled={busy || !session} onClick={() => void start('practice')}>Or try a free practice game</button>
          <p class="micro">{mode === 'openai' ? 'GPT‑5.4 nano · Your API account is billed for play.' : 'Scripted practice bots. No API key or charges.'} Roles are randomized each game.</p>
        </div>
      </section>
      <section class="guest-list"><div class="section-title"><span>TONIGHT’S COMPANY</span><span>11 PERSONAS</span></div>
        <div class="roster">{session?.players.map((p, i) => <div class="guest" key={p.id}><Portrait index={i + 1} initials={initials(p.name)}/><div><strong>{p.name}</strong><span>Seat {String(i + 2).padStart(2, '0')}</span></div><span class="guest-status">READY</span></div>)}</div>
        <p class="disclaimer">Fictional AI portrayals inspired by public Mafia gameplay.</p>
      </section>
      <div class="lobby-footer"><span>♣ Bluffing encouraged. Trust optional.</span><span>3 Mafia · 1 Angel · 1 Sheriff · 7 Town</span></div>
    </main> : <main class="game">
      <div class="game-heading"><div><div class="eyebrow">{game.mode === 'practice' ? 'PRACTICE · SCRIPTED BOTS' : 'OPENAI · GPT‑5.4 NANO'} / ROUND {game.round}</div><h1>{game.winner ? `${game.winner} wins.` : PHASES[game.phase]}</h1></div>
        <div class="game-tools">{game.status !== 'FINISHED' && <><span class="timer" aria-label={`${seconds} seconds remaining`}>{game.status === 'PAUSED' ? 'PAUSED' : `${seconds}s`}</span><button class="subtle" disabled={busy} onClick={() => void control(game.status === 'PAUSED' ? 'resume' : 'pause')}>{game.status === 'PAUSED' ? 'Resume' : 'Pause'}</button></>}
        <button class="subtle" disabled={busy} onClick={() => void control('leave')}>{game.status === 'FINISHED' ? 'New game' : 'Leave table'}</button></div>
      </div>
      {game.status === 'PAUSED' && <div class="notice">{game.pauseReason}</div>}
      <div class="play-layout">
        <section class="table-panel">
          <div class="role-strip"><span>{game.spectator ? 'SPECTATOR' : 'YOUR CARD'}</span><strong class={self?.role === 'Mafia' ? 'mafia-text' : ''}>{self?.role}</strong><span class="role-note">{game.spectator ? 'All roles and private events are visible to you.' : 'Only you can see your role.'}</span></div>
          <div class="table-scene">
            <div class="table-felt"><span class="table-mark">A<span>♠</span>M</span><span class="table-motto">TRUST IS A GAMBLE</span><span class="alive-count">{game.players.filter(p => p.alive).length} AT THE TABLE</span></div>
            <div class="seats">{game.players.map((p, i) => <button key={p.id}
              class={`seat seat-${i} ${!p.alive ? 'eliminated' : ''} ${targets.includes(p.id) ? 'selected' : ''} ${canChoose && legal.targets.includes(p.id) ? 'eligible' : ''} ${game.activeSpeaker === p.id ? 'speaking' : ''}`}
              onClick={() => choose(p.id)} disabled={!canChoose || !legal.targets.includes(p.id)}
              aria-label={`${p.name}${!p.alive ? ', eliminated' : ''}${p.role ? ', ' + p.role : ''}`} aria-pressed={targets.includes(p.id)}>
              <Portrait index={i} initials={initials(p.name)}/><strong>{p.human ? `${p.name} · YOU` : p.name}</strong>
              <span class={p.role === 'Mafia' ? 'mafia-text' : ''}>{!p.alive ? 'ELIMINATED' : p.role || (game.nominees.includes(p.id) ? 'ON TRIAL' : 'ROLE HIDDEN')}</span>
              {game.pointers?.[p.id] && <small>→ {game.players.find(t => t.id === game.pointers![p.id])?.name}</small>}
            </button>)}</div>
          </div>
          <div class="action-panel">
            {game.status === 'FINISHED' ? <><h2>The cards are on the table.</h2><p>Your team {game.winner === (self?.role === 'Mafia' ? 'Mafia' : 'Town') ? 'won' : 'lost'}. Explore the conversation and private events, or start a new game.</p></> :
            game.spectator ? <><h2>You’re watching now.</h2><p>The surviving players continue with only their own information.</p></> :
            game.status === 'PAUSED' ? <><h2>The table is paused.</h2><p>Resume when you’re ready. Submitted actions are preserved.</p></> :
            legal?.type === 'Speak' ? <><label for="speech">{game.activeSpeaker ? 'Your uninterrupted defense' : 'Speak to the table'}</label><div class="speech-form"><textarea id="speech" value={message} maxLength={600} placeholder="An accusation? A question? Make it count." onInput={e => setMessage(e.currentTarget.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (message.trim() && !busy) void action('Speak'); } }}/><button class="primary" disabled={busy || !message.trim()} onClick={() => void action('Speak')}>Speak ↗</button></div><p class="micro">Enter to send · Shift + Enter for a new line · {message.length}/600</p></> :
            canChoose ? <><h2>{legal.count === 2 ? 'Choose two different players.' : 'Choose a player at the table.'}</h2><p>{legal.type === 'Point' ? 'Only Mafia see the pointers. You can revise until the timer ends.' : legal.type === 'Nominate' ? 'Your nominations are secret and final.' : legal.type === 'Vote' ? 'Your vote is public and final.' : 'Your choice is private and final.'}</p>
              <div class="target-list">{legal.targets.map(id => <button class={targets.includes(id) ? 'target picked' : 'target'} onClick={() => choose(id)}>{game.players.find(p => p.id === id)?.name}</button>)}</div>
              <div class="action-buttons"><button class="primary" disabled={busy || targets.length !== legal.count} onClick={() => void action(legal.type)}>{actionLabel[legal.type]}</button>{game.legal.some(a => a.type === 'SkipAbility') && <button class="subtle" disabled={busy} onClick={() => void action('SkipAbility')}>Skip tonight</button>}</div></> :
            <><h2>{game.ownNomination && game.phase === 'NOMINATIONS' ? 'Nominations received.' : game.votes[game.self] && game.phase === 'VOTE' ? 'Your vote is in.' : 'Watch the table.'}</h2><p>{game.phase === 'ANGEL' || game.phase === 'SHERIFF' || game.phase === 'MAFIA' ? 'Night actions are private. Daybreak is coming.' : game.activeSpeaker ? 'The nominee has the floor.' : 'Waiting for the remaining players.'}</p></>}
          </div>
          {!!Object.keys(game.investigations || {}).length && <div class="knowledge"><strong>Your investigations</strong>{Object.entries(game.investigations!).map(([id, role]) => <span>{game.players.find(p => p.id === id)?.name}: {role}</span>)}</div>}
        </section>
        <aside class="conversation"><div class="section-title"><span>AT THE TABLE</span><span class="live-label">● LIVE</span></div>
          <div class="messages" ref={log} role="log" aria-label="Game conversation">{game.events.map(e => {
            const speaker = game.players.find(p => p.id === e.actor);
            return <article key={e.seq} class={e.type === 'SpeechPublished' ? 'chat-message' : 'game-event'}>
              <div class="message-meta"><strong>{e.type === 'SpeechPublished' ? speaker?.name : 'MODERATOR'}</strong><span>R{e.round}</span></div>
              <p>{e.text}</p>
              {e.data !== undefined && <details><summary>{game.spectator ? 'View event details' : 'Your details'}</summary><pre>{JSON.stringify(e.data, null, 2)}</pre></details>}
            </article>;
          })}</div>
          <div class="conversation-footer">{game.mode === 'practice' ? 'Practice mode · no API calls' : `${game.aiCalls}/200 model requests this game`}</div>
        </aside>
      </div>
    </main>}
    {router && <div class="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setRouter(false); }}>
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="router-title">
        <div class="section-title"><span>MODEL ROUTER</span><button class="close" onClick={() => setRouter(false)} aria-label="Close model router">×</button></div>
        <h2 id="router-title">Give the table a voice.</h2><p>Your key connects this local server directly to OpenAI.</p>
        <label>Model<select disabled><option>GPT‑5.4 nano · low cost</option></select></label>
        <p class="micro">$0.20 input / $1.25 output per million tokens. Usage is billed to your OpenAI account. 200-request cap per game.</p>
        <form onSubmit={e => { e.preventDefault(); void attempt(async () => {
          const value = apiKey; const r = await api<{ connected: boolean }>('/key', { apiKey: value });
          setApiKey(''); setSession(s => s ? { ...s, connected: r.connected } : s); setRouter(false);
        }); }}><label>OpenAI API key<input type="password" value={apiKey} autoComplete="off" placeholder={session?.connected ? 'Replace your loaded key…' : 'sk-…'} onInput={e => setApiKey(e.currentTarget.value)}/></label>
        <p class="micro">Stored only in server memory. Re-enter it after restarting the server. Never saved to browser storage or the game database.</p>
        <div class="action-buttons"><button class="primary" disabled={busy || !apiKey.trim()} type="submit">Save key</button>
          {session?.connected && <button type="button" class="subtle" disabled={busy} onClick={() => void attempt(async () => { await api('/key', { apiKey: '' }); setSession(s => s ? { ...s, connected: false } : s); setApiKey(''); })}>Forget key</button>}</div></form>
        <div class="key-status">{session?.connected ? '● Key loaded · verified when a game makes its first request' : '○ No API key loaded · practice mode is available'}</div>
      </section>
    </div>}
    <footer class="site-footer"><span>ABMAFIA / EARLY ACCESS</span><span>A game of imperfect information.</span></footer>
  </div>;
}
render(<App/>, document.getElementById('app')!);
