import { useEffect, useState } from 'react';
import { api } from './api.ts';
type ToolAvailability = Partial<Record<'git' | 'codex' | 'claude' | 'terminal', boolean>>;

export function cliUnavailableReason(tools: ToolAvailability, vendor: 'claude' | 'codex' | 'other'): string | undefined {
  if (tools.terminal === false) return 'Install Windows Terminal to open agent sessions in a terminal.';
  if (vendor !== 'other' && tools[vendor] === false) return `Install or configure ${vendor === 'codex' ? 'Codex CLI' : 'Claude Code'} to open this session in a terminal.`;
  return undefined;
}

/** Missing optional tools disable only their features. Unknown checks defer to the daemon. */
export function useToolAvailability() {
  const [tools, setTools] = useState<ToolAvailability>({});
  useEffect(() => {
    let cancelled = false;
    void api.prerequisites().then(({ prerequisites }) => {
      if (!cancelled) setTools(Object.fromEntries(prerequisites.map((check) => [check.id, check.ok])));
    }, () => undefined);
    return () => { cancelled = true; };
  }, []);
  return tools;
}
