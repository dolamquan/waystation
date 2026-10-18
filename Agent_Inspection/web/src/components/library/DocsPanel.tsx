import { AnimatePresence } from 'framer-motion';
import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { docsApi, formatBytes, MAX_DOC_BYTES, readDocFile, type ContextDoc, type ContextDocDetail } from '../../library/docsApi.ts';
import '../../library/docs.css';
import { Icon } from '../Icon.tsx';
import { Confirm } from '../Modal.tsx';
import { PanelEmpty } from '../SectionTabs.tsx';
import type { LibraryPanelProps } from './LibraryView.tsx';

/** Which doc is open below the list: an existing one (view or edit) or a new blank one. */
type Open =
  | { readonly kind: 'existing'; readonly id: string; readonly editing: boolean }
  | { readonly kind: 'new' };

const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** Context docs: markdown an agent must read before it starts its task. */
export function DocsPanel({ notify }: LibraryPanelProps) {
  const [docs, setDocs] = useState<readonly ContextDoc[]>([]);
  const [loadError, setLoadError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Open>();
  const [deleting, setDeleting] = useState<ContextDoc>();

  const load = useCallback(async () => {
    try {
      setDocs((await docsApi.list()).docs);
      setLoadError(undefined);
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const upload = async (files: readonly File[]) => {
    let added = 0;
    for (const file of files) {
      try {
        await docsApi.create(await readDocFile(file));
        added += 1;
      } catch (err) {
        notify((err as Error).message, 'error');
      }
    }
    if (added) notify(added === 1 ? 'Doc added' : `${added} docs added`);
    await load();
  };

  const remove = async (doc: ContextDoc) => {
    try {
      await docsApi.remove(doc.id);
      notify(`Deleted ${doc.title}`);
      if (open?.kind === 'existing' && open.id === doc.id) setOpen(undefined);
      await load();
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  };

  const onSaved = (doc: ContextDocDetail) => {
    setOpen({ kind: 'existing', id: doc.id, editing: false });
    void load();
  };

  return (
    <section className="ops-section docs-panel" aria-labelledby="docs-heading">
      <div className="section-heading">
        <div>
          <h2 id="docs-heading">Context docs</h2>
          <p>Project briefs, conventions and notes for your agent to read first.</p>
        </div>
        <button className="btn btn-go" onClick={() => setOpen({ kind: 'new' })}><Icon name="plus" size={15} />New doc</button>
      </div>

      <DropZone onFiles={(files) => void upload(files)} />

      {loadError && <div className="detail-load-error" role="alert"><p>Couldn’t load docs. {loadError}</p><button className="btn" onClick={() => void load()}>Try again</button></div>}
      {loading && <p className="workspace-loading" role="status">Loading documents…</p>}
      {!loading && !loadError && docs.length === 0 && !open && <PanelEmpty icon="book" title="A spot for your project notes"><p>Drop in a Markdown file, or write a note for your agent to read.</p><button className="btn" onClick={() => setOpen({ kind: 'new' })}>Write a doc</button></PanelEmpty>}
      {docs.length > 0 && <div className="resource-toolbar"><label className="resource-search"><Icon name="search" size={16} /><input type="search" aria-label="Search context docs" placeholder="Search documents…" value={query} onChange={(e) => setQuery(e.target.value)} /></label><span className="resource-count">{docs.length} documents</span></div>}
      {query && !docs.some((doc) => `${doc.title} ${doc.filename ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())) && <PanelEmpty icon="search" title="No matching documents"><p>Try another title or filename.</p><button className="btn" onClick={() => setQuery('')}>Clear search</button></PanelEmpty>}

      <ul className="ops-list" aria-label="Context docs">
        {docs.filter((doc) => `${doc.title} ${doc.filename ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())).map((doc) => (
          <li key={doc.id} className={`ops-row${open?.kind === 'existing' && open.id === doc.id ? ' docs-row-open' : ''}`}>
            <span className="docs-row-icon" aria-hidden="true"><Icon name="book" size={16} /></span>
            <div className="ops-row-main">
              <strong>{doc.title}</strong>
              <small>{[doc.filename, formatBytes(doc.bytes), `updated ${new Date(doc.updatedAt).toLocaleString()}`].filter(Boolean).join(' · ')}</small>
            </div>
            <div className="ops-row-actions">
              <button className="btn btn-small" onClick={() => setOpen({ kind: 'existing', id: doc.id, editing: false })}>View</button>
              <button className="btn btn-small" onClick={() => setOpen({ kind: 'existing', id: doc.id, editing: true })}>Edit</button>
              <button className="icon-btn" aria-label={`Delete ${doc.title}`} onClick={() => setDeleting(doc)}><Icon name="trash" size={16} /></button>
            </div>
          </li>
        ))}
      </ul>

      {open?.kind === 'new' && <DocEditor key="new" notify={notify} onSaved={onSaved} onClose={() => setOpen(undefined)} />}
      {open?.kind === 'existing' && (
        <OpenDoc
          key={open.id}
          id={open.id}
          editing={open.editing}
          notify={notify}
          onEdit={(editing) => setOpen({ kind: 'existing', id: open.id, editing })}
          onSaved={onSaved}
          onClose={() => setOpen(undefined)}
        />
      )}

      <AnimatePresence>
        {deleting && (
          <Confirm
            title={`Delete ${deleting.title}?`}
            body="The doc is removed from the library. Agents that already read it are not affected; schedules that list it will fail to launch until it is removed from them."
            confirmLabel="Delete"
            danger
            onConfirm={() => void remove(deleting)}
            onClose={() => setDeleting(undefined)}
          />
        )}
      </AnimatePresence>
    </section>
  );
}

function DropZone({ onFiles }: { readonly onFiles: (files: readonly File[]) => void }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setOver(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length) onFiles(files);
  };

  return (
    <div
      className={`docs-drop${over ? ' docs-drop-over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <Icon name="folder" size={18} />
      <span>Drop .md files here, or</span>
      <button type="button" className="btn btn-small" onClick={() => input.current?.click()}>Choose files</button>
      <small>Up to 200 KB each</small>
      <input
        ref={input}
        type="file"
        accept=".md,.markdown,.txt,text/markdown,text/plain"
        multiple
        className="sr-only"
        aria-label="Upload markdown files"
        tabIndex={-1}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
    </div>
  );
}

interface OpenDocProps {
  readonly id: string;
  readonly editing: boolean;
  readonly notify: LibraryPanelProps['notify'];
  readonly onEdit: (editing: boolean) => void;
  readonly onSaved: (doc: ContextDocDetail) => void;
  readonly onClose: () => void;
}

function OpenDoc({ id, editing, notify, onEdit, onSaved, onClose }: OpenDocProps) {
  const [doc, setDoc] = useState<ContextDocDetail>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    docsApi.get(id)
      .then((result) => { if (live) setDoc(result.doc); })
      .catch((err: Error) => { if (live) setError(err.message); });
    return () => { live = false; };
  }, [id]);

  if (error) return <div className="detail-load-error" role="alert"><p>Couldn’t open this doc. {error}</p><button className="btn" onClick={onClose}>Close</button></div>;
  if (!doc) return <p className="detail-empty-text" aria-live="polite">Loading…</p>;
  if (editing) {
    return <DocEditor doc={doc} notify={notify} onSaved={(saved) => { setDoc(saved); onSaved(saved); }} onClose={() => onEdit(false)} />;
  }
  return (
    <article className="ops-form docs-open" aria-labelledby="docs-open-title">
      <header className="docs-open-head">
        <div>
          <h3 id="docs-open-title">{doc.title}</h3>
          <small>{[doc.filename, formatBytes(doc.bytes)].filter(Boolean).join(' · ')}</small>
        </div>
        <div className="ops-row-actions">
          <button className="btn btn-small" onClick={() => onEdit(true)}>Edit</button>
          <button className="icon-btn" aria-label="Close preview" onClick={onClose}><Icon name="close" size={14} /></button>
        </div>
      </header>
      <pre className="code-view docs-preview" tabIndex={0} aria-label={`Contents of ${doc.title}`}>{doc.content || '(empty)'}</pre>
    </article>
  );
}

interface DocEditorProps {
  readonly doc?: ContextDocDetail;
  readonly notify: LibraryPanelProps['notify'];
  readonly onSaved: (doc: ContextDocDetail) => void;
  readonly onClose: () => void;
}

function DocEditor({ doc, notify, onSaved, onClose }: DocEditorProps) {
  const [title, setTitle] = useState(doc?.title ?? '');
  const [content, setContent] = useState(doc?.content ?? '');
  const [busy, setBusy] = useState(false);
  const bytes = byteLength(content);
  const tooBig = bytes > MAX_DOC_BYTES;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (tooBig) { notify('The doc is larger than 200 KB.', 'error'); return; }
    setBusy(true);
    try {
      const input = { title: title.trim(), content };
      const result = doc ? await docsApi.update(doc.id, input) : await docsApi.create(input);
      notify(doc ? 'Doc saved' : 'Doc created');
      onSaved(result.doc);
    } catch (err) {
      notify((err as Error).message, 'error');
      setBusy(false);
    }
  };

  return (
    <form className="form ops-form docs-editor" onSubmit={(e) => void submit(e)} aria-label={doc ? `Edit ${doc.title}` : 'New doc'}>
      <label>Title<input className="text-input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} required placeholder="e.g. Coding conventions" /></label>
      <label>
        Content (markdown)
        <textarea className="code-input docs-textarea" value={content} onChange={(e) => setContent(e.target.value)} rows={18} spellCheck={false} placeholder="# Conventions&#10;&#10;- Run the tests before committing…" />
      </label>
      <small className={`docs-size${tooBig ? ' docs-size-over' : ''}`} aria-live="polite">{formatBytes(bytes)} of 200 KB</small>
      <footer className="modal-foot">
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn btn-go" disabled={busy || tooBig || !title.trim()}>{doc ? 'Save' : 'Create doc'}</button>
      </footer>
    </form>
  );
}
