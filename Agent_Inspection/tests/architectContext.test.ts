import { describe, expect, it } from 'vitest';
import { stripArchitectContext } from '../daemon/api/routes/architecture.ts';
import { visiblePrompt } from '../web/src/components/architecture/ArchitectTranscript.tsx';

describe('architect prompt context is hidden from the operator', () => {
  const id = 'a4ee1125-6b99-4cda-8bda-d9e177427038';
  const cases = [
    [`Current workflow: ${id}. Read its latest graph with get_architecture before responding. Hi`, 'Hi'],
    [`Current workflow: ${id}. Read its latest graph with get_architecture before responding.\n\nAdd a reviewer`, 'Add a reviewer'],
    [`Current workflow: ${id}. Read its latest graph with get_architecture before responding. Selected element id (design context): builder Make this agent faster`, 'Make this agent faster'],
    ['Plain message with no context', 'Plain message with no context'],
  ] as const;
  for (const [raw, shown] of cases) it(`shows only what was typed: "${shown}"`, () => {
    expect(stripArchitectContext(raw)).toBe(shown);
    expect(visiblePrompt(raw)).toBe(shown);
  });
});
