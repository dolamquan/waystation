import type { ManagedLaunch } from '../managed/types.ts';
import { LibraryInputError, type LaunchLoadout, type LoadoutContribution, type LoadoutProvider } from './types.ts';

const LOADOUT_KEYS = ['skillIds', 'docIds', 'mcpIds', 'pluginIds', 'notifyChannelIds'] as const;
const MAX_IDS_PER_KIND = 50;
const SAFE_ID = /^[A-Za-z0-9._:@/-]{1,160}$/;

/** Validates a loadout from a request body. Returns undefined when nothing is selected. */
export function parseLoadout(raw: unknown): LaunchLoadout | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new LibraryInputError('loadout must be an object');
  const body = raw as Record<string, unknown>;
  const entries = LOADOUT_KEYS.flatMap((key): Array<[string, string[]]> => {
    const value = body[key];
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > MAX_IDS_PER_KIND) {
      throw new LibraryInputError(`loadout.${key} must be a list of at most ${MAX_IDS_PER_KIND} ids`);
    }
    if (!value.every((id): id is string => typeof id === 'string' && SAFE_ID.test(id))) {
      throw new LibraryInputError(`loadout.${key} has an invalid id`);
    }
    const ids = [...new Set(value)];
    return ids.length ? [[key, ids]] : [];
  });
  return entries.length ? (Object.fromEntries(entries) as LaunchLoadout) : undefined;
}

export function isEmptyLoadout(loadout: LaunchLoadout | undefined): boolean {
  return !loadout || LOADOUT_KEYS.every((key) => !loadout[key]?.length);
}

function mergeNamed<T>(into: Readonly<Record<string, T>> | undefined, add: Readonly<Record<string, T>> | undefined, kind: string) {
  if (!add) return into;
  const clash = Object.keys(add).find((name) => into && name in into);
  if (clash) throw new LibraryInputError(`two ${kind} are both named "${clash}"`);
  return { ...into, ...add };
}

function merge(launch: ManagedLaunch, part: LoadoutContribution): ManagedLaunch {
  const prompts = [launch.appendSystemPrompt, part.appendSystemPrompt].filter((text): text is string => !!text?.trim());
  return {
    ...launch,
    appendSystemPrompt: prompts.length ? prompts.join('\n\n') : undefined,
    plugins: part.plugins?.length ? [...(launch.plugins ?? []), ...part.plugins] : launch.plugins,
    mcpServers: mergeNamed(launch.mcpServers, part.mcpServers, 'MCP servers'),
    remoteMcpServers: mergeNamed(launch.remoteMcpServers, part.remoteMcpServers, 'MCP servers'),
    env: part.env ? { ...launch.env, ...part.env } : launch.env,
  };
}

export interface AppliedLoadout {
  readonly launch: ManagedLaunch;
  readonly notes: readonly string[];
}

/**
 * Folds every provider's contribution into the launch. Runs after validateLaunch, so the role
 * instructions limit applies to what the operator typed, not to attached docs.
 */
export function applyLoadout(
  launch: ManagedLaunch,
  loadout: LaunchLoadout | undefined,
  providers: readonly LoadoutProvider[],
): AppliedLoadout {
  if (isEmptyLoadout(loadout)) return { launch, notes: [] };
  if (!launch.agentId) throw new Error('applyLoadout needs launch.agentId');
  return providers.reduce<AppliedLoadout>((acc, provider) => {
    const part = provider.contribute(loadout as LaunchLoadout, acc.launch);
    const mcpNames = [...Object.keys(part.mcpServers ?? {}), ...Object.keys(part.remoteMcpServers ?? {})];
    const crossClash = mcpNames.find((name) => acc.launch.mcpServers?.[name] || acc.launch.remoteMcpServers?.[name]);
    if (crossClash) throw new LibraryInputError(`two MCP servers are both named "${crossClash}"`);
    return { launch: merge(acc.launch, part), notes: [...acc.notes, ...(part.notes ?? [])] };
  }, { launch, notes: [] });
}
