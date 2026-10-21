import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { emptyState, applyEvent } from './engine.mjs';

export class Store {
  constructor(path = '.local/lab.sqlite') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);');
    this.db.prepare('INSERT OR IGNORE INTO state(id,value) VALUES(1,?)').run(JSON.stringify(emptyState()));
  }
  read() { return JSON.parse(this.db.prepare('SELECT value FROM state WHERE id=1').get().value); }
  update(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const next = fn(this.read());
      this.db.prepare('UPDATE state SET value=? WHERE id=1').run(JSON.stringify(next));
      this.db.exec('COMMIT');
      return next;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  event(event) { let result; this.update(state => { result = applyEvent(state,event); return result.state; }); return result; }
  reset() { return this.update(() => emptyState()); }
  close() { this.db.close(); }
}
