import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, isRemote, type RemoteSession } from '../api.ts';
import { Icon } from './Icon.tsx';

const SESSION_CHECK_MS = 60_000;
const ROLE_LABEL = { view: 'View only', triage: 'Triage', full: 'Full control' } as const;

function defaultDeviceName(): string {
  const agent = navigator.userAgent;
  if (/iPhone/.test(agent)) return 'iPhone';
  if (/iPad/.test(agent)) return 'iPad';
  if (/Android/.test(agent)) return /Mobile/.test(agent) ? 'Android phone' : 'Android tablet';
  if (/Mac OS X/.test(agent)) return 'Mac';
  if (/Windows/.test(agent)) return 'Windows PC';
  return 'My device';
}

interface PairingScreenProps {
  readonly onPaired: (session: RemoteSession) => void;
}

function PairingScreen({ onPaired }: PairingScreenProps) {
  const [code, setCode] = useState('');
  const [name, setName] = useState(defaultDeviceName);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      onPaired(await api.remoteJoin(code, name));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="remote-pair">
      <form className="remote-pair-card" onSubmit={(event) => void submit(event)}>
        <span className="brand-mark" aria-hidden="true" />
        <h1>Pair this device</h1>
        <p>On the Waystation desktop, open <strong>Usage &amp; schedules → Setup checks → Remote access</strong> and choose <strong>Show a pairing code</strong>. Enter the code here.</p>
        <label className="field">
          <span>Pairing code</span>
          <input className="text-input remote-code-input" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} autoFocus autoComplete="one-time-code"
            autoCapitalize="characters" spellCheck={false} maxLength={8} placeholder="ABCD2345" aria-describedby="remote-pair-error" />
        </label>
        <label className="field">
          <span>Name for this device</span>
          <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </label>
        {error && <p className="form-error" id="remote-pair-error" role="alert">{error}</p>}
        <button className="btn btn-go" type="submit" disabled={busy || code.trim().length < 8 || !name.trim()}>{busy ? 'Pairing…' : 'Pair'}</button>
        <small>Only devices you pair from the desktop can reach your agents. You can remove this device there at any time.</small>
      </form>
    </main>
  );
}

interface RemoteBadgeProps {
  readonly session: RemoteSession;
  readonly onForget: () => void;
}

function RemoteBadge({ session, onForget }: RemoteBadgeProps) {
  const [open, setOpen] = useState(false);
  if (!session.device) return null;
  return (
    <div className="remote-badge">
      <button className="remote-badge-pill" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <Icon name="link" size={13} />Remote · {session.device.name} · {ROLE_LABEL[session.device.role]}
      </button>
      {open && (
        <div className="remote-badge-menu">
          <p>This device reaches Waystation through remote access with <strong>{ROLE_LABEL[session.device.role]}</strong>. Change that on the desktop.</p>
          <button className="btn btn-small btn-danger" onClick={onForget}>Forget this device</button>
        </div>
      )}
    </div>
  );
}

interface RemoteGateProps {
  readonly children: ReactNode;
}

/** Opened through the remote gateway: pair first, then the normal app with a remote badge. */
export function RemoteGate({ children }: RemoteGateProps) {
  const remote = isRemote();
  const [session, setSession] = useState<RemoteSession>();
  const [error, setError] = useState<string>();

  const check = useCallback(async () => {
    try {
      setSession(await api.remoteSession());
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!remote) return undefined;
    void check();
    // A device removed on the desktop drops back to the pairing screen.
    const timer = setInterval(() => { void check(); }, SESSION_CHECK_MS);
    return () => clearInterval(timer);
  }, [remote, check]);

  if (!remote) return <>{children}</>;
  if (!session) {
    return <main className="remote-pair"><p className="remote-pair-status" role="status">{error ? `Can’t reach Waystation: ${error}` : 'Connecting to Waystation…'}</p></main>;
  }
  if (!session.paired) return <PairingScreen onPaired={setSession} />;
  const forget = async () => {
    try {
      setSession(await api.remoteForget());
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return <>{children}<RemoteBadge session={session} onForget={() => void forget()} /></>;
}
