import type { McpPreset } from './types.ts';

/**
 * One-click starting points. Package names checked against npm / PyPI (October 2026).
 * `uvx` needs uv installed (https://docs.astral.sh/uv/); everything else needs Node's `npx`.
 */
export const MCP_PRESETS: readonly McpPreset[] = [
  {
    id: 'playwright',
    label: 'Playwright',
    description: 'Drive a real browser: open pages, click, type, read the accessibility tree and take screenshots.',
    input: { name: 'playwright', label: 'Playwright', transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'], presetId: 'playwright' },
    requiredSecrets: [],
  },
  {
    id: 'chrome-devtools',
    label: 'Chrome DevTools',
    description: 'Inspect and debug a live Chrome: console, network, performance traces and screenshots.',
    input: { name: 'chrome-devtools', label: 'Chrome DevTools', transport: 'stdio', command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'], presetId: 'chrome-devtools' },
    requiredSecrets: [],
  },
  {
    id: 'fetch',
    label: 'Fetch',
    description: 'Fetch a URL and read it as Markdown. Needs uv (uvx) installed.',
    input: { name: 'fetch', label: 'Fetch', transport: 'stdio', command: 'uvx', args: ['mcp-server-fetch'], presetId: 'fetch' },
    requiredSecrets: [],
  },
  {
    id: 'filesystem',
    label: 'Filesystem',
    description: 'Read and write files inside the folders you list. Replace the example folder with your own.',
    input: {
      name: 'filesystem', label: 'Filesystem', transport: 'stdio', command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\you\\Documents'], presetId: 'filesystem',
    },
    requiredSecrets: [],
  },
  {
    id: 'context7',
    label: 'Context7',
    description: 'Up-to-date library documentation and code examples. An API key is optional (higher rate limits).',
    input: { name: 'context7', label: 'Context7', transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'], presetId: 'context7' },
    requiredSecrets: [],
  },
  {
    id: 'github',
    label: 'GitHub',
    description: 'Issues, pull requests, code search and repositories through GitHub’s hosted MCP server. Needs a personal access token.',
    input: { name: 'github', label: 'GitHub', transport: 'http', url: 'https://api.githubcopilot.com/mcp/', presetId: 'github' },
    requiredSecrets: ['Authorization'],
  },
  {
    id: 'memory',
    label: 'Memory',
    description: 'A small local knowledge graph the agent can store facts in and recall later.',
    input: { name: 'memory', label: 'Memory', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], presetId: 'memory' },
    requiredSecrets: [],
  },
  {
    id: 'sequential-thinking',
    label: 'Sequential thinking',
    description: 'A structured scratchpad for step-by-step problem solving.',
    input: {
      name: 'sequential-thinking', label: 'Sequential thinking', transport: 'stdio', command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'], presetId: 'sequential-thinking',
    },
    requiredSecrets: [],
  },
];

export const presetById = (id: string): McpPreset | undefined => MCP_PRESETS.find((preset) => preset.id === id);
