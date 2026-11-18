import { describe, expect, it } from 'vitest';
import { closeOffice, idleOfficeKeys, openOffice, parseClosedOffices, splitOffices } from '../web/src/stationOfficeTabs.ts';
import type { StationOffice } from '../web/src/stationOffices.ts';
import { makeAgent } from './helpers.ts';

const office = (key: string, agentCount = 0): StationOffice => ({
  key, name: key, path: `C:/${key}`, teams: [],
  agents: Array.from({ length: agentCount }, (_, i) => makeAgent({ id: `${key}-${i}` })),
});

describe('station office tabs', () => {
  it('splits offices into open and closed, keeping their order', () => {
    const offices = [office('a', 1), office('b'), office('c', 2)];
    const { open, closed } = splitOffices(offices, ['b']);
    expect(open.map(o => o.key)).toEqual(['a', 'c']);
    expect(closed.map(o => o.key)).toEqual(['b']);
  });

  it('closes and reopens without mutating the saved list or adding duplicates', () => {
    const saved = Object.freeze(['a']) as readonly string[];
    expect(closeOffice(saved, 'b')).toEqual(['a', 'b']);
    expect(closeOffice(saved, 'a')).toBe(saved);
    expect(openOffice(saved, 'a')).toEqual([]);
    expect(saved).toEqual(['a']);
  });

  it('lists only offices with no sessions as idle', () => {
    expect(idleOfficeKeys([office('a', 1), office('b'), office('c')])).toEqual(['b', 'c']);
  });

  it('reads saved keys defensively', () => {
    expect(parseClosedOffices(null)).toEqual([]);
    expect(parseClosedOffices('not json')).toEqual([]);
    expect(parseClosedOffices('{"a":1}')).toEqual([]);
    expect(parseClosedOffices('["folder:c:/x", 3, "", "folder:c:/x"]')).toEqual(['folder:c:/x']);
  });
});
