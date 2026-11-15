/**
 * What a paired remote device may do. Everything is denied or Full unless a rule below lowers it:
 * new routes are safe by default. Patterns match whole, already-normalised paths.
 */
export type RemoteRole = 'view' | 'triage' | 'full';
export type RequiredRole = RemoteRole | 'never';

export const REMOTE_ROLES: readonly RemoteRole[] = ['view', 'triage', 'full'];

const SEGMENT = '[^/]+';
const route = (path: string): RegExp => new RegExp(`^${path.replace(/:\w+/g, SEGMENT)}$`);

/**
 * Watching the fleet: agent activity and transcripts (so anything an agent printed), usage and history.
 * No file contents, settings or the audit log.
 */
const VIEW_GETS = [
  '/api/state', '/api/health', '/api/agents/:id/events', '/api/agents/:id/queue', '/api/agents/:id/outputs',
  '/api/agents/:id/review', '/api/teams', '/api/teams/:id/log',
  '/api/factory', '/api/usage', '/api/usage/windows', '/api/spend-cap', '/api/schedules',
  '/api/schedules/:id/runs', '/api/sessions', '/api/notifications', '/api/templates', '/api/skills', '/api/providers',
].map(route);

/** File contents: reviewing what agents changed is part of deciding on it. */
const TRIAGE_GETS = ['/api/agents/:id/outputs/diff', '/api/teams/:id/members/:member/diff', '/api/factory/items/:id/diff'].map(route);

/**
 * Deciding and steering what is already running. Approving a tool call or messaging an agent can make it
 * run commands, so Triage is code execution through your agents; launching, files and consoles stay at Full.
 */
const TRIAGE_POSTS = [
  '/api/interceptions/:id', '/api/agents/:id/instruct', '/api/agents/:id/interrupt', '/api/agents/:id/stop',
  '/api/agents/:id/intercept', '/api/agents/:id/breaker/reset', '/api/agents/:id/queue/:message/:action',
  '/api/agents/:id/review', '/api/teams/:id/pause', '/api/teams/:id/resume', '/api/teams/:id/message',
  '/api/teams/:id/plan/approve', '/api/contention/notify', '/api/notifications/read', '/api/schedules/:id/enabled',
].map(route);

/** Never through the gateway: managing remote access itself, hooks, agent bridges and local CLI callbacks. */
const NEVER = [/^\/api\/remote(?:\/|$)/, /^\/api\/hooks\//, /^\/api\/cli\//, /^\/api\/audit$/, /^\/hook\//, /^\/agent\//, /^\/team\//, /^\/mcp$/];

const hasDotSegment = (path: string): boolean => path.split('/').some((part) => part === '.' || part === '..');

export function requiredRole(method: string, path: string): RequiredRole {
  if (method !== 'GET' && method !== 'POST') return 'never';
  if (NEVER.some((pattern) => pattern.test(path))) return 'never';
  if (hasDotSegment(path)) return 'full';
  if (method === 'GET' && VIEW_GETS.some((pattern) => pattern.test(path))) return 'view';
  if (method === 'GET' && TRIAGE_GETS.some((pattern) => pattern.test(path))) return 'triage';
  if (method === 'POST' && TRIAGE_POSTS.some((pattern) => pattern.test(path))) return 'triage';
  return 'full';
}

/** WebSocket paths: the live feed is a view; terminals and browser tiles are full control of the machine. */
export function socketRole(path: string): RequiredRole {
  if (path === '/ws') return 'view';
  if (/^\/pty\/[A-Za-z0-9-]{1,64}$/.test(path) || /^\/ws\/browser\/[A-Za-z0-9_-]{1,128}$/.test(path)) return 'full';
  return 'never';
}

export function roleAllows(role: RemoteRole, required: RequiredRole): boolean {
  if (required === 'never') return false;
  return REMOTE_ROLES.indexOf(role) >= REMOTE_ROLES.indexOf(required);
}

export function isRemoteRole(value: unknown): value is RemoteRole {
  return typeof value === 'string' && (REMOTE_ROLES as readonly string[]).includes(value);
}
