import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { TowerStore } from '../store/db.ts';
import { UserError } from '../userError.ts';
import { isRemoteRole, type RemoteRole } from './access.ts';

/**
 * Devices paired for remote access. A device proves itself with a long random token that only it
 * holds (in an HttpOnly cookie); the daemon keeps the SHA-256 of it. Pairing needs a short code
 * shown on the desktop, so an agent on this machine cannot pair a device by itself.
 */

export const PAIRING_TTL_MS = 5 * 60_000;
/** A device that has not been used for this long must pair again. */
export const DEVICE_IDLE_MS = 30 * 86_400_000;
const MAX_ATTEMPTS = 5;
const CODE_LENGTH = 8;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TOKEN_BYTES = 32;
const MAX_NAME = 60;
/** Last-seen times are saved at most this often, not on every request. */
const SEEN_SAVE_MS = 60_000;

export class PairingError extends UserError {}

export interface RemoteDevice {
  readonly id: string;
  readonly name: string;
  readonly role: RemoteRole;
  readonly createdAt: number;
  readonly lastSeenAt: number;
}

interface StoredDevice extends RemoteDevice {
  readonly tokenHash: string;
}

export interface PairingOffer {
  readonly code: string;
  readonly role: RemoteRole;
  readonly expiresAt: number;
}

interface PendingPairing extends PairingOffer {
  readonly attempts: number;
}

type DeviceStore = Pick<TowerStore, 'loadRecords' | 'saveRecord' | 'deleteRecord'>;

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
const view = ({ tokenHash: _hash, ...device }: StoredDevice): RemoteDevice => device;

function sameCode(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class DeviceRegistry {
  private devices: Map<string, StoredDevice>;
  private pending?: PendingPairing;

  constructor(private readonly store: DeviceStore, private readonly now: () => number = Date.now) {
    this.devices = new Map(store.loadRecords<StoredDevice>('remote_devices').map((device) => [device.tokenHash, device]));
  }

  /** A new code replaces any earlier one: only the most recent offer on the desktop is valid. */
  startPairing(role: RemoteRole): PairingOffer {
    if (!isRemoteRole(role)) throw new UserError('Choose View, Triage or Full for the device.');
    const code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    const offer = { code, role, expiresAt: this.now() + PAIRING_TTL_MS };
    this.pending = { ...offer, attempts: 0 };
    return offer;
  }

  cancelPairing(): void {
    this.pending = undefined;
  }

  /** The code currently on offer, for the desktop to show again after a reload. */
  pendingOffer(): PairingOffer | undefined {
    const pending = this.pending;
    if (!pending || this.now() > pending.expiresAt) return undefined;
    return { code: pending.code, role: pending.role, expiresAt: pending.expiresAt };
  }

  completePairing(rawCode: unknown, rawName: unknown): { device: RemoteDevice; token: string } {
    const pending = this.pending;
    if (!pending) throw new PairingError('There is no pairing in progress. Start one on the Waystation desktop.');
    if (this.now() > pending.expiresAt) {
      this.pending = undefined;
      throw new PairingError('That code has expired. Start a new pairing on the desktop.');
    }
    const code = typeof rawCode === 'string' ? rawCode.trim().toUpperCase() : '';
    if (!sameCode(code, pending.code)) {
      const attempts = pending.attempts + 1;
      this.pending = attempts >= MAX_ATTEMPTS ? undefined : { ...pending, attempts };
      throw new PairingError(attempts >= MAX_ATTEMPTS ? 'Too many wrong codes. Start a new pairing on the desktop.' : 'That code is not right.');
    }
    const name = typeof rawName === 'string' ? rawName.trim().slice(0, MAX_NAME) : '';
    if (!name) throw new PairingError('Give this device a name, so you can recognise it later.');
    this.pending = undefined;
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const at = this.now();
    const device: StoredDevice = { id: randomUUID(), name, role: pending.role, createdAt: at, lastSeenAt: at, tokenHash: hashToken(token) };
    this.save(device);
    return { device: view(device), token };
  }

  /** The device holding this token, or undefined (unknown, revoked or idle too long). */
  authenticate(token: string | undefined): RemoteDevice | undefined {
    if (!token) return undefined;
    const hash = hashToken(token);
    const device = this.devices.get(hash);
    if (!device) return undefined;
    const at = this.now();
    if (at - device.lastSeenAt > DEVICE_IDLE_MS) {
      this.remove(device);
      return undefined;
    }
    if (at - device.lastSeenAt >= SEEN_SAVE_MS) this.save({ ...device, lastSeenAt: at });
    return view(this.devices.get(hash) ?? device);
  }

  /** Still paired and not idle-expired (removes it when expired). For devices holding live sockets. */
  isActive(id: string): boolean {
    const device = [...this.devices.values()].find((candidate) => candidate.id === id);
    if (!device) return false;
    if (this.now() - device.lastSeenAt > DEVICE_IDLE_MS) {
      this.remove(device);
      return false;
    }
    return true;
  }

  /** A live socket counts as use. */
  touch(id: string): void {
    const device = [...this.devices.values()].find((candidate) => candidate.id === id);
    if (device && this.now() - device.lastSeenAt >= SEEN_SAVE_MS) this.save({ ...device, lastSeenAt: this.now() });
  }

  list(): RemoteDevice[] {
    const at = this.now();
    for (const device of [...this.devices.values()]) if (at - device.lastSeenAt > DEVICE_IDLE_MS) this.remove(device);
    return [...this.devices.values()].map(view).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  revoke(id: string): void {
    this.remove(this.require(id));
  }

  setRole(id: string, role: RemoteRole): RemoteDevice {
    if (!isRemoteRole(role)) throw new UserError('Choose View, Triage or Full for the device.');
    const device = { ...this.require(id), role };
    this.save(device);
    return view(device);
  }

  private require(id: string): StoredDevice {
    const device = [...this.devices.values()].find((candidate) => candidate.id === id);
    if (!device) throw new UserError('Device not found.');
    return device;
  }

  private save(device: StoredDevice): void {
    this.devices = new Map(this.devices).set(device.tokenHash, device);
    this.store.saveRecord('remote_devices', device);
  }

  private remove(device: StoredDevice): void {
    const next = new Map(this.devices);
    next.delete(device.tokenHash);
    this.devices = next;
    this.store.deleteRecord('remote_devices', device.id);
  }
}
