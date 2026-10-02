import type { Agent, AgentEvent } from './api.ts';

export type ActivityFilter = 'messages' | 'tools' | 'all';

export function filterActivity<T extends AgentEvent>(events: readonly T[], filter: ActivityFilter): T[] {
  return events.filter(event => filter === 'all' || (filter === 'messages'
    ? event.kind === 'prompt' || event.kind === 'assistant' || event.kind === 'error'
    : event.kind === 'tool_call' || event.kind === 'tool_result'));
}

/** History and live events can overlap while the initial request is in flight. */
export function mergeActivity<T extends AgentEvent>(existing: readonly T[], incoming: readonly T[]): T[] {
  const unique = new Map<string, T>();
  for (const event of [...existing, ...incoming]) {
    const key = JSON.stringify([event.agentId, event.ts, event.kind, event.summary]);
    if (!unique.has(key)) unique.set(key, event);
  }
  return [...unique.values()].sort((a, b) => a.ts - b.ts).slice(-200);
}

export function activityTitle(event: AgentEvent): string {
  switch (event.kind) {
    case 'prompt': return 'You';
    case 'assistant': return 'Agent';
    case 'tool_result': return 'Tool result';
    case 'error': return 'Something went wrong';
    case 'stop': return 'Session ended';
    case 'system': return 'Session update';
    case 'status': return event.summary === 'turn started' ? 'Started working' : event.summary === 'turn complete' ? 'Finished this turn' : 'Status update';
    case 'tool_call': {
      const tool = event.summary.replace(/^⏸\s*/, '').split(':')[0].trim();
      const labels: Record<string, string> = {
        Bash: 'Run a command', Read: 'Read a file', Write: 'Write a file', Edit: 'Edit a file',
        Grep: 'Search files', Glob: 'Find files', WebSearch: 'Search the web', WebFetch: 'Read a web page',
        exec: 'Run a tool', exec_command: 'Run a command', apply_patch: 'Edit files',
      };
      return labels[tool] ?? (tool.startsWith('mcp__') ? 'Use a connected tool' : tool.replaceAll('_', ' ') || 'Tool call');
    }
  }
}

export function sessionSource(agent: Agent): string {
  if (agent.tier === 'A') return 'Launched in Waystation';
  if (/vscode|editor/i.test(agent.source)) return 'Editor session';
  if (agent.vendor === 'claude' && agent.tier === 'B') return 'Claude Code session';
  return 'Detected on this machine';
}

export function readableTime(ts: number | undefined, now = Date.now()): string {
  if (!ts) return 'Not recorded';
  const seconds = Math.max(0, Math.floor((now - ts) / 1000));
  if (seconds < 10) return 'Just now';
  if (seconds < 60) return `${seconds} sec ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`;
  const days = Math.floor(seconds / 86400);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

export function currentActivity(agent: Agent, latest?: AgentEvent): string {
  if (agent.status === 'stopped') return 'This session has ended.';
  if (agent.status === 'waiting') return 'Waiting for your input or a tool approval.';
  if (agent.status === 'idle') return 'Ready for the next task.';
  if (latest?.kind === 'tool_call') return `${activityTitle(latest)}…`;
  if (agent.currentActivity && !/^\s*[\[{]|^(?:exec|\w+_\w+):/i.test(agent.currentActivity)) {
    return agent.currentActivity === 'turn started' ? 'Working on the current task.' : agent.currentActivity === 'turn complete' ? 'Finished the last turn.' : agent.currentActivity;
  }
  return agent.status === 'busy' ? 'Working on the current task.' : 'Following this session’s activity.';
}
