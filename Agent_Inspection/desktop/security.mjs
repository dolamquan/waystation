export function isStationUrl(value, origin) {
  try {
    const url = new URL(value);
    return url.origin === origin && url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/' && !url.username && !url.password;
  } catch { return false; }
}

export function externalUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) return undefined;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || /^(localhost|127\.|\[?::1\]?)/i.test(url.hostname)) return undefined;
    return url.href;
  } catch { return undefined; }
}

export function trustedSender(event, window, origin) {
  return Boolean(window && !window.isDestroyed() && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame && isStationUrl(event.senderFrame.url, origin));
}

/** Baseline a snapshot; notify only on newly raised attention, including guards. */
export class AttentionTracker {
  keys = new Set();
  primed = false;

  update(agents, pending) {
    const keys = new Set([
      ...pending.map((item) => `approval:${item.id}`),
      ...agents.filter((agent) => agent.status === 'waiting').map((agent) => `waiting:${agent.id}`),
      ...agents.filter((agent) => agent.breaker && agent.breaker.level !== 'ok').map((agent) => `guard:${agent.id}:${agent.breaker.level}:${agent.breaker.since}`),
    ]);
    const raised = this.primed && [...keys].some((key) => !this.keys.has(key));
    this.keys = keys;
    this.primed = true;
    const approvalAgents = new Set(pending.map((item) => item.agentId));
    return {
      raised,
      busy: agents.filter((agent) => agent.status === 'busy').length,
      attention: agents.filter((agent) => agent.status === 'waiting' || approvalAgents.has(agent.id) || (agent.breaker && agent.breaker.level !== 'ok')).length,
      approvals: pending.length,
    };
  }
}
