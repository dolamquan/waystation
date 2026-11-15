import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { api, type Agent, type FileContention } from '../api.ts';
import { timeAgo } from '../format.ts';
import { Confirm } from './Modal.tsx';
import { Icon } from './Icon.tsx';

type Notify = (text: string, kind?: 'ok' | 'error') => void;

interface ContentionPanelProps {
  readonly contention: readonly FileContention[];
  readonly agents: readonly Agent[];
  readonly now: number;
  readonly notify: Notify;
  readonly onSelect: (agentId: string) => void;
  /** Path the keyboard triage moved to. */
  readonly focusedPath?: string;
}

/** The last few folders of a path, so long Windows paths stay readable. */
function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : parts.join('/');
}

/** Files that agents in the same checkout both wrote in the last few minutes, and what to do about it. */
export function ContentionPanel({ contention, agents, now, notify, onSelect, focusedPath }: ContentionPanelProps) {
  const [busy, setBusy] = useState<string>();
  const [moving, setMoving] = useState<Agent>();
  const byId = new Map(agents.map((agent) => [agent.id, agent]));

  const tell = async (path: string) => {
    setBusy(path);
    try {
      const result = await api.notifyContention(path);
      const sent = result.sent.length ? `Told ${result.sent.join(' and ')}.` : 'No one could be told.';
      notify(result.skipped.length ? `${sent} Could not reach ${result.skipped.join(', ')}.` : sent, result.sent.length ? 'ok' : 'error');
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setBusy(undefined);
    }
  };

  const move = async (agent: Agent) => {
    setBusy(agent.id);
    try {
      const result = await api.moveToWorktree(agent.id);
      notify(result.warning ?? `${agent.name}'s task continues on ${result.worktree.branch ?? 'a new branch'}.`, result.warning ? 'error' : 'ok');
      onSelect(result.agent.id);
    } catch (error) {
      notify((error as Error).message, 'error');
    } finally {
      setBusy(undefined);
    }
  };

  const title = contention.length === 1 ? 'Two agents are editing the same file' : `${contention.length} files are being edited by more than one agent`;
  return (
    <>
      <AnimatePresence>
        {contention.length > 0 && (
          <motion.section className="contention" aria-label="Agents editing the same files" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
            <h2 className="contention-title"><Icon name="alert" size={16} />{title}</h2>
            <p className="contention-note">They share one checkout, so one can overwrite the other’s work.</p>
            <ul className="contention-list">
              {contention.map((entry) => (
                <ContentionRow
                  key={entry.path}
                  entry={entry}
                  agents={byId}
                  now={now}
                  busy={busy}
                  focused={entry.path === focusedPath}
                  onSelect={onSelect}
                  onTell={() => void tell(entry.path)}
                  onMove={setMoving}
                />
              ))}
            </ul>
          </motion.section>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {moving && (
          <Confirm
            title={`Move ${moving.name} to its own worktree?`}
            body={`Waystation creates a new branch and worktree from the last commit, starts a new agent there with a summary of ${moving.name}'s recent work, and stops ${moving.name}. Uncommitted edits stay in the shared checkout; the new agent is told to check what is missing.`}
            confirmLabel="Move to a worktree"
            onConfirm={() => void move(moving)}
            onClose={() => setMoving(undefined)}
          />
        )}
      </AnimatePresence>
    </>
  );
}

interface ContentionRowProps {
  readonly entry: FileContention;
  readonly agents: ReadonlyMap<string, Agent>;
  readonly now: number;
  readonly busy?: string;
  readonly focused: boolean;
  readonly onSelect: (agentId: string) => void;
  readonly onTell: () => void;
  readonly onMove: (agent: Agent) => void;
}

function ContentionRow({ entry, agents, now, busy, focused, onSelect, onTell, onMove }: ContentionRowProps) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (!focused || !ref.current) return;
    ref.current.focus({ preventScroll: true });
    ref.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focused]);
  const members = entry.agents.flatMap(({ agentId, lastAt }) => {
    const agent = agents.get(agentId);
    return agent ? [{ agent, lastAt }] : [];
  });
  return (
    <li ref={ref} tabIndex={-1} className={`contention-row ${focused ? 'contention-focused' : ''}`} data-triage={`file:${entry.path}`}>
      <div className="contention-file">
        <code title={entry.path}>{shortPath(entry.path)}</code>
        <small>since {timeAgo(entry.since, now)}</small>
      </div>
      <div className="contention-agents">
        {members.map(({ agent, lastAt }) => (
          <button key={agent.id} className="contention-agent" onClick={() => onSelect(agent.id)} title={`Open ${agent.name}`}>
            <strong>{agent.name}</strong><small>wrote {timeAgo(lastAt, now)}</small>
          </button>
        ))}
      </div>
      <div className="contention-actions">
        <button className="btn btn-small" disabled={busy === entry.path} onClick={onTell}>Tell them</button>
        {members.map(({ agent }) => (
          <button key={agent.id} className="btn btn-small btn-ghost" disabled={busy === agent.id} onClick={() => onMove(agent)}>
            Move {agent.name} to a worktree
          </button>
        ))}
      </div>
    </li>
  );
}
