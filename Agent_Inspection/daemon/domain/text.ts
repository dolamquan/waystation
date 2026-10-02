export function projectName(cwd: string | undefined): string {
  if (!cwd) return 'unknown project';
  const parts = cwd.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || cwd;
}

export function clip(text: string, max = 280): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[abpr]-[A-Za-z0-9-]{10,}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi,
  /((?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi,
];

/** Best-effort secret scrubbing before anything is stored or broadcast. */
export function redact(text: string): string {
  return SECRET_PATTERNS.reduce(
    (acc, pattern) =>
      acc.replace(pattern, (_match: string, prefix?: unknown) =>
        typeof prefix === 'string' && prefix.length > 0 ? `${prefix}[REDACTED]` : '[REDACTED]'),
    text,
  );
}

export function summarize(text: string, max = 280): string {
  return clip(redact(text), max);
}

const INTERESTING_INPUT_KEYS = ['command', 'cmd', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt', 'skill'];

export function describeToolInput(toolName: string, input: unknown): string {
  if (typeof input === 'string') return `${toolName}: ${summarize(input, 200)}`;
  if (!input || typeof input !== 'object') return toolName;
  const record = input as Record<string, unknown>;
  const key = INTERESTING_INPUT_KEYS.find((candidate) => typeof record[candidate] === 'string');
  return key ? `${toolName}: ${summarize(String(record[key]), 200)}` : toolName;
}
