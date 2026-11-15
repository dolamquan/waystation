const KEY = 'waystation-canvas-reveals';
const handled = new Set<string>();
export function revealHandled(id: string): boolean {
  if (handled.has(id)) return true;
  try { const saved = JSON.parse(sessionStorage.getItem(KEY) ?? '[]'); return Array.isArray(saved) && saved.includes(id); } catch { return false; }
}
export function markRevealHandled(id: string): void {
  handled.add(id);
  if (handled.size > 64) handled.delete(handled.values().next().value!);
  try { sessionStorage.setItem(KEY, JSON.stringify([...handled])); } catch { /* Memory still prevents remount replay. */ }
}
