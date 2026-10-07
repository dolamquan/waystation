import { describe, expect, it } from 'vitest';
import { OpsInputError, validateTemplate } from '../daemon/ops/templates.ts';

const base = { label: 'Reviewer', vendor: 'claude' } as const;

describe('validateTemplate loadout', () => {
  it('keeps a valid loadout', () => {
    // Arrange
    const raw = { ...base, loadout: { skillIds: ['ws:review'], docIds: ['doc_1'], pluginIds: ['ecc@ecc'], notifyChannelIds: ['inbox'] } };

    // Act
    const template = validateTemplate(raw, 1);

    // Assert
    expect(template.loadout).toEqual({ skillIds: ['ws:review'], docIds: ['doc_1'], pluginIds: ['ecc@ecc'], notifyChannelIds: ['inbox'] });
  });

  it('normalizes duplicates and drops empty lists', () => {
    // Arrange
    const raw = { ...base, loadout: { skillIds: ['a', 'a', 'b'], docIds: [], mcpIds: null } };

    // Act
    const template = validateTemplate(raw, 1);

    // Assert
    expect(template.loadout).toEqual({ skillIds: ['a', 'b'] });
  });

  it('stores no loadout when nothing is selected', () => {
    // Arrange
    const raw = { ...base, loadout: { skillIds: [], docIds: [] } };

    // Act
    const template = validateTemplate(raw, 1);

    // Assert
    expect(template.loadout).toBeUndefined();
  });

  it('rejects an invalid id with OpsInputError', () => {
    // Arrange
    const raw = { ...base, loadout: { docIds: ['../etc/passwd x'] } };

    // Act
    const act = () => validateTemplate(raw, 1);

    // Assert
    expect(act).toThrow(OpsInputError);
    expect(act).toThrow('loadout.docIds has an invalid id');
  });

  it('rejects a loadout that is not an object', () => {
    // Arrange
    const raw = { ...base, loadout: ['skill'] };

    // Act
    const act = () => validateTemplate(raw, 1);

    // Assert
    expect(act).toThrow(OpsInputError);
    expect(act).toThrow('loadout must be an object');
  });

  it('rejects a list that is not an array', () => {
    // Arrange
    const raw = { ...base, loadout: { mcpIds: 'playwright' } };

    // Act
    const act = () => validateTemplate(raw, 1);

    // Assert
    expect(act).toThrow(OpsInputError);
  });

  it('still accepts an old template without a loadout', () => {
    // Arrange
    const raw = { label: 'Old', vendor: 'codex', model: 'gpt-5', instructions: 'Be brief.' };

    // Act
    const template = validateTemplate(raw, 5);

    // Assert
    expect(template).toMatchObject({ label: 'Old', vendor: 'codex', model: 'gpt-5', instructions: 'Be brief.', intercept: false, createdAt: 5 });
    expect(template.loadout).toBeUndefined();
  });
});
