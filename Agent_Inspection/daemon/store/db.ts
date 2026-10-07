import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Agent, AgentEvent, TokenCounts } from '../domain/types.ts';
import { redact } from '../domain/text.ts';
import type { TeamLogEntry, TeamState } from '../teams/types.ts';
import { ZERO_TOKENS, subtractTokens, totalTokens } from '../usage/usageMeter.ts';

export interface AuditEntry {
  readonly ts: number;
  readonly action: string;
  readonly target: string;
  readonly detail: string;
}

/** Tables holding one JSON document per row. A closed set: the name is interpolated into SQL. */
export type RecordTable =
  'templates' | 'schedules' | 'context_docs' | 'mcp_servers' | 'plugin_prefs' | 'notify_channels' | 'notifications';

const RECORD_TABLES: readonly RecordTable[] = [
  'templates', 'schedules', 'context_docs', 'mcp_servers', 'plugin_prefs', 'notify_channels', 'notifications',
];

interface UsageTotals {
  readonly tokens: TokenCounts;
  readonly costUsd?: number;
}

export interface UsageDay {
  readonly day: string;
  readonly tokens: number;
  readonly costUsd: number;
}

export interface UsageByAgent {
  readonly agentId: string;
  readonly vendor: string;
  readonly model: string | null;
  readonly project: string;
  readonly name: string;
  readonly tokens: number;
  readonly costUsd: number;
  /** False when none of this agent's usage had a known price (Codex): its cost reads as 0 but is unknown. */
  readonly priced: boolean;
}

export interface UsageSummary {
  readonly today: { readonly tokens: number; readonly costUsd: number };
  readonly byDay: readonly UsageDay[];
  readonly byAgent: readonly UsageByAgent[];
}

const DAY_MS = 86_400_000;

/** Local calendar day, YYYY-MM-DD. */
export function localDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    console.error('[store] skipping unreadable record');
    return undefined;
  }
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
      CREATE TABLE IF NOT EXISTS usage_totals (agent_id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_daily (
        day TEXT NOT NULL, agent_id TEXT NOT NULL, vendor TEXT NOT NULL, model TEXT, project TEXT NOT NULL, name TEXT NOT NULL,
        tokens INTEGER NOT NULL, cost_usd REAL NOT NULL, priced INTEGER NOT NULL, PRIMARY KEY (day, agent_id)
      );
      CREATE TABLE IF NOT EXISTS agent_names (agent_id TEXT PRIMARY KEY, name TEXT NOT NULL);
    `);
    for (const table of RECORD_TABLES) {
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
    }
  }

  // ---- usage ledger -------------------------------------------------------------------------

  /**
   * Adds whatever the agent spent since the last call to today's row. Totals per agent are kept,
   * so re-reading a transcript after a restart adds nothing.
   */
  recordUsage(agent: Agent, now = Date.now()): void {
    const usage = agent.usage;
    if (!usage) return;
    const row = this.db.prepare('SELECT json FROM usage_totals WHERE agent_id = ?').get(agent.id) as { json: string } | undefined;
    const stored = row ? parseJson<UsageTotals>(row.json) : undefined;
    const totals: UsageTotals = { tokens: usage.tokens, costUsd: usage.costUsd };
    const saveTotals = () => this.db.prepare('INSERT INTO usage_totals (agent_id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
      .run(agent.id, JSON.stringify(totals), now);
    const launchedHere = agent.tier === 'A';
    if (!stored && !launchedHere) {
      // A session that was already running when the tower first saw it: its history is not today's spend.
      saveTotals();
      return;
    }
    const shrank = stored !== undefined && totalTokens(usage.tokens) < totalTokens(stored.tokens);
    // Only a tower-launched agent restarts from zero under the same id (Restart & continue, back from the terminal).
    // Observed sessions never shrink; if one seems to, it is a partial read, so book nothing.
    if (shrank && !launchedHere) return;
    const previous = shrank ? undefined : stored;
    const tokens = totalTokens(subtractTokens(usage.tokens, previous?.tokens ?? ZERO_TOKENS));
    const cost = Math.max(0, (usage.costUsd ?? 0) - (previous?.costUsd ?? 0));
    if (tokens === 0 && cost === 0) return;
    saveTotals();
    this.db.prepare(`
      INSERT INTO usage_daily (day, agent_id, vendor, model, project, name, tokens, cost_usd, priced) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(day, agent_id) DO UPDATE SET tokens = tokens + excluded.tokens, cost_usd = cost_usd + excluded.cost_usd,
        model = excluded.model, name = excluded.name, priced = MAX(priced, excluded.priced)
    `).run(localDay(now), agent.id, agent.vendor, agent.model ?? null, agent.project, agent.name, tokens, cost, usage.costUsd === undefined ? 0 : 1);
  }

  /** Spend per day and per agent over the last `days` days (today included). */
  usageSummary(days: number, now = Date.now()): UsageSummary {
    const since = localDay(now - (days - 1) * DAY_MS);
    const byDay = this.db.prepare(
      'SELECT day, SUM(tokens) AS tokens, SUM(cost_usd) AS costUsd FROM usage_daily WHERE day >= ? GROUP BY day ORDER BY day',
    ).all(since) as unknown as UsageDay[];
    const byAgent = this.db.prepare(`
      SELECT agent_id AS agentId, MAX(vendor) AS vendor, MAX(model) AS model, MAX(project) AS project, MAX(name) AS name,
        SUM(tokens) AS tokens, SUM(cost_usd) AS costUsd, MAX(priced) AS priced
      FROM usage_daily WHERE day >= ? GROUP BY agent_id ORDER BY costUsd DESC, tokens DESC LIMIT 100
    `).all(since) as unknown as Array<Omit<UsageByAgent, 'priced'> & { priced: number }>;
    const today = byDay.find((day) => day.day === localDay(now));
    return {
      today: { tokens: today?.tokens ?? 0, costUsd: today?.costUsd ?? 0 },
      byDay,
      byAgent: byAgent.map((row) => ({ ...row, priced: row.priced === 1 })),
    };
  }

  // ---- names, templates, schedules ---------------------------------------------------------

  agentNames(): Map<string, string> {
    const rows = this.db.prepare('SELECT agent_id, name FROM agent_names').all() as Array<{ agent_id: string; name: string }>;
    return new Map(rows.map((row) => [row.agent_id, row.name]));
  }

  setAgentName(agentId: string, name: string | undefined): void {
    if (name === undefined) this.db.prepare('DELETE FROM agent_names WHERE agent_id = ?').run(agentId);
    else this.db.prepare('INSERT INTO agent_names (agent_id, name) VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET name = excluded.name').run(agentId, name);
  }

  saveRecord<T extends { readonly id: string }>(table: RecordTable, record: T): void {
    this.db.prepare(`INSERT INTO ${table} (id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`)
      .run(record.id, JSON.stringify(record), Date.now());
  }

  deleteRecord(table: RecordTable, id: string): boolean {
    return Number(this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id).changes) > 0;
  }

  /** Keeps the `keep` most recently updated rows of a table (the notifications inbox is capped this way). */
  pruneRecords(table: RecordTable, keep: number): void {
    this.db.prepare(`DELETE FROM ${table} WHERE id NOT IN (SELECT id FROM ${table} ORDER BY updated_at DESC LIMIT ?)`).run(keep);
  }

  loadRecords<T>(table: RecordTable): T[] {
    const rows = this.db.prepare(`SELECT json FROM ${table} ORDER BY updated_at`).all() as Array<{ json: string }>;
    return rows.flatMap((row) => {
      const parsed = parseJson<T>(row.json);
      return parsed === undefined ? [] : [parsed];
    });
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
