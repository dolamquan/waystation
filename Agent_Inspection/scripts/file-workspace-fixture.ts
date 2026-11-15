import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'waystation-file-browser-'));
process.env.AGENT_TOWER_HOME = join(root, 'tower'); process.env.CLAUDE_HOME = join(root, 'claude');
mkdirSync(process.env.AGENT_TOWER_HOME, { recursive: true });
const sources = [
  ['markdown', '# An executable notebook\nEdit a cell, run it, and keep exploring.'],
  ['code', 'value = 40\nprint("Variables are shared between cells")'],
  ['code', 'value + 2'],
  ['code', 'import matplotlib.pyplot as plt\nplt.plot([1,2,3], [2,4,3])\nplt.title("A live notebook result")\nplt.show()'],
  ['code', 'from IPython.display import HTML, display\ndisplay(HTML("<table><tr><th>Result</th></tr><tr><td>Live rich output</td></tr></table><script>parent.__notebookExecuted = true</script>"))'],
];
writeFileSync(join(root, 'analysis.ipynb'), JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: 'python3', language: 'python', display_name: 'Python 3' }, custom: { retained: true } }, cells: sources.map(([cell_type, source], index) => ({ id: `cell-${index}`, cell_type, metadata: {}, source, ...(cell_type === 'code' ? { execution_count: null, outputs: [] } : {}) })) }, null, 2));
writeFileSync(join(root, 'main.py'), 'print("Hello from the workspace")\n');
writeFileSync(join(root, 'settings.json'), '{"editable": true}\n');
// A real, small PDF with an accurate cross-reference table and built-in font.
const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
const stream = 'BT /F1 24 Tf 70 700 Td (A PDF inside your canvas) Tj 0 -40 Td /F1 12 Tf (The local worker, fonts and page renderer are working.) Tj ET';
objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
let pdf = '%PDF-1.4\n'; const offsets = [0];
objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
const xref = Buffer.byteLength(pdf); pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
writeFileSync(join(root, 'paper.pdf'), pdf); writeFileSync(join(root, 'broken.pdf'), '%PDF-1.4\nnot a real document');
const { Tower } = await import('../daemon/tower.ts'); const { startServer } = await import('../daemon/api/server.ts');
const tower = new Tower(':memory:');
const port = Number(process.env.FILE_WORKSPACE_TEST_PORT ?? 47359), token = '0123456789abcdef0123456789abcdef';
const server = await startServer({ tower, port, host: '127.0.0.1', token, webDist: resolve('web/dist') });
console.log(JSON.stringify({ ready: true, root, port }));
async function shutdown() { server.close(); await tower.shutdown(); process.exit(0); }
process.on('SIGINT', () => void shutdown()); process.on('SIGTERM', () => void shutdown()); process.on('message', () => void shutdown());
