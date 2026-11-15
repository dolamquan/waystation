import { describe, it, expect } from 'vitest';
import { codexConfig, jsonConfig } from '../scripts/configure-waystation-mcp.mjs';

describe('Waystation MCP installation', () => {
  it('preserves unrelated TOML verbatim and updates its own block idempotently', () => {
    const original = '# User preferences\nmodel = "example"\n[mcp_servers.other]\ncommand = "keep-me"\n';
    const installed = codexConfig(original, 'node', 'C:/Waystation/bridge.mjs');
    expect(installed.startsWith(original)).toBe(true);
    expect(codexConfig(installed, 'node', 'C:/Waystation/bridge.mjs')).toBe(installed);
    const updated = codexConfig(installed, 'node', 'C:/New/bridge.mjs');
    expect(updated).toContain('C:/New/bridge.mjs');
    expect(updated).not.toContain('C:/Waystation/bridge.mjs');
    expect(() => codexConfig('[mcp_servers."waystation"]\ncommand = "someone-else"')).toThrow(/unowned/);
  });
  it('preserves JSON accounts, project preferences and other MCPs, with the correct client transport', () => {
    const original = JSON.stringify({ account: { id: 'preserved' }, projects: { project: { trusted: true } }, mcpServers: { other: { command: 'keep' } } });
    for (const target of ['claude', 'copilot']) {
      const installed = jsonConfig(original, target, 'node', 'C:/Waystation/daemon/automation/waystation-mcp.mjs');
      const data = JSON.parse(installed);
      expect(data.account.id).toBe('preserved');
      expect(data.projects.project.trusted).toBe(true);
      expect(data.mcpServers.other.command).toBe('keep');
      expect(data.mcpServers.waystation.type).toBe(target === 'copilot' ? 'local' : 'stdio');
      expect(jsonConfig(installed, target, 'node', 'C:/Waystation/daemon/automation/waystation-mcp.mjs')).toBe(installed);
    }
    expect(() => jsonConfig('{"mcpServers":{"waystation":{"command":"other"}}}', 'claude')).toThrow(/unrelated/);
  });
});
