import { request } from '../api.ts';
import type {
  AvailablePlugin, CodexPluginView, McpPreset, McpServerInput, McpServerView, McpTestResult, McpTransport, PluginView,
} from '../../../daemon/library/types.ts';

export type { AvailablePlugin, CodexPluginView, McpPreset, McpServerInput, McpServerView, McpTestResult, McpTransport, PluginView };

const enc = encodeURIComponent;

/** MCP servers, Claude Code plugins and Codex plugins in the Library. */
export const integrationsApi = {
  mcp: () => request<{ servers: McpServerView[]; presets: McpPreset[] }>('GET', '/api/library/mcp'),
  createMcp: (input: McpServerInput) => request<{ ok: true; server: McpServerView }>('POST', '/api/library/mcp', input),
  updateMcp: (id: string, input: McpServerInput) => request<{ ok: true; server: McpServerView }>('POST', `/api/library/mcp/${enc(id)}`, input),
  setMcpDefault: (id: string, on: boolean) => request<{ ok: true; server: McpServerView }>('POST', `/api/library/mcp/${enc(id)}/default`, { on }),
  deleteMcp: (id: string) => request<{ ok: true }>('POST', `/api/library/mcp/${enc(id)}/delete`, { confirm: true }),
  testMcp: (id: string) => request<{ result: McpTestResult }>('POST', `/api/library/mcp/${enc(id)}/test`, {}),

  plugins: () => request<{ plugins: PluginView[] }>('GET', '/api/library/plugins'),
  availablePlugins: () => request<{ plugins: AvailablePlugin[] }>('GET', '/api/library/plugins/available'),
  setPluginDefault: (id: string, on: boolean) => request<{ ok: true }>('POST', `/api/library/plugins/${enc(id)}/default`, { on }),
  setPluginEnabled: (id: string, on: boolean) => request<{ ok: true; output: string }>('POST', `/api/library/plugins/${enc(id)}/enabled`, { on }),
  installPlugin: (id: string) => request<{ ok: true; output: string }>('POST', '/api/library/plugins/install', { id, confirm: true }),
  uninstallPlugin: (id: string) => request<{ ok: true; output: string }>('POST', `/api/library/plugins/${enc(id)}/uninstall`, { confirm: true }),

  codexPlugins: () => request<{ plugins: CodexPluginView[] }>('GET', '/api/library/codex-plugins'),
  availableCodexPlugins: () => request<{ plugins: AvailablePlugin[] }>('GET', '/api/library/codex-plugins/available'),
  installCodexPlugin: (id: string) => request<{ ok: true; output: string }>('POST', '/api/library/codex-plugins/install', { id, confirm: true }),
  uninstallCodexPlugin: (id: string) => request<{ ok: true; output: string }>('POST', `/api/library/codex-plugins/${enc(id)}/uninstall`, { confirm: true }),
};
