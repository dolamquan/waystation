import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentEvent } from '../domain/types.ts';
import { redact } from '../domain/text.ts';
import type { TeamLogEntry, TeamState } from '../teams/types.ts';

export interface AuditEntry {
  readonly ts: number;
  readonly action: string;
  readonly target: string;
  readonly detail: string;
}

/** Small SQLite store for event history and the audit log. Payloads are already clipped + redacted. */
export class TowerStore {
  private db: DatabaseSync;

  constructor(filePath: string) {
    if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS events (ts INTEGER NOT NULL, agent_id TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_agent_ts ON events(agent_id, ts);
      CREATE TABLE IF NOT EXISTS audit (ts INTEGER NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS team_log (team_id TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, summary TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS team_log_team_ts ON team_log(team_id, ts);
    `);
  }

  saveTeam(team: TeamState): void {
    this.db.prepare('INSERT INTO teams (id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
      .run(team.id, JSON.stringify(team), Date.now());
  }

  deleteTeam(teamId: string): void {
    this.db.prepare('DELETE FROM teams WHERE id = ?').run(teamId);
  }

  loadTeams(): TeamState[] {
    const rows = this.db.prepare('SELECT json FROM teams ORDER BY updated_at').all() as Array<{ json: string }>;
    return rows.flatMap((row) => {
      try {
        return [JSON.parse(row.json) as TeamState];
      } catch {
        console.error('[store] skipping unreadable team record');
        return [];
      }
    });
  }

  appendTeamLog(entry: TeamLogEntry): void {
    this.db.prepare('INSERT INTO team_log (team_id, ts, kind, actor, summary) VALUES (?, ?, ?, ?, ?)')
      .run(entry.teamId, entry.ts, entry.kind, entry.actor, redact(entry.summary));
  }

  teamLog(teamId: string, limit = 300): TeamLogEntry[] {
    const rows = this.db.prepare(
      'SELECT team_id, ts, kind, actor, summary FROM team_log WHERE team_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?',
    ).all(teamId, limit) as Array<{ team_id: string; ts: number; kind: TeamLogEntry['kind']; actor: string; summary: string }>;
    return rows.reverse().map((row) => ({ teamId: row.team_id, ts: row.ts, kind: row.kind, actor: row.actor, summary: row.summary }));
  }

  recordEvent(event: AgentEvent): void {
    this.db.prepare('INSERT INTO events (ts, agent_id, kind, summary) VALUES (?, ?, ?, ?)')
      .run(event.ts, event.agentId, event.kind, redact(event.summary));
  }

  eventsFor(agentId: string, limit = 100): AgentEvent[] {
    const rows = this.db.prepare(
      'SELECT ts, agent_id, kind, summary FROM events WHERE agent_id = ? ORDER BY ts DESC LIMIT ?',
    ).all(agentId, limit) as Array<{ ts: number; agent_id: string; kind: AgentEvent['kind']; summary: string }>;
    return rows.reverse().map((row) => ({ agentId: row.agent_id, ts: row.ts, kind: row.kind, summary: row.summary }));
  }

  audit(action: string, target: string, detail: unknown): void {
    const text = redact(typeof detail === 'string' ? detail : JSON.stringify(detail ?? {})).slice(0, 4000);
    this.db.prepare('INSERT INTO audit (ts, action, target, detail) VALUES (?, ?, ?, ?)')
      .run(Date.now(), action, target, text);
  }

  auditLog(limit = 200): AuditEntry[] {
    return this.db.prepare('SELECT ts, action, target, detail FROM audit ORDER BY ts DESC LIMIT ?')
      .all(limit) as unknown as AuditEntry[];
  }

  pruneOlderThan(cutoffTs: number): void {
    this.db.prepare('DELETE FROM events WHERE ts < ?').run(cutoffTs);
    // Tool-by-tool activity ages out like agent events; the team channel is kept while the team exists.
    this.db.prepare("DELETE FROM team_log WHERE ts < ? AND (kind = 'activity' OR team_id NOT IN (SELECT id FROM teams))").run(cutoffTs);
  }

  close(): void {
    this.db.close();
  }
}
