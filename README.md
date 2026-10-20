# ABMafia

A local, playable Mafia game: you and the eleven personas in `personas/manifest.json`.

## Start

Use Node 20.18 or newer (an active Node LTS is recommended).

```sh
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:4317**. The server listens only on this computer.

Choose **Model router**, paste your OpenAI API key, and save it. The default route is **gpt-5.4-nano**, with reasoning disabled and short structured responses. Your key is kept in server memory for this browser session, never written to the database or returned to the browser. Re-enter it after restarting the server. Removing it pauses an active OpenAI game. Model access is checked on the first request.

**Practice game** works without a key. Practice bots use simple scripted choices and sample dialogue; they do not reproduce the full LLM personas.

## Playing

- You receive a random secret role. Persona identity never determines role.
- Three Mafia, one Angel, one Sheriff and seven Townspeople occupy twelve seats.
- Night actions are private. Click a player to select a target, then submit.
- During discussion, type in the conversation panel. Nominate two distinct players, hear their defenses, and vote publicly.
- Eliminated players cannot act. If you die, you become an omniscient spectator.
- Pause whenever needed. Missing required ballots pause play while preserving submitted choices.
- Quick timing shortens night and ballot windows; discussion stays at 60 seconds and each defense at 15 seconds. Standard uses the specification's proposed night windows.

API errors pause the game with a message. Correct the key or account issue and resume. Requests have deadlines, a global concurrency limit of four, and a 200-request cap per game. The cap limits requests, not a guaranteed dollar budget. OpenAI charges your account for actual usage.

## Structure

| Location | Purpose |
|---|---|
| `server/engine.ts` | Authoritative game rules, phases, legal actions, secrets and victory |
| `server/ai.ts` | OpenAI route, compact rules/persona prompts and practice bots |
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
