export type Vendor = 'claude' | 'codex';

export interface ModelOption {
  readonly id: string;
  readonly label: string;
}

/** Suggestions only: the model field also accepts any other name the vendor's CLI knows. */
export const MODEL_SUGGESTIONS: Readonly<Record<Vendor, readonly ModelOption[]>> = {
  claude: [
    { id: 'claude-opus-5-5', label: 'Opus 5.5' },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
    { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  ],
  codex: [
    { id: 'gpt-6.1-sol', label: 'gpt-6.1-sol' },
    { id: 'gpt-6-sol', label: 'gpt-6-sol' },
    { id: 'gpt-6-astra', label: 'gpt-6-astra' },
    { id: 'gpt-6-luna', label: 'gpt-6-luna' },
    { id: 'gpt-5.6-sol', label: 'gpt-5.6-sol' },
    { id: 'gpt-5.5', label: 'gpt-5.5' },
  ],
};

export const DEFAULT_MODEL_LABEL: Readonly<Record<Vendor, string>> = {
  claude: 'Default (Claude Code setting)',
  codex: 'Default (Codex config)',
};

/** Mirrors the daemon's check: model names reach a command line. */
export const MODEL_NAME_PATTERN = '[A-Za-z0-9][A-Za-z0-9._:\\[\\]\\-]{0,63}';

export const modelListId = (vendor: Vendor): string => `models-${vendor}`;
