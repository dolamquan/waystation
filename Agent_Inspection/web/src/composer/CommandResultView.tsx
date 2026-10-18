import type { CommandResult } from '../../../shared/claudeCommands.ts';
import { Icon } from '../components/Icon.tsx';

interface CommandResultViewProps {
  readonly command: string;
  readonly result: CommandResult;
  readonly busy: boolean;
  readonly onAction: (command: string) => void;
  readonly onClose: () => void;
}

/** The answer to a Claude Code command (/usage, /mcp, /model…), with buttons that run follow-up commands. */
export function CommandResultView({ command, result, busy, onAction, onClose }: CommandResultViewProps) {
  return (
    <section className="composer-result" aria-label={`${result.title} (${command})`}>
      <header className="composer-result-head">
        <strong>{result.title}</strong><code>{command}</code>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close result"><Icon name="close" size={14} /></button>
      </header>
      {result.sections.map((section, s) => (
        <div key={s} className="composer-result-section">
          {section.heading && <h4>{section.heading}</h4>}
          <ul>
            {section.rows.map((row, i) => (
              <li key={i} className={row.tone ? `result-${row.tone}` : undefined}>
                <div className="result-line">
                  <span className="result-label">{row.label}</span>
                  {row.value && <span className="result-value">{row.value}</span>}
                </div>
                {row.meter !== undefined && (
                  <div className="result-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(row.meter)} aria-label={row.label}>
                    <span style={{ width: `${Math.min(100, Math.max(0, row.meter))}%` }} />
                  </div>
                )}
                {row.detail && <small className="result-detail">{row.detail}</small>}
                {row.actions && row.actions.length > 0 && (
                  <div className="result-actions">
                    {row.actions.map(action => (
                      <button key={action.command} type="button" className="btn btn-small" disabled={busy} onClick={() => onAction(action.command)} title={action.command}>{action.label}</button>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {result.note && <p className="composer-result-note">{result.note}</p>}
    </section>
  );
}
