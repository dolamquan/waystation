import { useState } from 'react';
import type { LocalTile } from './canvasTiles.ts';
import { canvasApi } from './canvasApi.ts';
import { MiniMarkdown } from './NotebookView.tsx';
import './noteTile.css';

export function NoteTile({ tile }: { readonly tile: LocalTile }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setSaving(true); setError('');
    try {
      await canvasApi.update(tile.id, { content: draft }, baseline); setEditing(false);
    } catch (cause) { setError((cause as Error).message); }
    finally { setSaving(false); }
  };
  const [baseline, setBaseline] = useState('');
  return <section className="canvas-note" aria-label="Canvas note">
    <div className="canvas-note-toolbar">
      {editing ? <><button className="btn" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save note'}</button>
        <button className="btn btn-ghost" disabled={saving} onClick={() => setEditing(false)}>Cancel</button></>
        : <button className="btn btn-ghost" onClick={() => { setDraft(tile.content ?? ''); setBaseline(tile.content ?? ''); setEditing(true); }}>Edit note</button>}
    </div>
    {error && <p role="alert">{error}</p>}
    {editing ? <textarea className="text-input canvas-note-editor" aria-label="Note Markdown" maxLength={100_000} value={draft} onChange={event => setDraft(event.target.value)} />
      : <MiniMarkdown text={tile.content ?? ''} />}
  </section>;
}
