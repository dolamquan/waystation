import { useId, useState } from 'react';
import { desktop } from '../desktop.ts';
import { Icon } from './Icon.tsx';
import '../desktop.css';

export function ProjectFolderInput({ value, onChange, label = 'Project folder (absolute path)' }: { readonly value: string; readonly onChange: (value: string) => void; readonly label?: string }) {
  const id = useId();
  const [error, setError] = useState<string>();
  const [choosing, setChoosing] = useState(false);
  const bridge = desktop();
  const browse = async () => {
    if (!bridge) return;
    setChoosing(true); setError(undefined);
    try { const folder = await bridge.choosePath('project'); if (folder) onChange(folder); }
    catch (err) { setError((err as Error).message); }
    finally { setChoosing(false); }
  };
  return <div className="form-field">
    <label htmlFor={id}>{label}</label>
    <div className="desktop-path-field"><input id={id} className="text-input" value={value} onChange={(event) => onChange(event.target.value)} placeholder="C:\Users\you\project" required />{bridge && <button className="btn" type="button" disabled={choosing} onClick={() => void browse()}><Icon name="folder" size={16} />{choosing ? 'Choosing…' : 'Browse'}</button>}</div>
    {error && <small className="error-text" role="alert">{error}</small>}
  </div>;
}
