import type { TowerStore } from '../store/db.ts';
import { UserError } from '../userError.ts';
import { isRemoteRole } from './access.ts';
import { DeviceRegistry, type PairingOffer, type RemoteDevice } from './devices.ts';
import { RemoteGateway } from './gateway.ts';

/**
 * Remote access settings and the gateway's lifecycle. Off by default. Managed only from the desktop:
 * the gateway refuses every /api/remote route.
 */
export interface RemoteConfig {
  readonly enabled: boolean;
  /** The gateway listens on 127.0.0.1 at this port; Tailscale Serve (or a tunnel) publishes it. */
  readonly port: number;
  /** Host names devices use, e.g. `my-pc.tail1234.ts.net`. */
  readonly hostnames: readonly string[];
}

export interface RemoteStatus {
  readonly config: RemoteConfig;
  readonly running: boolean;
  readonly error?: string;
  readonly devices: readonly RemoteDevice[];
  readonly pairing?: PairingOffer;
}

export const DEFAULT_REMOTE: RemoteConfig = { enabled: false, port: 4318, hostnames: [] };
const CONFIG_ID = 'remote_access';
const MAX_HOSTNAMES = 5;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/;
const MIN_PORT = 1024;
const MAX_PORT = 65_535;

type RemoteStore = Pick<TowerStore, 'loadRecords' | 'saveRecord' | 'deleteRecord' | 'audit'>;

export interface RemoteAccessOptions {
  readonly store: RemoteStore;
  readonly localHost: string;
  readonly localPort: number;
  readonly token: string;
}

export function validateRemoteConfig(raw: unknown, localPort: number): RemoteConfig {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const port = body.port === undefined || body.port === '' ? DEFAULT_REMOTE.port : Number(body.port);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) throw new UserError(`Choose a port between ${MIN_PORT} and ${MAX_PORT}.`);
  if (port === localPort) throw new UserError('The remote port must differ from Waystation\'s own port.');
  const rawHosts = Array.isArray(body.hostnames) ? body.hostnames : [];
  const hostnames = [...new Set(rawHosts.map((host) => String(host).trim().toLowerCase()).filter(Boolean))];
  if (hostnames.length > MAX_HOSTNAMES) throw new UserError(`At most ${MAX_HOSTNAMES} host names.`);
  const bad = hostnames.find((host) => !HOSTNAME.test(host));
  if (bad) throw new UserError(`"${bad}" is not a host name. Use one like my-pc.tail1234.ts.net, without https://.`);
  return { enabled: body.enabled === true, port, hostnames };
}

export class RemoteAccess {
  readonly devices: DeviceRegistry;
  private gateway?: RemoteGateway;
  private error?: string;

  constructor(private readonly options: RemoteAccessOptions) {
    this.devices = new DeviceRegistry(options.store);
  }

  config(): RemoteConfig {
    const saved = this.options.store.loadRecords<RemoteConfig & { id: string }>('settings').find((record) => record.id === CONFIG_ID);
    if (!saved) return DEFAULT_REMOTE;
    const { id: _id, ...config } = saved;
    return config;
  }

  status(): RemoteStatus {
    return { config: this.config(), running: this.gateway !== undefined, ...(this.error ? { error: this.error } : {}), devices: this.devices.list(), ...this.pendingView() };
  }

  /** Starts the gateway when remote access is on. A failure (port in use) is reported, never fatal. */
  async start(): Promise<void> {
    const config = this.config();
    if (!config.enabled || this.gateway) return;
    const gateway = new RemoteGateway({
      devices: this.devices,
      localHost: this.options.localHost,
      localPort: this.options.localPort,
      token: this.options.token,
      hostnames: config.hostnames,
      audit: (action, target, detail) => this.options.store.audit(action, target, detail),
    }, config.port);
    try {
      await gateway.start();
      this.gateway = gateway;
      this.error = undefined;
    } catch (error) {
      this.error = `Remote access could not start on port ${config.port}: ${(error as Error).message}`;
    }
  }

  async stop(): Promise<void> {
    const gateway = this.gateway;
    this.gateway = undefined;
    await gateway?.stop();
  }

  async configure(raw: unknown): Promise<RemoteStatus> {
    const config = validateRemoteConfig(raw, this.options.localPort);
    this.options.store.saveRecord('settings', { id: CONFIG_ID, ...config });
    this.options.store.audit('remote_config', CONFIG_ID, config);
    await this.stop();
    this.error = undefined;
    await this.start();
    return this.status();
  }

  startPairing(rawRole: unknown): PairingOffer {
    const role = rawRole === undefined ? 'triage' : rawRole;
    if (!isRemoteRole(role)) throw new UserError('Choose View, Triage or Full for the device.');
    const offer = this.devices.startPairing(role);
    this.options.store.audit('remote_pairing_started', CONFIG_ID, { role });
    return offer;
  }

  cancelPairing(): void {
    this.devices.cancelPairing();
  }

  revoke(id: string): void {
    this.devices.revoke(id);
    this.gateway?.disconnect(id);
    this.options.store.audit('remote_revoke', id, {});
  }

  setRole(id: string, rawRole: unknown): RemoteDevice {
    if (!isRemoteRole(rawRole)) throw new UserError('Choose View, Triage or Full for the device.');
    const device = this.devices.setRole(id, rawRole);
    // Live connections were authorised under the old role.
    this.gateway?.disconnect(id);
    this.options.store.audit('remote_role', id, { role: rawRole });
    return device;
  }

  private pendingView(): { pairing?: PairingOffer } {
    const pairing = this.devices.pendingOffer();
    return pairing ? { pairing } : {};
  }
}
