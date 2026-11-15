import { describe, expect, it } from 'vitest';
import type { Agent, ConsoleInfo } from '../web/src/api.ts';
import { buildBoardItems, type BoardItem } from '../web/src/components/consoles/boardItems.ts';
import { UNASSIGNED_KEY, groupByFolder, pickFolder } from '../web/src/components/consoles/boardFolders.ts';

const NOW = 1_000_000;
const con = (id: string, cwd: string, extra: Partial<ConsoleInfo> = {}): ConsoleInfo =>
  ({ id, name: `c${id}`, kind: 'shell', cwd, state: 'running', createdAt: Number(id.replace(/\D/g, '')) || 1, lastOutputAt: 0, ...extra });
const agent = (id: string, cwd: string | undefined, extra: Partial<Agent> = {}): Agent =>
  ({ id, vendor: 'claude', tier: 'C', name: id, project: 'p', cwd, status: 'idle', source: 's', hooked: false, intercepting: false, canInstruct: false, ...extra }) as Agent;
const items = (consoles: ConsoleInfo[], agents: Agent[] = []): readonly BoardItem[] => buildBoardItems(consoles, agents);

describe('groupByFolder', () => {
  it('returns no folders for no items', () => {
    expect(groupByFolder([], NOW)).toEqual([]);
  });

  it('groups equivalent Windows paths regardless of case, slashes and trailing slash', () => {
    const folders = groupByFolder(items([con('1', 'C:\\Work\\App\\'), con('2', 'c:/work/app'), con('3', 'C:/Work/./App/x/..')]), NOW);
    expect(folders).toHaveLength(1);
    expect(folders[0]!.items).toHaveLength(3);
    expect(folders[0]!.path).toBe('C:/Work/App');
    expect(folders[0]!.name).toBe('App');
  });

  it('keeps case-sensitive POSIX folders apart', () => {
    expect(groupByFolder(items([con('1', '/work/App'), con('2', '/work/app')]), NOW)).toHaveLength(2);
  });

  it('disambiguates folders that share a name with the shortest parent suffix', () => {
    const folders = groupByFolder(items([con('1', 'C:/one/app'), con('2', 'C:/two/app'), con('3', 'C:/one/other')]), NOW);
    expect(folders.map((folder) => folder.name)).toEqual(['one/app', 'other', 'two/app']);
  });

  it('puts sessions without a folder into Unassigned, always last', () => {
    const folders = groupByFolder(items([con('1', ''), con('2', 'C:/zzz')], [agent('a', undefined), agent('b', '  ')]), NOW);
    expect(folders.map((folder) => folder.name)).toEqual(['zzz', 'Unassigned']);
    expect(folders[1]).toMatchObject({ key: UNASSIGNED_KEY, path: undefined });
    expect(folders[1]!.items).toHaveLength(3);
  });

  it('counts needs-you and running sessions', () => {
    const folders = groupByFolder(items([
      con('1', 'C:/a', { attention: 'needs-you' }),
      con('2', 'C:/a', { state: 'exited' }),
      con('3', 'C:/a'),
    ], [agent('w', 'C:/a', { status: 'waiting' })]), NOW);
    expect(folders[0]).toMatchObject({ needsYou: 2, running: 3 });
  });

  it('is stable: items keep their incoming order and equal names sort by key', () => {
    const folders = groupByFolder(items([con('1', 'C:/b/x'), con('2', 'C:/a/x'), con('3', 'C:/b/x')]), NOW);
    expect(folders.map((folder) => folder.items.map((item) => item.key))).toEqual([['console:2'], ['console:1', 'console:3']]);
  });
});

describe('pickFolder', () => {
  const folders = groupByFolder(items([
    con('1', 'C:/old', { lastOutputAt: 10 }),
    con('2', 'C:/new', { lastOutputAt: 500 }),
  ], [agent('x', undefined, { lastEventAt: 900 })]), NOW);

  it('returns undefined when there are no folders', () => {
    expect(pickFolder([], 'folder:c:/x')).toBeUndefined();
  });
  it('keeps the wanted key while it exists', () => {
    expect(pickFolder(folders, 'folder:c:/old')?.name).toBe('old');
  });
  it('falls back to the folder with the most recently active item', () => {
    expect(pickFolder(folders, 'folder:c:/gone')?.key).toBe(UNASSIGNED_KEY);
    expect(pickFolder(folders, undefined)?.key).toBe(UNASSIGNED_KEY);
  });
  it('falls back to the first folder when nothing has activity', () => {
    const quiet = groupByFolder(items([con('1', 'C:/b'), con('2', 'C:/a')]), NOW);
    expect(pickFolder(quiet, undefined)?.name).toBe('a');
  });
});
