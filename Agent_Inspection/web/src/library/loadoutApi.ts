import { request } from '../api.ts';
import type {
  ContextDoc, LaunchLoadout, LibrarySkill, McpPreset, McpServerView, NotifyChannelView, PluginView,
} from '../../../daemon/library/types.ts';

export type { ContextDoc, LaunchLoadout, LibrarySkill, McpPreset, McpServerView, NotifyChannelView, PluginView };

/**
 * The list endpoints every Library feature exposes (the contract the LoadoutPicker relies on).
 * Feature-specific calls (create, edit, delete, test…) live in each feature's own client file.
 */
export const loadoutApi = {
  skills: () => request<{ skills: LibrarySkill[] }>('GET', '/api/library/skills'),
  docs: () => request<{ docs: ContextDoc[] }>('GET', '/api/library/docs'),
  mcp: () => request<{ servers: McpServerView[]; presets: McpPreset[] }>('GET', '/api/library/mcp'),
  plugins: () => request<{ plugins: PluginView[] }>('GET', '/api/library/plugins'),
  notifyChannels: () => request<{ channels: NotifyChannelView[] }>('GET', '/api/library/notify'),
};
