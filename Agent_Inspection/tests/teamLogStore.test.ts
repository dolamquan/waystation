import { describe, expect, it } from 'vitest';
import { TowerStore } from '../daemon/store/db.ts';

describe('team log store', () => {
  it('keeps the recipient and message id of body-only entries across reloads', () => {
    const store = new TowerStore(':memory:');
    store.appendTeamLog({ teamId: 't', ts: 1, kind: 'message', actor: 'operator', summary: 'ship it', to: 'builder', messageId: 'm1' });
    store.appendTeamLog({ teamId: 't', ts: 2, kind: 'system', actor: 'tower', summary: 'started' });
    expect(store.teamLog('t')).toEqual([
      { teamId: 't', ts: 1, kind: 'message', actor: 'operator', summary: 'ship it', to: 'builder', messageId: 'm1' },
      { teamId: 't', ts: 2, kind: 'system', actor: 'tower', summary: 'started' },
    ]);
  });

  it('deletes a removed team together with its log', () => {
    const store = new TowerStore(':memory:');
    store.appendTeamLog({ teamId: 't', ts: 1, kind: 'system', actor: 'tower', summary: 'started' });
    store.deleteTeam('t');
    expect(store.teamLog('t')).toEqual([]);
  });
});
