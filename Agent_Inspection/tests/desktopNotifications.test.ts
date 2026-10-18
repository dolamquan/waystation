import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { DesktopNotifications, DESKTOP_APP_ID, registerNotificationShortcut } from '../desktop/notifications.mjs';
import { desktopBridge } from '../daemon/notify/desktopBridge.ts';
import { INBOX_CHANNEL_ID } from '../daemon/library/types.ts';
import { NOTIFY_DESTINATIONS_ENV, NOTIFY_TOKEN_ENV } from '../daemon/notify/notifier.ts';
import type { ManagedLaunch } from '../daemon/managed/types.ts';
import { makeNotifier } from './notifyHelpers.ts';

class Socket extends EventEmitter {
  readyState = 1;
  requests: Array<{ type: string; id: string; title: string; body: string }> = [];
  send(data: string, done: (error?: Error) => void) { this.requests.push(JSON.parse(data)); done(); }
  receive(message: unknown) { this.emit('message', JSON.stringify(message)); }
}

describe('Desktop delivery bridge', () => {
  it('uses the connected native host once and waits for its acknowledgment', async () => {
    const { notifier, showToast } = makeNotifier();
    const channel = notifier.createChannel({ kind: 'desktop', label: 'PC' });
    const socket = new Socket();
    desktopBridge(socket as unknown as WebSocket, notifier);
    socket.receive({ type: 'desktop:register' });
    const delivery = notifier.send([channel.id], { title: 'Done', body: 'All changes saved' });
    expect(socket.requests).toHaveLength(1);
    socket.receive({ type: 'desktop:ack', id: 'unrelated', ok: true });
    socket.receive({ type: 'desktop:ack', id: socket.requests[0].id, ok: true });
    expect(await delivery).toEqual([{ channelId: channel.id, ok: true }]);
    expect(showToast).not.toHaveBeenCalled();
    socket.emit('close');
    await notifier.send([channel.id], { title: 'Browser fallback', body: '' });
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it('records failures and disconnects without sending a duplicate fallback toast', async () => {
    const { notifier, showToast } = makeNotifier();
    const channel = notifier.createChannel({ kind: 'desktop', label: 'PC' });
    const socket = new Socket();
    desktopBridge(socket as unknown as WebSocket, notifier);
    socket.receive({ type: 'desktop:register' });
    const failed = notifier.send([channel.id], { title: 'First', body: '' });
    socket.receive({ type: 'desktop:ack', id: socket.requests[0].id, ok: false, error: 'Windows disabled alerts' });
    expect((await failed)[0]).toMatchObject({ ok: false, error: expect.stringContaining('Windows disabled alerts') });
    const disconnected = notifier.send([channel.id], { title: 'Second', body: '' });
    socket.emit('close');
    expect((await disconnected)[0]).toMatchObject({ ok: false, error: expect.stringContaining('disconnected') });
    expect(showToast).not.toHaveBeenCalled();
    expect(notifier.notifications().notifications).toHaveLength(2);
  });
});

describe('Automatic notification attachment', () => {
  const launch: ManagedLaunch = { vendor: 'claude', cwd: 'C:/work', prompt: 'go', name: 'Scout' };
  it.each(['claude', 'codex'] as const)('attaches local destinations and refreshes grants for %s resumes', (vendor) => {
    const { notifier } = makeNotifier();
    notifier.setEndpoint('http://127.0.0.1:4317');
    const prepared = notifier.attachDefaults({ ...launch, vendor });
    expect(prepared.mcpServers?.notify.env[NOTIFY_DESTINATIONS_ENV]).toBe('["desktop","inbox"]');
    const token = prepared.env![NOTIFY_TOKEN_ENV];
    expect(notifier.authenticate(token)?.channelIds).toHaveLength(2);
    notifier.revoke(prepared.agentId!);
    const resumed = notifier.attachDefaults({ ...prepared, resumeSessionId: 'existing' });
    expect(resumed.env![NOTIFY_TOKEN_ENV]).not.toBe(token);
    expect(notifier.authenticate(resumed.env![NOTIFY_TOKEN_ENV])?.agentId).toBe(prepared.agentId);
    expect(resumed.appendSystemPrompt).toBe(prepared.appendSystemPrompt);
    expect(notifier.listChannels().filter((channel) => channel.kind === 'desktop')).toHaveLength(1);
  });

  it('honors explicit inbox-only selection and paused Desktop channels', () => {
    const { notifier } = makeNotifier();
    notifier.setEndpoint('http://127.0.0.1:4317');
    notifier.createChannel({ kind: 'desktop', label: 'PC', enabled: false });
    expect(notifier.attachDefaults(launch).mcpServers?.notify.env[NOTIFY_DESTINATIONS_ENV]).toBe('["inbox"]');
    const explicit = { ...launch, agentId: 'managed:explicit' };
    const part = notifier.contribute({ notifyChannelIds: [INBOX_CHANNEL_ID] }, explicit);
    const resumed = notifier.attachDefaults({ ...explicit, ...part });
    expect(notifier.authenticate(resumed.env![NOTIFY_TOKEN_ENV])?.channelIds).toEqual([INBOX_CHANNEL_ID]);
  });
});

describe('Native system notifications', () => {
  const instances: FakeNotification[] = [];
  class FakeNotification extends EventEmitter {
    static isSupported() { return true; }
    constructor(readonly options: unknown) { super(); instances.push(this); }
    show() {}
  }
  it('retains alerts, opens the station on click, and reports OS submission/failure', async () => {
    const click = vi.fn();
    const native = new DesktopNotifications({ Notification: FakeNotification, icon: () => undefined, onClick: click });
    const sent = native.show({ title: 'Hello <>&', body: 'A real update' });
    const first = instances.at(-1)!;
    first.emit('show');
    await sent;
    expect(native.active.has(first)).toBe(true);
    first.emit('click');
    expect(click).toHaveBeenCalledTimes(1);
    const failed = native.show({ title: 'Second', body: '' });
    instances.at(-1)!.emit('failed', {}, 'not registered');
    await expect(failed).rejects.toThrow('not registered');
    first.emit('close');
    expect(native.active.size).toBe(0);
  });

  it('creates the Windows shortcut with a matching notification identity', () => {
    const writeShortcutLink = vi.fn(() => true);
    registerNotificationShortcut({ app: { isPackaged: false }, shell: { writeShortcutLink }, projectRoot: 'C:\\source with spaces', appData: process.env.APPDATA });
    expect(writeShortcutLink).toHaveBeenCalledWith(expect.stringContaining('Waystation.lnk'), 'create', expect.objectContaining({ appUserModelId: DESKTOP_APP_ID, args: '"C:\\source with spaces"', target: process.execPath }));
  });
});
