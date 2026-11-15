import { describe, expect, it } from 'vitest';
import { DeviceRegistry, PairingError, DEVICE_IDLE_MS, PAIRING_TTL_MS } from '../daemon/remote/devices.ts';
import { TowerStore } from '../daemon/store/db.ts';

function setup(start = 1_000_000) {
  let now = start;
  const store = new TowerStore(':memory:');
  const registry = new DeviceRegistry(store, () => now);
  return { store, registry, advance: (ms: number) => { now += ms; }, at: () => now };
}

describe('DeviceRegistry pairing', () => {
  it('pairs a device with a one-time code and recognises its token afterwards', () => {
    const { registry, store } = setup();
    const offer = registry.startPairing('triage');
    expect(offer.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    const { device, token } = registry.completePairing(offer.code.toLowerCase(), '  Jack’s phone ');
    expect(device).toMatchObject({ name: 'Jack’s phone', role: 'triage' });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(registry.authenticate(token)?.id).toBe(device.id);
    // Only a hash is stored.
    expect(JSON.stringify(store.loadRecords('remote_devices'))).not.toContain(token);
    // The code cannot be used twice.
    expect(() => registry.completePairing(offer.code, 'Second')).toThrow(PairingError);
  });

  it('expires codes, and burns a code after five wrong guesses', () => {
    const { registry, advance } = setup();
    const offer = registry.startPairing('view');
    advance(PAIRING_TTL_MS + 1);
    expect(() => registry.completePairing(offer.code, 'Late')).toThrow(/expired|no pairing/i);
    const fresh = registry.startPairing('view');
    for (let i = 0; i < 5; i++) expect(() => registry.completePairing('AAAAAAAA', 'Guess')).toThrow(PairingError);
    expect(() => registry.completePairing(fresh.code, 'Right, but too late')).toThrow(PairingError);
  });

  it('replaces an earlier code when a new pairing starts', () => {
    const { registry } = setup();
    const first = registry.startPairing('view');
    const second = registry.startPairing('full');
    expect(() => registry.completePairing(first.code, 'Old')).toThrow(PairingError);
    expect(registry.completePairing(second.code, 'New').device.role).toBe('full');
  });

  it('requires a device name', () => {
    const { registry } = setup();
    const offer = registry.startPairing('view');
    expect(() => registry.completePairing(offer.code, '   ')).toThrow(/name/i);
  });
});

describe('DeviceRegistry devices', () => {
  it('rejects unknown, revoked and long-idle tokens', () => {
    const { registry, advance } = setup();
    const a = registry.completePairing(registry.startPairing('view').code, 'A');
    const b = registry.completePairing(registry.startPairing('view').code, 'B');
    expect(registry.authenticate('nope')).toBeUndefined();
    expect(registry.authenticate(undefined)).toBeUndefined();
    registry.revoke(a.device.id);
    expect(registry.authenticate(a.token)).toBeUndefined();
    advance(DEVICE_IDLE_MS - 1000);
    expect(registry.authenticate(b.token)).toBeDefined(); // use keeps it alive
    advance(DEVICE_IDLE_MS - 1000);
    expect(registry.authenticate(b.token)).toBeDefined();
    advance(DEVICE_IDLE_MS + 1);
    expect(registry.authenticate(b.token)).toBeUndefined();
    expect(registry.list().map((device) => device.name)).toEqual([]);
  });

  it('changes a device role, survives a restart, and never lists hashes', () => {
    const { registry, store, at } = setup();
    const { device, token } = registry.completePairing(registry.startPairing('view').code, 'Tablet');
    registry.setRole(device.id, 'full');
    const reloaded = new DeviceRegistry(store, at);
    expect(reloaded.authenticate(token)?.role).toBe('full');
    expect(reloaded.list()).toEqual([expect.objectContaining({ id: device.id, name: 'Tablet', role: 'full' })]);
    expect(Object.keys(reloaded.list()[0])).not.toContain('tokenHash');
    expect(() => reloaded.setRole('missing', 'view')).toThrow(/not found/i);
    expect(() => reloaded.setRole(device.id, 'admin' as never)).toThrow(/View, Triage or Full/);
  });
});
