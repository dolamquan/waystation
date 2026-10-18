/** Model names reach a command line (`codex -m`), so they may not start with "-" or contain spaces. */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/;

export function isValidModelName(model: string): boolean {
  return MODEL_PATTERN.test(model);
}
