import { describe, expect, it } from 'vitest';
import { requiredRole, roleAllows, socketRole } from '../daemon/remote/access.ts';

describe('requiredRole', () => {
  it('lets View read the live fleet, usage and history', () => {
    for (const path of ['/api/state', '/api/health', '/api/agents/a1/events', '/api/agents/a1/outputs', '/api/teams', '/api/teams/t1/log',
      '/api/factory', '/api/usage', '/api/usage/windows', '/api/spend-cap', '/api/schedules', '/api/sessions', '/api/notifications', '/api/providers']) {
      expect(requiredRole('GET', path), path).toBe('view');
    }
  });

  it('lets Triage decide, message, interrupt and stop', () => {
    for (const path of ['/api/interceptions/i1', '/api/agents/a1/instruct', '/api/agents/a1/interrupt', '/api/agents/a1/stop',
      '/api/agents/a1/intercept', '/api/agents/a1/breaker/reset', '/api/agents/a1/queue/m1/cancel', '/api/teams/t1/pause',
      '/api/teams/t1/resume', '/api/teams/t1/message', '/api/teams/t1/plan/approve', '/api/contention/notify', '/api/notifications/read']) {
      expect(requiredRole('POST', path), path).toBe('triage');
    }
  });

  it('needs Triage for file contents (diffs)', () => {
    for (const path of ['/api/agents/a1/outputs/diff', '/api/teams/t1/members/m1/diff', '/api/factory/items/f1/diff']) {
      expect(requiredRole('GET', path), path).toBe('triage');
    }
  });

  it('keeps file access, launches, consoles and settings at Full', () => {
    expect(requiredRole('GET', '/api/files/read')).toBe('full');
    expect(requiredRole('POST', '/api/files/write')).toBe('full');
    expect(requiredRole('POST', '/api/managed')).toBe('full');
    expect(requiredRole('POST', '/api/consoles/c1/keys')).toBe('full');
    expect(requiredRole('POST', '/api/spend-cap')).toBe('full');
    expect(requiredRole('GET', '/api/library/mcp')).toBe('full');
    expect(requiredRole('POST', '/api/somewhere/new')).toBe('full');
  });

  it('never exposes remote management, hooks, agent bridges or CLI callbacks', () => {
    for (const [method, path] of [['GET', '/api/remote'], ['POST', '/api/remote/pair'], ['POST', '/api/remote/devices/d1/revoke'],
      ['POST', '/api/hooks/install'], ['POST', '/api/hooks/uninstall'], ['POST', '/hook/pretooluse'], ['POST', '/agent/notify'],
      ['POST', '/team/call'], ['POST', '/mcp'], ['POST', '/api/cli/x/started'], ['GET', '/api/audit']] as const) {
      expect(requiredRole(method, path), `${method} ${path}`).toBe('never');
    }
  });

  it('does not let path tricks reach a looser rule', () => {
    expect(requiredRole('POST', '/api/agents/a1/stop/../../files/write')).toBe('full');
    expect(requiredRole('GET', '/api/state/')).toBe('full');
    expect(requiredRole('DELETE', '/api/state')).toBe('never');
  });
});

describe('roleAllows', () => {
  it('orders the roles view < triage < full and refuses never', () => {
    expect(roleAllows('view', 'view')).toBe(true);
    expect(roleAllows('view', 'triage')).toBe(false);
    expect(roleAllows('triage', 'view')).toBe(true);
    expect(roleAllows('triage', 'full')).toBe(false);
    expect(roleAllows('full', 'full')).toBe(true);
    expect(roleAllows('full', 'never')).toBe(false);
  });
});

describe('socketRole', () => {
  it('needs View for the live feed and Full for terminals and browser tiles', () => {
    expect(socketRole('/ws')).toBe('view');
    expect(socketRole('/pty/abc')).toBe('full');
    expect(socketRole('/ws/browser/tile-1')).toBe('full');
    expect(socketRole('/elsewhere')).toBe('never');
  });
});
