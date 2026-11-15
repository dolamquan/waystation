/** Every managed feature consumes this catalog; adding an adapter adds it to all provider selectors. */
export interface ProviderDescriptor {
  readonly id: string;
  readonly label: string;
  readonly launchLabel: string;
  readonly intercept: boolean;
  readonly plugins: boolean;
  readonly cli: boolean;
  readonly adapter?: 'native' | 'acp';
  readonly available?: boolean;
  readonly detail?: string;
  readonly usageMode?: 'turn' | 'session';
}
export const MANAGED_PROVIDERS: ProviderDescriptor[] = [
  { id: 'claude', label: 'Claude', launchLabel: 'Claude (Agent SDK)', intercept: true, plugins: true, cli: true },
  { id: 'codex', label: 'Codex', launchLabel: 'Codex (codex exec)', intercept: false, plugins: false, cli: true },
  { id: 'copilot', label: 'GitHub Copilot', launchLabel: 'Copilot (Agent SDK)', intercept: true, plugins: false, cli: false },
];
/** IDs are runtime registrations, never a closed vendor union. Validation uses the catalog. */
export type ManagedVendor = string;
export const NATIVE_PROVIDERS = MANAGED_PROVIDERS.slice();
export function replaceProviderCatalog(providers: readonly ProviderDescriptor[]): void {
  MANAGED_PROVIDERS.splice(0, MANAGED_PROVIDERS.length, ...providers);
}
export const isManagedVendor = (value: unknown): value is ManagedVendor => MANAGED_PROVIDERS.some(provider => provider.id === value);
export const managedProvider = (id: string) => MANAGED_PROVIDERS.find(provider => provider.id === id);

/** Discovery identifies a running tool; its adapter supplies control capabilities. */
export interface DiscoveryRule {
  readonly id: string;
  readonly label: string;
  readonly executables: readonly string[];
  /** Package/directory names in the executable or entry-script path, never in prompt arguments. */
  readonly packages: readonly string[];
}

export const BUILTIN_DISCOVERY: readonly DiscoveryRule[] = [
  { id: 'copilot', label: 'GitHub Copilot', executables: ['copilot', 'copilot-runtime'], packages: ['@github/copilot', 'copilotcli', 'github.copilot-chat'] },
  { id: 'aider', label: 'Aider', executables: ['aider'], packages: ['aider', 'aider-chat'] },
  { id: 'gemini', label: 'Gemini CLI', executables: ['gemini'], packages: ['gemini-cli', '@google/gemini-cli'] },
  { id: 'cursor', label: 'Cursor Agent', executables: ['cursor-agent'], packages: ['cursor-agent'] },
  { id: 'opencode', label: 'OpenCode', executables: ['opencode'], packages: ['opencode', 'opencode-ai'] },
  { id: 'goose', label: 'Goose', executables: ['goose'], packages: ['goose'] },
  { id: 'amp', label: 'Amp', executables: ['amp'], packages: ['@sourcegraph/amp'] },
  { id: 'qwen', label: 'Qwen Code', executables: ['qwen'], packages: ['@qwen-code/qwen-code'] },
  { id: 'auggie', label: 'Auggie', executables: ['auggie'], packages: ['@augmentcode/auggie'] },
  { id: 'crush', label: 'Crush', executables: ['crush'], packages: ['crush'] },
  { id: 'cline', label: 'Cline', executables: ['cline'], packages: ['cline'] },
  { id: 'kilo', label: 'Kilo Code', executables: ['kilo', 'kilocode'], packages: ['@kilocode/cli'] },
  { id: 'kiro', label: 'Kiro CLI', executables: ['kiro-cli'], packages: ['kiro-cli'] },
];

export const providerKey = (agent: { readonly vendor: string; readonly providerId?: string }): string => agent.providerId ?? agent.vendor;
export const providerLabel = (agent: { readonly vendor: string; readonly providerLabel?: string }): string =>
  agent.providerLabel ?? managedProvider(agent.vendor)?.label ?? (agent.vendor === 'other' ? 'Agent' : agent.vendor);
