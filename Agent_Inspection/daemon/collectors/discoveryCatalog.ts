import { randomUUID } from 'node:crypto';
import { BUILTIN_DISCOVERY, type DiscoveryRule } from '../../shared/agentProviders.ts';
import type { TowerStore } from '../store/db.ts';
import { UserError } from '../userError.ts';

export class DiscoveryCatalog {
  constructor(private readonly store: TowerStore, private readonly providers: () => readonly DiscoveryRule[] = () => []) {}
  list(): DiscoveryRule[] { return [...BUILTIN_DISCOVERY, ...this.providers(), ...this.store.loadRecords<DiscoveryRule>('discovery_rules')]; }
  add(raw: unknown): DiscoveryRule {
    const body = (raw ?? {}) as Record<string, unknown>;
    if (typeof body.label !== 'string' || !body.label.trim() || body.label.trim().length > 80) throw new UserError('Agent name must be 1–80 characters.');
    const executable = typeof body.executable === 'string' ? body.executable.trim().toLowerCase().replace(/\.exe$/, '') : '';
    const packageName = typeof body.package === 'string' ? body.package.trim().toLowerCase() : '';
    if (!executable && !packageName) throw new UserError('Enter an agent executable or entry-script package.');
    if (executable && !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(executable)) throw new UserError('Enter an executable name such as my-agent.exe, without a folder or arguments.');
    if (packageName && !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]{1,79}$/i.test(packageName)) throw new UserError('Enter a package name such as @example/coding-agent, without arguments.');
    if (/^(node|python[\d.]*|py|code|cursor|windsurf|electron|powershell|pwsh|cmd|bash|sh|wsl|conhost|explorer|windowsterminal)$/.test(executable)) throw new UserError('Choose the agent executable, not its editor, shell or shared runtime.');
    if (['claude', 'codex'].includes(executable) || ['@anthropic-ai/claude-code', '@openai/codex'].includes(packageName) || this.list().some(rule => executable && rule.executables.includes(executable) || packageName && rule.packages.includes(packageName))) throw new UserError('This executable or package already has a discovery rule.');
    const rule: DiscoveryRule = { id: `custom-${randomUUID()}`, label: body.label.trim(), executables: executable ? [executable] : [], packages: packageName ? [packageName] : [] };
    this.store.saveRecord('discovery_rules', rule);
    return rule;
  }
  remove(id: string): void {
    if (!id.startsWith('custom-') || !this.list().some(rule => rule.id === id)) throw new UserError('Only custom discovery rules can be removed.');
    this.store.deleteRecord('discovery_rules', id);
  }
}
