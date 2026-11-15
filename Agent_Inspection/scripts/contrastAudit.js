/*
 * Contrast audit: paste-able into a browser console, or run through Playwright (page.evaluate(source)).
 * Walks every visible text node under `root`, resolves the color behind it by blending ancestor backgrounds,
 * and returns the elements whose contrast falls under WCAG's 4.5:1 (3:1 for large or bold-large text).
 * Usage: contrastAudit(document.querySelector('.console-board'))
 */
// eslint-disable-next-line no-unused-vars
function contrastAudit(root = document.body) {
  const parse = (value) => {
    const m = value.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r, g, b, a };
  };
  const over = (top, under) => ({
    r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1,
  });
  const backgroundOf = (element) => {
    const layers = [];
    for (let node = element; node; node = node.parentElement) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) { layers.push(bg); if (bg.a >= 1) break; }
    }
    return layers.reverse().reduce((acc, layer) => over(layer, acc), { r: 255, g: 255, b: 255, a: 1 });
  };
  const luminance = ({ r, g, b }) => {
    const ch = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
  };
  const ratio = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

  const failures = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const element = text.parentElement;
    if (!element || seen.has(element) || !text.textContent.trim()) continue;
    seen.add(element);
    if (element.closest('.xterm, [inert], [aria-hidden="true"]')) continue;
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0 || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
    if (element.closest(':disabled, [aria-disabled="true"]')) continue; // WCAG exempts inactive controls.
    const fg = parse(style.color);
    if (!fg) continue;
    const bg = backgroundOf(element);
    const contrast = ratio(over(fg, bg), bg);
    const size = parseFloat(style.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
    if (contrast < (large ? 3 : 4.5)) {
      failures.push({ text: text.textContent.trim().slice(0, 40), selector: element.tagName.toLowerCase() + (element.className && typeof element.className === 'string' ? '.' + element.className.trim().split(/\s+/).join('.') : ''), contrast: Math.round(contrast * 100) / 100 });
    }
  }
  return failures;
}
