import type { TowerStore } from '../store/db.ts';
import { LibraryInputError } from '../library/types.ts';
import { applySketchOperations, emptyPlanning, parsePlanning, type PlanningDocument } from '../../shared/sketch.ts';

/** One planning sketch per project canvas, keyed by the board's project key (a folder key such as `folder:c:/work/app`). */
interface SketchRecord {
  readonly id: string;
  readonly doc: PlanningDocument;
  readonly revision: number;
  readonly updatedAt: number;
  /** 'operator' for the board, otherwise the agent id that made the change. */
  readonly changedBy: string;
}

export interface SketchSnapshot {
  readonly project: string;
  readonly doc: PlanningDocument;
  /** 0 until the board or an agent first saves this project's sketch. */
  readonly revision: number;
  readonly updatedAt?: number;
  readonly changedBy?: string;
}

const MAX_PROJECT_KEY = 2048;

export class SketchConflictError extends LibraryInputError {
  constructor(readonly current: SketchSnapshot) { super('The sketch changed since you read it. Read it again, then retry your change.'); }
}

/** The daemon's copy of each project's sketch, shared by the console board and agents (through the Waystation MCP tools). */
export class SketchStore {
  constructor(private readonly store: TowerStore) {}

  private key(project: unknown): string {
    if (typeof project !== 'string' || !project || project.length > MAX_PROJECT_KEY || project === 'all') throw new LibraryInputError('Choose a project canvas.');
    return project;
  }

  get(project: unknown): SketchSnapshot {
    const key = this.key(project);
    const record = this.store.loadRecords<SketchRecord>('sketch_boards').find((entry) => entry.id === key);
    if (!record) return { project: key, doc: emptyPlanning(), revision: 0 };
    try { return { project: key, doc: parsePlanning(record.doc), revision: record.revision, updatedAt: record.updatedAt, changedBy: record.changedBy }; }
    catch { return { project: key, doc: emptyPlanning(), revision: record.revision }; }
  }

  private write(key: string, doc: PlanningDocument, revision: number, actor: string): SketchSnapshot {
    const record: SketchRecord = { id: key, doc, revision: revision + 1, updatedAt: Date.now(), changedBy: actor };
    this.store.saveRecord('sketch_boards', record);
    return { project: key, doc, revision: record.revision, updatedAt: record.updatedAt, changedBy: actor };
  }

  /** The board saves its whole sketch; `baseRevision` must match, so an agent's edit is never silently overwritten. */
  replace(project: unknown, raw: unknown, baseRevision: unknown, actor = 'operator'): SketchSnapshot {
    const current = this.get(project);
    if (baseRevision !== current.revision) throw new SketchConflictError(current);
    let doc: PlanningDocument;
    try { doc = parsePlanning(raw); } catch (error) { throw new LibraryInputError((error as Error).message); }
    return this.write(current.project, doc, current.revision, actor);
  }

  /** An agent's atomic batch of edits, checked against the revision it read. */
  edit(project: unknown, expectedRevision: unknown, operations: unknown, actor: string): SketchSnapshot & { readonly created: readonly string[] } {
    const current = this.get(project);
    if (expectedRevision !== current.revision) throw new SketchConflictError(current);
    let result;
    try { result = applySketchOperations(current.doc, operations); } catch (error) { throw new LibraryInputError((error as Error).message); }
    this.store.audit('sketch_update', current.project, { actor, revision: current.revision + 1 });
    return { ...this.write(current.project, result.doc, current.revision, actor), created: result.created };
  }
}
