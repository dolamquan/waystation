import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { managedProvider, type ManagedVendor } from '../../shared/agentProviders.ts';
type ToolAvailability = Partial<Record<ManagedVendor | 'git' | 'terminal', boolean>>;

export function cliUnavailableReason(tools: ToolAvailability, vendor: ManagedVendor | 'other'): string | undefined {
  if (managedProvider(vendor)?.cli === false) return 'Use this provider’s managed session in Waystation. CLI handoff is not available.';
  if (tools.terminal === false) return 'Install Windows Terminal to open agent sessions in a terminal.';
  if (vendor !== 'other' && tools[vendor] === false) return `Install or configure ${managedProvider(vendor)?.label} to open this session in a terminal.`;
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
