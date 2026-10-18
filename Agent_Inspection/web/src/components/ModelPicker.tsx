import { useState } from 'react';
import { DEFAULT_MODEL_LABEL, MODEL_NAME_PATTERN, MODEL_SUGGESTIONS, type Vendor } from '../models.ts';

const CUSTOM = '__custom__';

interface ModelPickerProps {
  readonly vendor: Vendor;
  readonly value: string;
  readonly onChange: (model: string) => void;
  /** Label for the empty choice; defaults to the vendor's own default model. */
  readonly emptyLabel?: string;
}

/** Default, a known model, or "Custom…" to type any other name. Remount (key) on vendor change. */
export function ModelPicker({ vendor, value, onChange, emptyLabel }: ModelPickerProps) {
  const suggestions = MODEL_SUGGESTIONS[vendor];
  const [isCustom, setIsCustom] = useState(value !== '' && !suggestions.some((m) => m.id === value));

  const choose = (next: string) => {
    setIsCustom(next === CUSTOM);
    onChange(next === CUSTOM ? '' : next);
  };

  return (
    <>
      <select className="text-input" aria-label="Model" value={isCustom ? CUSTOM : value} onChange={(e) => choose(e.target.value)}>
        <option value="">{emptyLabel ?? DEFAULT_MODEL_LABEL[vendor]}</option>
        {suggestions.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        <option value={CUSTOM}>Custom…</option>
      </select>
      {isCustom && (
        <input
          className="text-input"
          aria-label="Custom model name"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          pattern={MODEL_NAME_PATTERN}
          title="Letters, digits, dots, dashes and colons"
          placeholder="Model name"
          autoFocus
          required
        />
      )}
    </>
  );
}
