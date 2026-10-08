import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { api, type Agent } from '../api.ts';
import { readableTime } from '../activity.ts';
import type { AgentOutputs as Outputs, ChangedFile, CommitInfo, FileDiff, OutputTurn, StatusEntry } from '../../../daemon/outputs/types.ts';
import { Icon } from './Icon.tsx';
import { MessageText } from './ActivityFeed.tsx';
import '../outputs.css';

interface AgentOutputsProps {
  readonly agent: Agent;
  readonly now: number;
}

/** New events arrive in bursts while an agent works; refetch once things settle. */
const AUTO_REFRESH_DELAY_MS = 2500;
const TURNS_PAGE = 8;

function statusWord(code: string): string {
  if (code === '??') return 'New';
  if (code.includes('U')) return 'Conflict';
  if (code.includes('D')) return 'Deleted';
  if (code.includes('R')) return 'Renamed';
  if (code.includes('A')) return 'Added';
  return 'Modified';
}

function splitPath(path: string): { dir: string; name: string } {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut >= 0 ? { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) } : { dir: '', name: path };
}

function PathLabel({ path }: { readonly path: string }) {
  const { dir, name } = splitPath(path);
  return <span className="outputs-path" title={path}>{dir && <span className="outputs-path-dir">{dir}</span>}<strong>{name}</strong></span>;
}

function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) return 'outputs-diff-meta';
  if (line.startsWith('@@')) return 'outputs-diff-hunk';
  if (line.startsWith('+')) return 'outputs-diff-add';
  if (line.startsWith('-')) return 'outputs-diff-del';
  return '';
}

function FileDiffView({ agentId, path, refreshKey }: { readonly agentId: string; readonly path: string; readonly refreshKey: number }) {
  const [diff, setDiff] = useState<FileDiff>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let ignore = false;
    setError(undefined);
    api.outputDiff(agentId, path).then(
      (result) => { if (!ignore) setDiff(result.diff); },
      (failure: Error) => { if (!ignore) setError(failure.message); },
    );
    return () => { ignore = true; };
  }, [agentId, path, refreshKey]);

  if (error) return <p className="outputs-diff-note outputs-error" role="alert">Couldn’t load this file. {error}</p>;
  if (!diff) return <p className="outputs-diff-note">Loading…</p>;
  const lines = diff.kind === 'diff' ? diff.text.split('\n') : undefined;
  return (
    <div className="outputs-diff">
      {diff.note && <p className="outputs-diff-note">{diff.note}</p>}
      {lines && <pre aria-label={`Changes to ${path}`}>{lines.map((line, i) => <span key={i} className={diffLineClass(line)}>{line}{'\n'}</span>)}</pre>}
      {!lines && diff.text && <pre aria-label={`Contents of ${path}`}>{diff.text}</pre>}
      {diff.truncated && <p className="outputs-diff-note">Cut short: the full {lines ? 'diff' : 'file'} is too large to show here.</p>}
    </div>
  );
}

function TurnCard({ turn, now, stopped }: { readonly turn: OutputTurn; readonly now: number; readonly stopped: boolean }) {
  const state = turn.complete ? 'Finished' : stopped ? 'Ended' : 'In progress';
  return (
    <li className={`outputs-turn ${turn.complete ? '' : 'outputs-turn-open'}`}>
      <div className="outputs-turn-head">
        <span className={`outputs-badge ${turn.complete ? 'outputs-badge-done' : 'outputs-badge-open'}`}>{state}</span>
        <time dateTime={new Date(turn.resultAt ?? turn.startedAt).toISOString()}>{readableTime(turn.endedAt ?? turn.resultAt ?? turn.startedAt, now)}</time>
      </div>
      <p className="outputs-turn-prompt"><span>You asked</span>{turn.prompt ?? <em>Started before Waystation was watching</em>}</p>
      <div className="outputs-turn-result">
        <span>{turn.complete ? 'Result' : 'Latest message'}</span>
        <p>{turn.result ? <MessageText text={turn.result} /> : <em>No message recorded for this turn.</em>}</p>
      </div>
      {(turn.toolCalls > 0 || turn.files.length > 0) && <p className="outputs-turn-meta">
        {turn.toolCalls} tool {turn.toolCalls === 1 ? 'call' : 'calls'}{turn.files.length > 0 && <> · {turn.files.length} {turn.files.length === 1 ? 'file' : 'files'} changed</>}
      </p>}
      {turn.files.length > 0 && <ul className="outputs-chips">{turn.files.slice(0, 12).map((file) => <li key={file} title={file}>{splitPath(file).name}</li>)}{turn.files.length > 12 && <li>+{turn.files.length - 12} more</li>}</ul>}
      {turn.errors.length > 0 && <ul className="outputs-turn-errors">{turn.errors.map((error, i) => <li key={i}><Icon name="alert" size={13} />{error}</li>)}</ul>}
    </li>
  );
}

interface FileRowProps {
  readonly file: ChangedFile;
  readonly now: number;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly children?: ReactNode;
}

function FileRow({ file, now, open, onToggle, children }: FileRowProps) {
  const touched = `${file.touches === 1 ? 'Changed once' : `Changed ${file.touches} times`} · ${readableTime(file.lastTouchedAt, now)}`;
  if (!file.insideCwd) {
    return <li className="outputs-file outputs-file-outside"><div className="outputs-file-row"><PathLabel path={file.path} /><small>{touched} · outside this folder</small></div></li>;
  }
  return (
    <li className="outputs-file">
      <button className="outputs-file-row" aria-expanded={open} onClick={onToggle}>
        <PathLabel path={file.path} />
        <small>{touched}</small>
        <span className={`outputs-badge ${file.gitStatus ? '' : 'outputs-badge-quiet'}`}>{file.gitStatus ? statusWord(file.gitStatus) : 'No uncommitted changes'}</span>
        <Icon name="chevronDown" size={14} />
      </button>
      {open && children}
    </li>
  );
}

function StatusList({ entries, open, onToggle, render }: {
  readonly entries: readonly StatusEntry[];
  readonly open?: string;
  readonly onToggle: (path: string) => void;
  readonly render: (path: string) => ReactNode;
}) {
  return (
    <ul className="outputs-status">
      {entries.map((entry) => <li key={`${entry.code}${entry.path}`}>
        <button className="outputs-status-row" aria-expanded={open === entry.path} onClick={() => onToggle(entry.path)}>
          <span className="outputs-code" title={statusWord(entry.code)}>{entry.code.replace(/ /g, '·')}</span>
          <PathLabel path={entry.path} />
          {entry.from && <small>from {entry.from}</small>}
        </button>
        {open === entry.path && render(entry.path)}
      </li>)}
    </ul>
  );
}

function CommitList({ commits, now }: { readonly commits: readonly CommitInfo[]; readonly now: number }) {
  return (
    <ul className="outputs-commits">
      {commits.map((commit) => <li key={commit.hash}>
        <code title={commit.hash}>{commit.shortHash}</code>
        <span className="outputs-commit-subject">{commit.subject}</span>
        <small>{commit.author} · {readableTime(commit.ts, now)}</small>
      </li>)}
    </ul>
  );
}

function useOutputs(agent: Agent) {
  const [data, setData] = useState<Outputs>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let ignore = false;
    setLoading(true);
    api.outputs(agent.id).then(
      (result) => { if (!ignore) { setData(result.outputs); setError(undefined); setLoading(false); } },
      (failure: Error) => { if (!ignore) { setError(failure.message); setLoading(false); } },
    );
    return () => { ignore = true; };
  }, [agent.id, refreshKey]);

  // Refetch when the agent records new activity (not on first render: the load above covers that).
  const seenEventAt = useRef(agent.lastEventAt);
  useEffect(() => {
    if (agent.lastEventAt === seenEventAt.current) return;
    seenEventAt.current = agent.lastEventAt;
    const timer = setTimeout(() => setRefreshKey((key) => key + 1), AUTO_REFRESH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [agent.lastEventAt]);

  return { data, loading, error, refreshKey, refresh: () => setRefreshKey((key) => key + 1) };
}

export function AgentOutputs({ agent, now }: AgentOutputsProps) {
  const uid = useId();
  const { data, loading, error, refreshKey, refresh } = useOutputs(agent);
  const [openFile, setOpenFile] = useState<string>();
  const [turnsShown, setTurnsShown] = useState(TURNS_PAGE);
  const toggle = (path: string) => setOpenFile((current) => (current === path ? undefined : path));
  const diffFor = (path: string) => <FileDiffView agentId={agent.id} path={path} refreshKey={refreshKey} />;

  if (!data) {
    return <section className="outputs">
      {error ? <div className="detail-load-error" role="alert"><p>Couldn’t load this agent’s outputs. {error}</p><button className="btn" onClick={refresh} disabled={loading}>Try again</button></div>
        : <p className="detail-empty-text">Loading outputs…</p>}
    </section>;
  }

  const git = data.git;
  const stopped = agent.status === 'stopped';
  return (
    <section className="outputs">
      <div className="detail-section-heading">
        <div><h3>Outputs</h3><p>What this agent produced and got done.</p></div>
        <button className="icon-btn" aria-label="Refresh outputs" title="Refresh outputs" onClick={refresh} disabled={loading}><Icon name="refresh" size={16} /></button>
      </div>
      {error && <p className="outputs-error" role="alert">Couldn’t refresh: {error}</p>}

      <section className="outputs-section" aria-labelledby={`${uid}-results`}>
        <h4 id={`${uid}-results`}>Results</h4>
        {data.turns.length === 0 ? <p className="detail-empty-text">No results yet. The agent’s final message for each turn will appear here.</p> : <>
          <ol className="outputs-turns">{data.turns.slice(0, turnsShown).map((turn) => <TurnCard key={turn.id} turn={turn} now={now} stopped={stopped} />)}</ol>
          {data.turns.length > turnsShown && <button className="btn btn-small" onClick={() => setTurnsShown((shown) => shown + TURNS_PAGE)}>Show older turns</button>}
          <p className="outputs-hint">Prompts are recorded in short form; replies keep up to 4,000 characters{data.eventsCapped ? '. Only the most recent part of a long session is included' : ''}.</p>
        </>}
      </section>

      <section className="outputs-section" aria-labelledby={`${uid}-files`}>
        <h4 id={`${uid}-files`}>Files changed by this agent</h4>
        {data.files.length === 0 ? <p className="detail-empty-text">No files changed yet.</p>
          : <ul className="outputs-files">{data.files.map((file) => <FileRow key={file.path} file={file} now={now} open={openFile === `f:${file.path}`} onToggle={() => toggle(`f:${file.path}`)}>{diffFor(file.path)}</FileRow>)}</ul>}
        {data.files.length > 0 && <p className="outputs-hint">From the agent’s recorded edit tool calls. Select a file to see its current changes.</p>}
      </section>

      <section className="outputs-section" aria-labelledby={`${uid}-folder`}>
        <h4 id={`${uid}-folder`}>Folder status{git.available && git.branch ? <span className="outputs-branch">{git.branch}</span> : null}</h4>
        <p className="outputs-scope"><Icon name="info" size={14} />Covers the whole folder{data.cwd ? <> <code>{data.cwd}</code></> : ''}, so it includes changes made by other agents or by you.</p>
        {!git.available ? <p className="detail-empty-text">{git.reason}</p>
          : git.status.length === 0 ? <p className="detail-empty-text">No uncommitted changes in this folder.</p>
            : <>
              <StatusList entries={git.status} open={openFile?.startsWith('s:') ? openFile.slice(2) : undefined} onToggle={(path) => toggle(`s:${path}`)} render={diffFor} />
              {git.statusTruncated && <p className="outputs-hint">Only the first {git.status.length} changes are listed.</p>}
              {git.diffStat && <details className="outputs-stat"><summary>Change summary (git diff --stat)<Icon name="chevronDown" size={13} /></summary><pre>{git.diffStat}</pre></details>}
            </>}
      </section>

      {git.available && <section className="outputs-section" aria-labelledby={`${uid}-commits`}>
        <h4 id={`${uid}-commits`}>Commits during this session</h4>
        <p className="outputs-scope"><Icon name="info" size={14} />Commits in this repository since {git.commitsSince ? readableTime(git.commitsSince, now).toLowerCase() : 'the session started'}, by anyone.</p>
        {git.commits.length === 0 ? <p className="detail-empty-text">No commits since this agent started.</p> : <CommitList commits={git.commits} now={now} />}
      </section>}
    </section>
  );
}
