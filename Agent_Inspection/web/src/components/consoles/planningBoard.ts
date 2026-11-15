/* The board's browser side of the planning sketch: the model lives in shared/sketch.ts (the daemon and agents use it too). */
import { emptyPlanning, parsePlanning, type PlanningDocument } from '../../../../shared/sketch.ts';
export * from '../../../../shared/sketch.ts';

export const PLANNING_KEY = 'waystation-planning-v1:';

export function loadPlanning(project: string): PlanningDocument {
  return readPlanning(project).doc;
}

export function readPlanning(project: string): { doc: PlanningDocument; unreadable?: string } {
  let raw: string | null;
  try { raw = localStorage.getItem(PLANNING_KEY + project); } catch { return { doc: emptyPlanning() }; }
  if (!raw) return { doc: emptyPlanning() };
  try { return { doc: parsePlanning(JSON.parse(raw)) }; }
  catch { return { doc: emptyPlanning(), unreadable: raw }; }
}

/** Keep a project's planning space reachable after its last live agent exits. */
export function savedPlanningProjects(): readonly string[] {
  try {
    return Object.keys(localStorage).filter((key) => key.startsWith(PLANNING_KEY))
      .map((key) => key.slice(PLANNING_KEY.length)).filter((key) => key && key !== 'all' && key.length < 2048).slice(0, 64);
  } catch { return []; }
}

