/**
 * How a recorded tool-call summary shows that files were written: "Edit: C:\repo\a.ts" or
 * "apply_patch: *** Begin Patch *** Update File: a.ts @@ …" (see describeToolInput).
 * Shared by the daemon's Outputs tab and the station's "Ready to look" moment.
 */

export const WRITE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
/** A held (not yet approved) call is shown with this prefix and hasn't changed anything. */
export const HELD_PREFIX = /^⏸\s*/;
/** A patch header's path runs until the next patch line ("@@", "***", "+x", "-x") or the end. */
export const PATCH_FILE = /\*\*\* (?:(?:Update|Add|Delete) File|Move to):\s*(.+?)(?=\s+(?:@@|\*\*\*|[+-])|\s*$)/g;
const PATCH_HEADER = /\*\*\* (?:(?:Update|Add|Delete) File|Move to):/;

/** True when this tool call wrote or edited at least one file, even if its path was clipped. */
export function writesFiles(summary: string): boolean {
  if (HELD_PREFIX.test(summary)) return false;
  const colon = summary.indexOf(':');
  const tool = (colon >= 0 ? summary.slice(0, colon) : summary).trim();
  return WRITE_TOOLS.has(tool) || PATCH_HEADER.test(summary);
}
