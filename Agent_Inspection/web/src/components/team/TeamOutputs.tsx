import { useEffect, useId, useState, type ReactNode } from 'react';
import { api, type TeamMember, type TeamView } from '../../api.ts';
import type { TeamOutput } from '../../../../daemon/teams/types.ts';
import { delimitedPreview } from '../../../../shared/delimitedPreview.ts';
import { MessageText } from '../ActivityFeed.tsx';
import { Icon } from '../Icon.tsx';
import './team-outputs.css';

type Content = Awaited<ReturnType<typeof api.teamOutput>>;

function blobOf(content: Content): Blob {
  return new Blob([Uint8Array.from(atob(content.data), (char) => char.charCodeAt(0))], { type: content.mime });
}

/** Render text as React nodes; generated HTML and SVG never execute in the app. */
function Markdown({ text }: { readonly text: string }) {
  const blocks: ReactNode[] = [];
  let code: string[] | undefined;
  text.split('\n').forEach((line, index) => {
    if (line.startsWith('```')) {
      if (code) { blocks.push(<pre key={index}>{code.join('\n')}</pre>); code = undefined; }
      else code = [];
    } else if (code) code.push(line);
    else if (/^#{1,6} /.test(line)) blocks.push(<h4 key={index}><MessageText text={line.replace(/^#+ /, '')} /></h4>);
    else if (/^\s*[-*] /.test(line)) blocks.push(<ul key={index}><li><MessageText text={line.replace(/^\s*[-*] /, '')} /></li></ul>);
    else if (line.trim()) blocks.push(<p key={index}><MessageText text={line} /></p>);
  });
  if (code) blocks.push(<pre key="last">{code.join('\n')}</pre>);
  return <div className="team-output-markdown">{blocks}</div>;
}

function OutputPreview({ content, output }: { readonly content: Content; readonly output: TeamOutput }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const next = URL.createObjectURL(blobOf(content));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [content]);
  const text = content.kind === 'text' ? new TextDecoder().decode(Uint8Array.from(atob(content.data), (char) => char.charCodeAt(0))).slice(0, 200_000) : '';
  const rows = /\.(csv|tsv)$/i.test(output.filename) ? delimitedPreview(text, /\.tsv$/i.test(output.filename) ? '\t' : ',') : undefined;
  return <div className="team-output-preview">
    <div className="team-output-actions">
      {content.kind !== 'binary' && url && <a className="btn btn-small" href={url} target="_blank" rel="noopener noreferrer">Open in new tab<Icon name="expand" size={14} /></a>}
    </div>
    {content.kind === 'image' && <img src={`data:${content.mime};base64,${content.data}`} alt={output.description} />}
    {content.kind === 'text' && (rows ? <><div className="team-output-table" role="region" aria-label={`Table preview of ${output.filename}`} tabIndex={0}><table><thead><tr>{rows[0]?.map((cell, index) => <th key={index} scope="col">{cell}</th>)}</tr></thead><tbody>{rows.slice(1).map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody></table></div><p className="muted">Showing up to 100 rows and 30 columns. Download for the full table.</p></> : /\.(md|markdown)$/i.test(output.filename) ? <Markdown text={text} /> : <pre>{text}</pre>)}
    {content.kind === 'text' && output.bytes > 200_000 && <p className="muted">Preview limited to 200,000 characters. Download the file to read everything.</p>}
    {content.kind === 'binary' && <p>Preview isn’t available for this file type. Download it to open in your preferred app.</p>}
  </div>;
}

function OutputCard({ teamId, output, member, connected }: { readonly teamId: string; readonly output: TeamOutput; readonly member?: TeamMember; readonly connected: boolean }) {
  const panelId = useId();
  const [expanded, setExpanded] = useState(false);
  const [content, setContent] = useState<Content>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const load = async (download = false) => {
    if (busy || !connected) return;
    setError(undefined);
    setBusy(true);
    try {
      const result = content ?? await api.teamOutput(teamId, output.id);
      setContent(result);
      if (download) {
        const url = URL.createObjectURL(blobOf(result));
        const link = document.createElement('a');
        link.href = url; link.download = output.filename;
        document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else setExpanded(true);
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  const reveal = async () => {
    setError(undefined); setBusy(true);
    try { await api.revealTeamOutput(teamId, output.id); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  const type = output.filename.split('.').at(-1)?.toUpperCase() || 'FILE';
  return <li className="team-output-card">
    <div className="team-output-heading"><Icon name={/^(PNG|JPE?G|GIF|WEBP)$/.test(type) ? 'image' : 'book'} size={21} /><div><h3><button className="team-output-title" disabled={busy || !connected} aria-expanded={expanded} aria-controls={panelId} onClick={() => expanded ? setExpanded(false) : void load()}>{output.title}</button></h3><span>{type} · {output.bytes < 1024 ? `${output.bytes} B` : `${Math.ceil(output.bytes / 1024)} KB`} · {member?.name ?? output.memberId}</span></div></div>
    <p>{output.description}</p>
    <div className="team-output-actions">
      <button className="btn btn-small" disabled={busy || !connected} aria-expanded={expanded} aria-controls={panelId} onClick={() => expanded ? setExpanded(false) : void load()}>{busy ? 'Loading…' : expanded ? 'Close preview' : 'Preview'}</button>
      <button className="btn btn-small" disabled={busy || !connected} onClick={() => void load(true)}>Download</button>
      <button className="btn btn-small" disabled={busy || !connected} onClick={() => void reveal()}><Icon name="folder" size={14} />Open containing folder</button>
    </div>
    {error && <p className="team-output-error" role="alert">{error} Try again or download the file.</p>}
    <div id={panelId} hidden={!expanded}>{expanded && content && <OutputPreview content={content} output={output} />}</div>
  </li>;
}

export function TeamOutputs({ team, connected, onDiff }: { readonly team: TeamView; readonly connected: boolean; readonly onDiff: (member: TeamMember) => void }) {
  const outputs = team.outputs ?? [];
  return <section className="team-outputs" aria-label="Team outputs">
    <header><h3>{team.status === 'done' ? 'Team results' : 'Deliverables'}</h3><p>Preview, open or download the team’s work. Saved copies remain available after workspaces are cleaned up.</p></header>
    {team.summary && <div className="team-output-summary"><h3>Outcome</h3><Markdown text={team.summary} /></div>}
    {outputs.length ? <ul className="team-output-list">{[...outputs].reverse().map(output => <OutputCard key={output.id} teamId={team.id} output={output} member={team.members.find(member => member.id === output.memberId)} connected={connected} />)}</ul> : <div className="team-output-empty"><Icon name="book" size={24} /><h3>No files published yet</h3><p>Deliverables appear here when a member publishes them. Existing teams can publish files when you ask them to resume. You can review code changes below.</p></div>}
    <section className="team-output-branches" aria-label="Branch changes"><h3>Code changes</h3><p>Review each member’s changes before merging.</p>{team.members.map(member => <div key={member.id}><span><strong>{member.name}</strong><code>{member.branch}</code></span><button className="btn btn-small" disabled={!connected || team.status === 'disbanded'} onClick={() => onDiff(member)}>View diff<span className="sr-only"> for {member.name}</span></button></div>)}{team.status === 'disbanded' && <p>Member workspaces may have been removed. Kept branches remain in your repository.</p>}</section>
  </section>;
}
