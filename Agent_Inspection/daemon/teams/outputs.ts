import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { BoardError } from './board.ts';
import type { TeamMember, TeamOutput, TeamState } from './types.ts';

const MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const TEXT_TYPES = new Set(['.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.yaml', '.yml', '.html', '.css', '.js', '.ts', '.tsx', '.jsx', '.py', '.xml', '.svg', '.log', '.sql', '.sh']);

function inside(root: string, file: string): boolean {
  const rel = relative(root, file);
  return !!rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../');
}

function field(args: Record<string, unknown>, name: string, max: number): string {
  const value = typeof args[name] === 'string' ? args[name].trim() : '';
  if (!value || value.length > max) throw new BoardError(`${name} is required and must be at most ${max} characters.`);
  return value;
}

/** Preserve a bounded copy, so removing worktrees never removes registered deliverables. */
export function registerOutput(team: TeamState, member: TeamMember, args: Record<string, unknown>, teamsDir: string, now: number): TeamOutput {
  const title = field(args, 'title', 160);
  const description = field(args, 'description', 1000);
  const path = field(args, 'path', 2000);
  if ((team.outputs?.length ?? 0) >= 100) throw new BoardError('This team already has 100 outputs.');
  let fd: number | undefined;
  try {
    const root = realpathSync(member.worktree);
    const source = realpathSync(resolve(root, path));
    if (!inside(root, source)) throw new BoardError('Outputs must be files inside your own worktree.');
    fd = openSync(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new BoardError('Choose a regular file no larger than 20 MB.');
    const data = readFileSync(fd);
    if (data.length > MAX_BYTES) throw new BoardError('Choose a file no larger than 20 MB.');
    const id = randomUUID();
    const dir = join(teamsDir, '.outputs', team.id, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, basename(source)), data, { flag: 'wx' });
    return { id, title, description, memberId: member.id, filename: basename(source), path: relative(root, source), bytes: data.length, createdAt: now };
  } catch (error) {
    if (error instanceof BoardError) throw error;
    throw new BoardError('Could not save this output. Check that the file exists and is readable inside your worktree.');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function savedPath(team: TeamState, outputId: string, teamsDir: string): { output: TeamOutput; path: string } {
  const output = team.outputs?.find((item) => item.id === outputId);
  if (!output || !/^[a-f0-9-]{36}$/.test(output.id)) throw new BoardError('Output not found.');
  return { output, path: join(teamsDir, '.outputs', team.id, output.id, basename(output.filename)) };
}

export function readOutput(team: TeamState, outputId: string, teamsDir: string) {
  const { output, path } = savedPath(team, outputId, teamsDir);
  let data: Buffer;
  try { data = readFileSync(path); } catch { throw new BoardError('This saved output is unavailable. Ask the team to register it again.'); }
  const extension = extname(output.filename).toLowerCase();
  const kind = IMAGE_TYPES[extension] ? 'image' : TEXT_TYPES.has(extension) ? 'text' : 'binary';
  return { data: data.toString('base64'), mime: IMAGE_TYPES[extension] ?? (kind === 'text' ? 'text/plain;charset=utf-8' : 'application/octet-stream'), kind };
}

/** Open the preserved output folder, rather than depending on a worktree still existing. */
export async function revealOutput(team: TeamState, outputId: string, teamsDir: string): Promise<void> {
  const { path } = savedPath(team, outputId, teamsDir);
  try { realpathSync(path); } catch { throw new BoardError('This saved output is unavailable.'); }
  if (process.platform !== 'win32') throw new BoardError('Open containing folder is available in Waystation on Windows.');
  await new Promise<void>((resolveSpawn, reject) => {
    const child = spawn('explorer.exe', [join(teamsDir, '.outputs', team.id, outputId)], { windowsHide: true, detached: true, stdio: 'ignore' });
    child.once('error', () => reject(new BoardError('Could not open the output folder. Download the file instead.')));
    child.once('spawn', () => { child.unref(); resolveSpawn(); });
  });
}
