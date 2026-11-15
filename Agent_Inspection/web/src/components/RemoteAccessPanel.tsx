import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, isRemote, type PairingOffer, type RemoteRole, type RemoteStatus } from '../api.ts';
import { timeAgo } from '../format.ts';
import { Confirm } from './Modal.tsx';
import { Icon } from './Icon.tsx';

type Notify = (text: string, kind?: 'ok' | 'error') => void;

const ROLES: ReadonlyArray<readonly [RemoteRole, string, string]> = [
  ['view', 'View only', 'See agents, their activity (including anything they print), usage and history.'],
  ['triage', 'Triage', 'Also review diffs, approve or deny tool calls, answer questions, message, interrupt and stop agents. Approving and messaging can make agents run commands: treat this device like your keys.'],
  ['full', 'Full control', 'Everything, including terminals, files and launching agents. Only for devices you fully trust.'],
];
const ROLE_NAME: Record<RemoteRole, string> = { view: 'View only', triage: 'Triage', full: 'Full control' };
const POLL_PAIRING_MS = 3000;

function secondsLeft(offer: PairingOffer, now: number): number {
  return Math.max(0, Math.round((offer.expiresAt - now) / 1000));
}

interface RemoteAccessPanelProps {
  readonly notify: Notify;
}

/** Desktop only: switch remote access on, pair devices, and manage what each may do. */
export function RemoteAccessPanel({ notify }: RemoteAccessPanelProps) {
  const [status, setStatus] = useState<RemoteStatus>();
  const [enabled, setEnabled] = useState(false);
  const [port, setPort] = useState('4318');
  const [hostnames, setHostnames] = useState('');
  const [role, setRole] = useState<RemoteRole>('triage');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [revoking, setRevoking] = useState<{ id: string; name: string }>();
  const remote = isRemote();

  const load = useCallback(async (resetForm: boolean) => {
    try {
      const { remote: next } = await api.remoteStatus();
      setStatus(next);
      if (resetForm) {
        setEnabled(next.config.enabled);
        setPort(String(next.config.port));
        setHostnames(next.config.hostnames.join('\n'));
      }
    } catch (error) {
      notify((error as Error).message, 'error');
    }
  }, [notify]);

  useEffect(() => { if (!remote) void load(true); }, [load, remote]);
  // While a code is on offer, watch for the device to appear and count the code down.
  const pairing = status?.pairing;
  useEffect(() => {
    if (!pairing) return undefined;
    const timer = setInterval(() => { setNow(Date.now()); void load(false); }, POLL_PAIRING_MS);
    return () => clearInterval(timer);
  }, [pairing, load]);

  if (remote) return null;

  const run = async (action: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await action();
      if (done) notify(done);
      await load(false);
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    const hosts = hostnames.split(/[\s,]+/).map((host) => host.trim()).filter(Boolean);
    void run(async () => {
      const { remote: next } = await api.remoteConfigure({ enabled, port: Number(port), hostnames: hosts });
      setStatus(next);
      notify(next.error ?? (next.running ? 'Remote access is on' : 'Remote access is off'), next.error ? 'error' : 'ok');
    });
  };

  const firstHost = status?.config.hostnames[0];
  const deviceUrl = firstHost ? `https://${firstHost}` : undefined;

  return (
    <section className="ops-section workspace-panel remote-access" aria-labelledby="remote-access-title">
      <div className="remote-access-head">
        <h2 id="remote-access-title">Remote access</h2>
        <span className={`status-pill ${status?.running ? 'status-active' : 'status-warning'}`}>{status?.running ? 'On' : 'Off'}</span>
      </div>
      <p className="remote-access-intro">
        Reach this station from your phone or another computer on your private network. Waystation listens on this machine only; <a href="https://tailscale.com/kb/1312/serve" target="_blank" rel="noopener noreferrer">Tailscale Serve</a> publishes it, with HTTPS, to your own devices. Run <code>tailscale serve --bg {port || '4318'}</code> once, then enter the machine’s Tailscale name below.
      </p>
      {status?.error && <p className="form-error" role="alert">{status.error}</p>}

      <form className="remote-access-form" onSubmit={save}>
        <label className="check-field"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /><span>Turn on remote access</span></label>
        <label className="field"><span>Gateway port (on this machine)</span><input className="text-input" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} /></label>
        <label className="field"><span>Host names your devices use</span>
          <textarea className="text-input" rows={2} value={hostnames} onChange={(e) => setHostnames(e.target.value)} placeholder="my-pc.tail1234.ts.net" spellCheck={false} />
        </label>
        <div className="remote-access-actions"><button className="btn btn-go" type="submit" disabled={busy}>Save</button></div>
      </form>

      {status?.running && (
        <div className="remote-pairing">
          <h3>Pair a device</h3>
          {pairing ? (
            <div className="remote-code" role="status">
              <span className="remote-code-value" aria-label={`Pairing code ${pairing.code.split('').join(' ')}`}>{pairing.code}</span>
              <p>On the device, open {deviceUrl ? <code>{deviceUrl}</code> : 'your Tailscale address'} and enter this code. It allows <strong>{ROLE_NAME[pairing.role]}</strong> and expires in {secondsLeft(pairing, now)} s.</p>
              <button className="btn btn-small btn-ghost" disabled={busy} onClick={() => void run(() => api.remoteCancelPair())}>Cancel</button>
            </div>
          ) : (
            <div className="remote-pair-start">
              <fieldset className="remote-roles">
                <legend>What may it do?</legend>
                {ROLES.map(([value, label, hint]) => (
                  <label key={value} className={`remote-role ${role === value ? 'remote-role-on' : ''}`}>
                    <input type="radio" name="remote-role" value={value} checked={role === value} onChange={() => setRole(value)} />
                    <span><strong>{label}</strong><small>{hint}</small></span>
                  </label>
                ))}
              </fieldset>
              <button className="btn" disabled={busy} onClick={() => void run(() => api.remotePair(role))}><Icon name="plus" size={15} />Show a pairing code</button>
            </div>
          )}
        </div>
      )}

      <div className="remote-devices">
        <h3>Paired devices</h3>
        {!status?.devices.length && <p className="remote-empty">No devices yet.</p>}
        <ul className="ops-list">
          {status?.devices.map((device) => (
            <li key={device.id} className="ops-row remote-device">
              <div className="ops-row-main"><strong>{device.name}</strong><small>Last used {timeAgo(device.lastSeenAt, now)} · paired {new Date(device.createdAt).toLocaleDateString()}</small></div>
              <select className="sort-select" value={device.role} aria-label={`Access for ${device.name}`} disabled={busy}
                onChange={(e) => void run(() => api.remoteSetRole(device.id, e.target.value as RemoteRole), `${device.name} now has ${ROLE_NAME[e.target.value as RemoteRole]}`)}>
                {ROLES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <button className="btn btn-small btn-danger" disabled={busy} onClick={() => setRevoking({ id: device.id, name: device.name })}>Remove</button>
            </li>
          ))}
        </ul>
      </div>
      {revoking && (
        <Confirm
          title={`Remove ${revoking.name}?`}
          body="It is disconnected at once and must be paired again to reach this station."
          confirmLabel="Remove device"
          danger
          onConfirm={() => void run(() => api.remoteRevoke(revoking.id), `${revoking.name} removed`)}
          onClose={() => setRevoking(undefined)}
        />
      )}
    </section>
  );
}
