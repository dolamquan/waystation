import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const base = process.env.CANVAS_VERIFY_URL ?? 'http://127.0.0.1:5186';
mkdirSync('.impeccable/review', { recursive: true });
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let socket;
  let liveAgents = [];
  const requests = [];
  const agent = { id: 'managed:canvas-builder', name: 'Canvas builder', vendor: 'claude', tier: 'A', status: 'idle', cwd: 'C:/Work/Ideas', project: 'Ideas', source: 'managed', canInstruct: true, startedAt: Date.now(), lastEventAt: Date.now() };
  await page.routeWebSocket('**/ws', ws => { socket = ws; ws.send(JSON.stringify({ type: 'snapshot', agents: liveAgents, pending: [], teams: [], hooks: { installed: true } })); });
  await page.route('**/api/**', route => {
    const request = route.request();
    if (request.method() === 'POST') requests.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
    return route.fulfill({ json: { ok: true, message: 'Sent.', consoles: [], saved: [], providers: [], sessions: [], prerequisites: [], events: [], messages: [], channels: [], updates: [], notifications: [], unread: 0 } });
  });
  await page.addInitScript(() => {
    localStorage.setItem('waystation-mode', 'consoles');
    localStorage.setItem('waystation-console-layout', 'canvas');
  });
  await page.goto(`${base}/#token=0123456789abcdef0123456789abcdef&autostart=1`);
  await page.getByRole('region', { name: 'Console board' }).waitFor();
  if (process.argv.includes('--baseline')) {
    await page.screenshot({ path: '.impeccable/review/canvas-before.png', fullPage: true });
  } else {
    await page.getByRole('toolbar', { name: 'Whiteboard tools' }).waitFor();
    await page.waitForFunction(() => document.querySelector('.planning-heading [role="status"]')?.textContent?.startsWith('Saved locally'));
    await page.locator('.standby').waitFor({ state: 'detached' });
    console.log('Checking empty canvas and editing…');
    await page.screenshot({ path: '.impeccable/review/canvas-empty-desktop.png', fullPage: true });
    if (!process.argv.includes('--capture-empty')) {
    const stage = page.getByRole('region', { name: /^Interactive canvas/ });
    await page.getByRole('button', { name: 'Start with a note' }).click();
    const noteText = page.getByRole('textbox', { name: 'Note text', exact: true });
    await noteText.fill('A space for people and agents to think together.');
    await page.getByRole('textbox', { name: 'Canvas name' }).fill('Our next idea');
    await page.getByRole('button', { name: 'mint color' }).click();
    assert.ok(await page.locator('.planning-note').evaluate(el => el.classList.contains('planning-color-mint')));
    // One gesture creates one undo step, independent of how many pointer events occur.
    const header = page.locator('.planning-note .planning-node-handle');
    const before = await page.locator('.planning-note').boundingBox();
    const handle = await header.boundingBox();
    await page.mouse.move(handle.x + 30, handle.y + 12); await page.mouse.down();
    await page.mouse.move(handle.x + 115, handle.y + 54, { steps: 5 }); await page.mouse.up();
    const moved = await page.locator('.planning-note').boundingBox();
    assert.ok(moved.x > before.x + 70 && moved.y > before.y + 30);
    await page.getByRole('button', { name: 'Undo canvas change' }).click();
    assert.ok(Math.abs((await page.locator('.planning-note').boundingBox()).x - before.x) < 2);
    await page.getByRole('button', { name: 'Redo canvas change' }).click();
    const resize = await page.getByRole('button', { name: 'Resize note', exact: true }).boundingBox();
    await page.mouse.move(resize.x + 5, resize.y + 5); await page.mouse.down(); await page.mouse.move(resize.x + 50, resize.y + 35); await page.mouse.up();
    assert.ok((await page.locator('.planning-note').boundingBox()).width > moved.width + 30);
    await page.getByRole('button', { name: 'Duplicate selected objects' }).click();
    assert.equal(await noteText.count(), 2);
    await page.getByRole('button', { name: 'Delete selected objects' }).click();
    assert.equal(await noteText.count(), 1);
    await page.getByRole('button', { name: 'Undo canvas change' }).click();
    assert.equal(await noteText.count(), 2);
    await page.getByRole('button', { name: 'Redo canvas change' }).click();
    const box = await stage.boundingBox();
    // A second note can be created and resized entirely from the keyboard.
    await stage.focus(); await page.keyboard.press('n'); await page.keyboard.press('Enter');
    assert.equal(await noteText.count(), 2);
    await page.getByRole('button', { name: 'Resize note', exact: true }).last().focus();
    const keyboardWidth = (await page.locator('.planning-note').last().boundingBox()).width;
    await page.keyboard.press('ArrowRight');
    assert.ok((await page.locator('.planning-note').last().boundingBox()).width > keyboardWidth);
    await page.getByRole('button', { name: 'Delete selected objects', exact: true }).click();
    assert.equal(await noteText.count(), 1);
    console.log('Checking text, shapes and drawing…');
    // Place text and a shape using the toolbar, then draw an arrow and a freehand stroke.
    await page.getByRole('button', { name: 'Text (T)', exact: true }).click();
    await page.mouse.click(box.x + 190, box.y + 160);
    await page.getByRole('textbox', { name: 'Canvas text', exact: true }).fill('From a thought to something real');
    await page.getByRole('button', { name: 'Shape (R)', exact: true }).click();
    await page.mouse.click(box.x + 680, box.y + 300);
    await page.getByRole('textbox', { name: 'Shape text', exact: true }).fill('Explore → build → review');
    await page.getByRole('button', { name: 'blue color' }).click();
    await page.getByRole('button', { name: 'Arrow (A)', exact: true }).click();
    await page.mouse.move(box.x + 540, box.y + 300); await page.mouse.down(); await page.mouse.move(box.x + 650, box.y + 340, { steps: 6 }); await page.mouse.up();
    assert.equal(await page.getByLabel('Canvas arrow', { exact: true }).count(), 1);
    await page.getByRole('button', { name: 'Pen (P)', exact: true }).click();
    await page.mouse.move(box.x + 200, box.y + 550); await page.mouse.down();
    await page.mouse.move(box.x + 250, box.y + 530, { steps: 6 }); await page.mouse.move(box.x + 290, box.y + 560, { steps: 6 }); await page.mouse.up();
    assert.equal(await page.getByLabel('Canvas drawing', { exact: true }).count(), 1);
    await page.getByRole('button', { name: 'Select (V)', exact: true }).click();
    // Upload a real raster, not an external URL; the file is embedded in exported boards.
    const png = Buffer.from(await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 420; canvas.height = 240;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#e7e0d5'; ctx.fillRect(0, 0, 420, 240);
      ctx.fillStyle = '#534a62'; ctx.font = '600 22px sans-serif'; ctx.fillText('Prototype reference', 24, 40);
      for (const [x, title, color] of [[24, 'An idea', '#c8a7d7'], [158, 'A plan', '#8abb9c'], [292, 'A first draft', '#c9ae77']]) {
        ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(x, 68, 108, 112, 8); ctx.fill();
        ctx.fillStyle = '#302939'; ctx.font = '14px sans-serif'; ctx.fillText(title, x + 10, 98);
        ctx.fillRect(x + 10, 116, 68, 3); ctx.fillRect(x + 10, 128, 50, 3);
      }
      ctx.fillStyle = '#534a62'; ctx.font = '12px sans-serif'; ctx.fillText('Illustrative reference for this example board', 24, 214);
      return canvas.toDataURL('image/png').split(',')[1];
    }), 'base64');
    await page.getByLabel('Upload canvas image', { exact: true }).setInputFiles({ name: 'Reference.png', mimeType: 'image/png', buffer: png });
    await page.getByRole('textbox', { name: 'Image description' }).fill('A reference for the visual direction');
    assert.equal(await page.locator('.planning-image img').evaluate(el => el.naturalWidth), 420);
    await page.getByRole('button', { name: 'Share board', exact: true }).click();
    console.log('Checking portable boards…');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export editable board', exact: true }).click()]);
    const exported = JSON.parse(readFileSync(await download.path(), 'utf8'));
    assert.equal(exported.title, 'Our next idea');
    assert.equal(exported.nodes.length, 6);
    assert.ok(!JSON.stringify(exported).includes('0123456789abcdef'));
    assert.ok(!JSON.stringify(exported).includes('managed:'));
    assert.ok(exported.nodes.find(node => node.kind === 'image').src.startsWith('data:image/png;base64,'));
    const [imageDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export as an image', exact: true }).click()]);
    assert.ok(imageDownload.suggestedFilename().endsWith('.png'));
    assert.ok(readFileSync(await imageDownload.path()).length > 1000);
    const imported = { version: 1, title: 'Collaborator feedback', nodes: [{ ...exported.nodes.find(node => node.kind === 'note'), text: 'Let’s test the idea with people first.', x: 120, y: 580 }] };
    await page.getByLabel('Import canvas file', { exact: true }).setInputFiles({ name: 'feedback.waystation.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported)) });
    await noteText.nth(1).waitFor();
    assert.equal(await noteText.count(), 2);
    await page.getByRole('button', { name: 'Undo canvas change' }).click();
    assert.equal(await noteText.count(), 1);
    // Invalid imports leave the current board intact and report an error.
    await page.getByLabel('Import canvas file', { exact: true }).setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"version":1,"nodes":[{"kind":"script"}]}') });
    assert.equal(await noteText.count(), 1);
    // Allow the debounced save, reload, and verify complete persistence including drawings and images.
    await page.waitForFunction(() => document.querySelector('.planning-heading [role="status"]')?.textContent?.startsWith('Saved locally'));
    await page.reload();
    await page.getByRole('button', { name: 'Enter Waystation', exact: true }).click();
    await stage.waitFor();
    console.log('Checking reload and agent handoff…');
    assert.equal(await noteText.inputValue(), 'A space for people and agents to think together.');
    assert.equal(await page.getByRole('textbox', { name: 'Canvas name' }).inputValue(), 'Our next idea');
    assert.equal(await page.getByLabel('Canvas drawing', { exact: true }).count(), 1);
    await page.getByRole('button', { name: 'Fit entire canvas', exact: true }).click();
    // An unavailable agent action has an explicit recovery path.
    await page.getByRole('button', { name: 'Ask an agent about this board', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Open agent console', exact: true }).waitFor();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    // Existing live agent sessions receive selected text and real base64 image attachments.
    liveAgents = [agent]; socket.send(JSON.stringify({ type: 'agents', agents: liveAgents, hooks: { installed: true } }));
    await page.locator('.canvas-tile').waitFor();
    await page.getByRole('button', { name: 'Ask an agent about this board', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: 'What should they do?' }).fill('Build a small prototype from this board.');
    await dialog.getByRole('button', { name: 'Send idea', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const delivery = requests.find(request => request.path.endsWith('/instruct'));
    assert.ok(delivery.body.text.includes('A space for people and agents'));
    assert.ok(delivery.body.text.includes('Build a small prototype'));
    assert.ok(delivery.body.images[0].data.startsWith('iVBORw0KGgo'));
    assert.ok(delivery.body.images[0].data.length > png.toString('base64').length);
    // Arrange the illustrative example, keeping the test reference and ideas beside the agent.
    await page.evaluate(() => {
      const key = 'waystation-planning-v1:all'; const doc = JSON.parse(localStorage.getItem(key));
      doc.title = 'Example · Our next idea';
      const positions = { text: [180, 80, 600, 100], note: [180, 220, 280, 220], shape: [510, 220, 270, 220], image: [180, 490, 360, 244], arrow: [465, 305, 40, 30], draw: [610, 550, 120, 40] };
      doc.nodes = doc.nodes.map(node => { const [x, y, width, height] = positions[node.kind]; return { ...node, x, y, width, height }; });
      localStorage.setItem(key, JSON.stringify(doc));
      const layout = JSON.parse(localStorage.getItem('waystation-console-canvas'));
      layout.rects['agent:managed:canvas-builder'] = { x: 850, y: 80, width: 450, height: 650 };
      localStorage.setItem('waystation-console-canvas', JSON.stringify(layout));
    });
    await page.reload(); await page.getByRole('button', { name: 'Enter Waystation', exact: true }).click(); await stage.waitFor();
    // Screenshots show an illustrative example only; the user's browser remains untouched.
    for (const [name, width] of [['desktop', 1440], ['mobile', 390]]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.getByRole('button', { name: 'Fit entire canvas', exact: true }).click();
      await page.screenshot({ path: `.impeccable/review/canvas-${name}.png`, fullPage: true });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} document overflow`);
      assert.ok(await page.getByRole('button', { name: 'Share board', exact: true }).isVisible());
    }
    await page.getByRole('button', { name: 'Full screen', exact: true }).click();
    await page.getByRole('button', { name: 'Fit entire canvas', exact: true }).click();
    await page.screenshot({ path: '.impeccable/review/canvas-mobile-fullscreen.png', fullPage: true });
    console.log('Checking cross-window conflict and unreadable-board recovery…');
    // Simulate a second window saving while this window still has unsaved edits.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await noteText.fill('My unsaved edits should survive.');
    await page.evaluate(() => {
      const key = 'waystation-planning-v1:all';
      const incoming = { version: 1, title: 'Other window', nodes: [] };
      const value = JSON.stringify(incoming); localStorage.setItem(key, value);
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: value, storageArea: localStorage }));
    });
    await page.getByText('Another window changed this board.', { exact: true }).waitFor();
    assert.equal(await noteText.inputValue(), 'My unsaved edits should survive.');
    await page.getByRole('button', { name: 'Keep my version', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.planning-heading [role="status"]')?.textContent?.startsWith('Saved locally'));
    assert.ok(await page.evaluate(() => localStorage.getItem('waystation-planning-v1:all').includes('My unsaved edits should survive')));
    // Corrupt data remains byte-for-byte intact until an explicit replacement choice.
    const broken = '{"version":1,"nodes":[not valid json';
    await page.evaluate(value => localStorage.setItem('waystation-planning-v1:all', value), broken);
    await page.reload(); await page.getByRole('button', { name: 'Enter Waystation', exact: true }).click();
    await page.getByText('This saved board could not be opened.', { exact: true }).waitFor();
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 450)));
    assert.equal(await page.evaluate(() => localStorage.getItem('waystation-planning-v1:all')), broken);
    const [recovery] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download saved data', exact: true }).click()]);
    assert.equal(readFileSync(await recovery.path(), 'utf8'), broken);
    await page.getByRole('button', { name: 'Start a new board', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await page.evaluate(() => localStorage.getItem('waystation-planning-v1:all')), broken);
    await page.getByRole('button', { name: 'Start a new board', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Replace board', exact: true }).click();
    await page.getByText('This saved board could not be opened.', { exact: true }).waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
    console.log('Canvas editing, move/resize, undo/redo, drawing, image upload, import/export, reload, agent context, and desktop/mobile layout verified.');
    }
  }
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: '.impeccable/review/canvas-test-failure.png', fullPage: true, timeout: 5000 }).catch(() => {});
  throw error;
} finally { await browser.close(); }
