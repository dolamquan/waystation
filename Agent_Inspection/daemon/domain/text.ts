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

/** Like summarize, but keeps paragraphs and lists: for agent replies, which people read as results. */
export function summarizeBlock(text: string, max: number): string {
  const tidy = redact(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return tidy.length > max ? `${tidy.slice(0, max - 1)}…` : tidy;
}

const INTERESTING_INPUT_KEYS = ['command', 'cmd', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt', 'skill'];

/** Codex sends function-call arguments as a JSON string; read it as an object when it is one. */
function parseJsonObject(text: string): Record<string, unknown> | undefined {
  if (!text.trimStart().startsWith('{')) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

const SHELLS: ReadonlySet<string> = new Set(['bash', 'sh', 'zsh', 'dash', 'fish', 'pwsh', 'powershell', 'cmd']);

/** ["bash", "-lc", "git status"] → "git status"; other argv lists are joined. */
function commandText(command: unknown): string | undefined {
  if (!Array.isArray(command) || !command.every((part) => typeof part === 'string')) return undefined;
  const parts = command as string[];
  const shell = parts[0].split(/[\\/]/).pop()?.replace(/\.exe$/i, '').toLowerCase() ?? '';
  const shellScript = parts.length >= 3 && SHELLS.has(shell) && /^[-/]\w*c$/i.test(parts[parts.length - 2]);
  return shellScript ? parts[parts.length - 1] : parts.join(' ');
}

export function describeToolInput(toolName: string, input: unknown): string {
  if (typeof input === 'string') {
    const record = parseJsonObject(input);
    return record ? describeToolInput(toolName, record) : `${toolName}: ${summarize(input, 200)}`;
  }
  if (!input || typeof input !== 'object') return toolName;
  const record = input as Record<string, unknown>;
  const argv = commandText(record.command);
  if (argv) return `${toolName}: ${summarize(argv, 200)}`;
  const key = INTERESTING_INPUT_KEYS.find((candidate) => typeof record[candidate] === 'string');
  return key ? `${toolName}: ${summarize(String(record[key]), 200)}` : toolName;
}

const TITLE_MAX = 48;
const TITLE_MIN = 3;
const IDE_REQUEST_MARKER = /##\s*My request for Codex:\s*/i;
const INJECTED_PROMPT = /^(?:<|#\s*AGENTS\.md|#\s*Context from my IDE setup)/i;

/**
 * A short task name from a user's request ("fix the flaky test. It fails…" → "Fix the flaky test"),
 * so sessions are named for what they are doing rather than which folder they run in.
 * Returns undefined for injected context (environment blocks, AGENTS.md, IDE preambles).
 */
export function taskTitle(prompt: string, max = TITLE_MAX): string | undefined {
  const parts = prompt.split(IDE_REQUEST_MARKER);
  const request = (parts.length > 1 ? parts[parts.length - 1] : prompt).trim();
  if (!request || INJECTED_PROMPT.test(request)) return undefined;
  const firstLine = request.split(/\r?\n/).map((line) => line.replace(/^[#>*\-\s`]+/, '').trim()).find(Boolean);
  if (!firstLine) return undefined;
  const sentence = firstLine.split(/(?<=[.!?])\s/)[0].replace(/[.!?:;,]+$/, '');
  const clean = redact(sentence).replace(/\s+/g, ' ').trim();
  if (clean.length < TITLE_MIN) return undefined;
  const lastSpace = clean.lastIndexOf(' ', max - 1);
  const cut = lastSpace > max / 2 ? lastSpace : max - 1;
  const capped = clean.length > max ? `${clean.slice(0, cut).trimEnd()}…` : clean;
  return capped[0].toUpperCase() + capped.slice(1);
}
