import { useMemo } from 'react';
import { parseBlocks, parseInline, type Block } from './markdownBlocks.ts';
import { joinSource, NotebookError, parseNotebook, type NotebookOutput } from './notebook.ts';

/** Markdown as React elements (never HTML), for notebook text cells and markdown outputs. */
export function MiniMarkdown({ text }: { readonly text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return <div className="nb-markdown">{blocks.map((block, index) => <MarkdownBlock key={index} block={block} />)}</div>;
}

function Inline({ text }: { readonly text: string }) {
  return <>{parseInline(text).map((part, index) => {
    switch (part.kind) {
      case 'code': return <code key={index}>{part.text}</code>;
      case 'strong': return <strong key={index}>{part.text}</strong>;
      case 'em': return <em key={index}>{part.text}</em>;
      case 'link': return <a key={index} href={part.href} target="_blank" rel="noopener noreferrer">{part.text}</a>;
      default: return <span key={index}>{part.text}</span>;
    }
  })}</>;
}

function MarkdownBlock({ block }: { readonly block: Block }) {
  switch (block.kind) {
    case 'heading': {
      const Tag = (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const)[Math.min(block.level, 6) - 1]!;
      return <Tag><Inline text={block.text} /></Tag>;
    }
    case 'code': return <pre className="nb-pre"><code>{block.text}</code></pre>;
    case 'list': {
      const items = block.items.map((item, index) => <li key={index}><Inline text={item} /></li>);
      return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
    }
    case 'quote': return <blockquote><Inline text={block.text} /></blockquote>;
    case 'rule': return <hr />;
    default: return <p><Inline text={block.text} /></p>;
  }
}

function Output({ output }: { readonly output: NotebookOutput }) {
  switch (output.kind) {
    case 'image': return <img className="nb-image" src={`data:${output.mime};base64,${output.base64}`} alt="Cell output" />;
    case 'markdown': return <MiniMarkdown text={output.text} />;
    case 'error': return <pre className="nb-pre nb-error">{output.text}</pre>;
    default: return <pre className={`nb-pre nb-out-${output.tone}`}>{output.text}</pre>;
  }
}

/** Rich tables/HTML are isolated in a scriptless, originless iframe; saved notebook output is untrusted. */
export function NotebookOutputs({ outputs }: { outputs: readonly Record<string, any>[] }) {
  return <div className="nb-live-outputs">{outputs.map((output, index) => {
    const data = output.data;
    const html = data && !Object.keys(data).some((key) => key.startsWith('image/')) ? joinSource(data['text/html']) : '';
    if (html) return <iframe key={index} title={`Cell rich output ${index + 1}`} className="nb-html-output" sandbox="" referrerPolicy="no-referrer"
      srcDoc={`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:"><style>body{font:13px system-ui;color:#e6e8f2;background:#0d0f1a;margin:8px}table{border-collapse:collapse}td,th{padding:6px 10px;border:1px solid #343b55}a{color:#b9a7e8}</style>${html}`} />;
    const item = parseNotebook(JSON.stringify({ cells: [{ cell_type: 'code', source: '', outputs: [output] }] })).cells[0]?.outputs[0];
    return item ? <Output key={index} output={item} /> : null;
  })}</div>;
}

/** A Jupyter notebook, read-only: markdown cells rendered, code cells with their saved outputs. Nothing is run. */
export function NotebookView({ text }: { readonly text: string }) {
  const result = useMemo(() => {
    try { return { notebook: parseNotebook(text) }; } catch (error) {
      return { error: error instanceof NotebookError ? error.message : 'This notebook could not be read.' };
    }
  }, [text]);
  if ('error' in result) return <p className="tile-error file-message" role="alert">{result.error}</p>;
  const { notebook } = result;
  return <div className="nb-view">
    {notebook.cells.length === 0 && <p className="tile-note file-message">This notebook has no cells.</p>}
    {notebook.cells.map((cell, index) => <section key={index} className={`nb-cell nb-cell-${cell.kind}`}>
      {cell.kind === 'markdown' && <MiniMarkdown text={cell.source} />}
      {cell.kind === 'raw' && <pre className="nb-pre">{cell.source}</pre>}
      {cell.kind === 'code' && <>
        <div className="nb-in">
          <span className="nb-prompt">In [{cell.count ?? ' '}]:</span>
          <pre className="nb-pre nb-source" aria-label={`${notebook.language} code`}>{cell.source}</pre>
        </div>
        {cell.outputs.length > 0 && <div className="nb-outputs">{cell.outputs.map((output, at) => <Output key={at} output={output} />)}</div>}
      </>}
    </section>)}
    {notebook.hiddenCells > 0 && <p className="tile-note file-message">{notebook.hiddenCells} more cells are not shown.</p>}
  </div>;
}
