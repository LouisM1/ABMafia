import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pause } from './engine.js';
import type { Game } from '../shared/types.js';

export class Storage {
  db: Database.Database;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS games (id TEXT PRIMARY KEY, session TEXT NOT NULL, state TEXT NOT NULL, updated INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS games_session ON games(session, updated);
      CREATE TABLE IF NOT EXISTS events (game_id TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(game_id, seq));
    `);
  }
  hasSession(token: string) { return !!this.db.prepare('SELECT token FROM sessions WHERE token = ?').get(token); }
  addSession(token: string) { this.db.prepare('INSERT INTO sessions VALUES (?, ?)').run(token, Date.now()); }
  save(g: Game) {
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO games VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, updated=excluded.updated')
        .run(g.id, g.session, JSON.stringify(g), Date.now());
      const last = this.db.prepare('SELECT MAX(seq) AS last FROM events WHERE game_id=?').get(g.id) as { last: number | null };
      const insert = this.db.prepare('INSERT INTO events VALUES (?, ?, ?)');
      for (const e of g.events.filter(e => e.seq > (last.last || 0))) insert.run(g.id, e.seq, JSON.stringify(e));
    })();
  }
  all() {
    return (this.db.prepare('SELECT state FROM games ORDER BY updated DESC').all() as { state: string }[]).map(row => JSON.parse(row.state) as Game);
  }
  recover(now: number) {
    const games = this.all();
    for (const g of games) {
      if (g.status !== 'RUNNING') continue;
      // remaining is a durable checkpoint, not elapsed wall time while the server was down.
      const remaining = g.remaining;
      pause(g, now, 'Server restarted. Your game is saved. Reconnect your API key if needed, then resume.');
      g.remaining = remaining; g.version++; this.save(g);
    }
    return games;
  }
  close() { this.db.close(); }
}
