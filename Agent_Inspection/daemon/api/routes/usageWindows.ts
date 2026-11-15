import type { Tower } from '../../tower.ts';
import { r, type Route } from './route.ts';
import { sumWindow, type UsageEntry } from '../../usage/usageBlocks.ts';

/** 5-hour and weekly plan windows per vendor. Cached in the daemon, so polling every minute is cheap. */
export function usageWindowRoutes(tower: Tower): Route[] {
  return [r('GET', '/api/usage/windows', async () => ({ windows: await providerUsageReport(tower) }))];
}

export async function providerUsageReport(tower: Tower) {
    const [windows, copilot] = await Promise.all([tower.usageWindows.report(), tower.copilotAccount.read()]);
    const now = Date.now(), start = now - 7 * 86_400_000;
    const allEntries = tower.store.loadRecords<UsageEntry & { id: string; vendor: string }>('provider_usage').filter(entry => entry.ts >= start && entry.ts <= now);
    const entries = allEntries.filter(entry => entry.vendor === 'copilot');
    // Copilot subscription/account billing is not the underlying model's public API list price.
    const week = sumWindow(entries.map(entry => ({ ...entry, model: undefined })), start, now);
    const acpIds = new Set([...tower.providers.list().filter(provider => provider.adapter === 'acp').map(provider => provider.id), ...allEntries.filter(entry => entry.id.startsWith('acp:')).map(entry => entry.vendor)]);
    const acp = [...acpIds].map(vendor => ({ vendor, limits: [], message: 'ACP does not supply account quotas. Local tokens appear when the agent reports usage; missing readings do not mean zero usage.',
      week: sumWindow(allEntries.filter(entry => entry.vendor === vendor).map(entry => ({ ...entry, model: undefined })), start, now) }));
    return { ...windows, vendors: [...windows.vendors, { vendor: 'copilot' as const, limits: copilot.limits, message: copilot.message, week }, ...acp] };
}
