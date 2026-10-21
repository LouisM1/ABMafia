# ABMafia

A local, playable Mafia game: you and the eleven personas in `personas/manifest.json`.

## Start

Use the Node version recorded in `.nvmrc` for both installation and execution. With nvm, run `nvm use` in this folder first.

```sh
nvm use
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:4317**. The server listens only on this computer.

Put your key in the project-root `.env` file:

```dotenv
OPENAI_API_KEY=your_key_here
```

If the file is missing, copy `.env.example` to `.env` first. Restart the server and refresh the page after changing it. Node loads this file directly; no extra dependency is needed. An existing shell environment variable takes precedence over the file.

The model configured in `server/ai.ts` is **gpt-6-luna**, with reasoning disabled and short structured responses. The key stays on the server and is never returned to the browser or written into the game database. `.env` and `.env.*` are ignored by Git, except the blank `.env.example` template. Model access is checked on the first request.

All AI decisions and dialogue come from live OpenAI requests. There is no scripted mode or canned-response fallback. A key is required to start a game. Old practice games are archived when the server starts.

## Playing

- You receive a random secret role. Persona identity never determines role.
- Three Mafia, one Angel, one Sheriff and seven Townspeople occupy twelve seats.
- Night actions are private. Click a player to select a target, then submit.
- During discussion, type in the conversation panel. Nominate two distinct players, hear their defenses, and vote publicly.
- Eliminated players cannot act. If you die, you become an omniscient spectator.
- Pause whenever needed. Missing required ballots pause play while preserving submitted choices.
- Quick timing shortens night and ballot windows; discussion stays at 60 seconds and each defense at 15 seconds. Standard uses the specification's proposed night windows.

API errors pause the game with a message. Correct the key or account issue and resume. Requests have deadlines, a global concurrency limit of four, and a 200-request cap per game. The cap limits requests, not a guaranteed dollar budget. OpenAI charges your account for actual usage.

## Conversation turns

Use **To** beside the input to address a living player. With Table selected, a single unambiguous name routes your message automatically; “Ryan” alone remains addressed to the table. Explicit player selection takes precedence over names in the text.

Only one AI speech request runs per game. Direct questions get priority, with fair opportunities for the rest of the table and a break after two directed replies. Each request sees the latest 40 public speeches (with IDs and names), any older referenced speech, and separately supplied authorized engine facts. Replies normally aim for one or two sentences; the existing 600-character limit remains.

The next request waits 800ms after speech, or four seconds when an AI addresses you. You can interrupt at any time: accepted human speech cancels the pending reply, waits for it to settle, and selects again with fresh context. Pause, phase changes, elimination and deadlines also prevent stale replies from appearing.

An AI can privately pass during discussion and will not be asked again until someone speaks. Completed opportunities are saved with the game; active requests are not restored. An API error or open-phase speech timeout pauses play. These controls improve conversational flow, but cannot guarantee factual or natural dialogue.

## Structure

| Location | Purpose |
|---|---|
| `server/engine.ts` | Authoritative game rules, phases, legal actions, secrets and victory |
| `server/conversation.ts` | Speaker selection, private passes, turn history, timing and interruption reservations |
| `server/ai.ts` | OpenAI route and compact rules/persona prompts |
| `server/personas.ts` | Loads the existing master manifest and enabled runtime traits |
| `server/storage.ts` | SQLite snapshots and an event journal |
| `server/main.ts` | Local HTTP server, event stream, session ownership and AI scheduling |
| `client/` | Small Preact UI and CSS |
| `shared/types.ts` | Shared data contracts |
| `tests/` | Rules, hidden-information, persistence and mocked adapter checks |
| `personas/` | Original research and persona JSON, unchanged by the app |

The browser and each AI receive only their permitted view. The engine validates every action; model text cannot assign roles, reveal engine secrets, change timers or decide outcomes. A single model request selects an action or produces a short utterance. Generated dialogue can still contain mistakes or bluffs.

Saved games live in the ignored `data/mafia.sqlite` file. Restarted games return paused at their last saved checkpoint. A browser cookie identifies your local session, so use the same browser and hostname to return to a game.

## Verification and development

```sh
npm test
npm run build
```

`npm run dev` builds the client once and watches the server. Rebuild and restart after client edits.

This first version uses CSS pixel-style avatars and a responsive table. The supplied PNG remains a visual reference; it has not been sliced into production sprites. There is no hosted deployment, multiplayer, voice, or local LLM download.

The OpenAI adapter has automated mocked-response coverage. A live API smoke test requires your key; no paid calls are made during tests.

## Live terminal logs

From the ABMafia folder in your VS Code terminal, run:

```sh
npm run debug
```

This builds the latest code, starts the server, and prints live diagnostics in that terminal. Open http://127.0.0.1:4317 and play. Stop another running copy with Ctrl+C first if the port is occupied. Ctrl+C also stops this debug session.

- `BROWSER → REQUEST / BODY`: incoming browser requests and submitted actions, with request IDs.
- `SERVER → RESPONSE`: API response bodies, status and elapsed milliseconds. Static assets log status only.
- `SERVER → STREAM OPEN / LIVE UPDATE`: live connection and update summaries (game, phase, version, connected clients). Heartbeats and repeated full snapshots are omitted; game events are printed separately.
- `BROWSER · DIAGNOSTIC`: browser startup, connection problems, caught action errors, runtime errors and unhandled promise rejections. This is best-effort forwarding while the server is reachable, not a mirror of arbitrary browser console output.
- `OPENAI → REQUEST`: full prompt, persona, authorized game view, action schema and configured model before sending.
- `OPENAI ← RESPONSE`: full response body, HTTP status, provider request ID, usage when returned, and elapsed milliseconds.
- `OPENAI × ERROR / CANCELLED`: provider failures, invalid responses and cancellations.
- `CONVERSATION`: selected speaker and reason, reservation ID, reply reference, public-speech revision, passes, interruptions, discarded results and accepted replies. A reservation ID is also its OpenAI request ID.
- `GAME`: phase changes, private actions, eliminations and whether an AI action was accepted, discarded or rejected.

The same request ID joins each OpenAI request, response and engine result. Logs are printed only to the terminal; the app does not save log files. Keys and session credentials are redacted, but private roles and match decisions are intentionally visible for debugging.

`npm start` remains quiet unless you set `DEBUG_AI=true` in `.env`. No new logging dependency is required. Browser error forwarding is enabled only in debug mode and limited to ten reports per ten seconds per session.

## SQLite / Node version mismatch

`better-sqlite3` contains a native module compiled for a particular Node version. Installing with one Node version and running with another can produce `NODE_MODULE_VERSION` / `ERR_DLOPEN_FAILED` errors.

Use the project version, then rebuild the local SQLite dependency:

```sh
nvm use
npm rebuild better-sqlite3
npm run debug
```

Rebuild again if you intentionally change Node versions. This does not delete saved games or your `.env` file.
