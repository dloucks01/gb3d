// Dev harness for the web engine: boot the ROM, skip the intro to the
// overworld, and render it with our WebGL engine (Phase 1) — the verified
// starting point for Phase 2 work. The overworld is the real target: unlike
// the intro/title screens it uses no mid-frame raster tricks, so every layer
// (BG ground plane + sprites + window) composites correctly.
//
// Usage (ROM is never committed — pass a path):
//   node engine/test/drive.mjs                     # assumes server on :8091
//   BASE=http://127.0.0.1:8091 TEST_ROM_PATH=/path/blue.gb node engine/test/drive.mjs
//   OUT=/some/dir  to choose where screenshots land
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:8091';
const ROM = process.env.TEST_ROM_PATH;
const OUT = process.env.OUT || '.';
if (!ROM) { console.error('set TEST_ROM_PATH to a US Blue .gb'); process.exit(1); }

let chromium; try { ({ chromium } = await import('playwright')); }
catch { ({ chromium } = await import('playwright-core')); }
const EXE = process.env.PW_EXECUTABLE ||
  (fs.existsSync('/opt/pw-browsers') && `/opt/pw-browsers/${fs.readdirSync('/opt/pw-browsers').find(d=>d.startsWith('chromium-'))}/chrome-linux/chrome`) || undefined;

const romB64 = fs.readFileSync(ROM).toString('base64');
const browser = await chromium.launch({ executablePath: EXE, headless: true,
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 480, height: 480 } });
page.on('pageerror', e => console.log('PAGEERR', e.message.slice(0, 200)));

await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__engineReady === true, { timeout: 30000 });
await page.evaluate(() => { window.__auto = false; });
await page.evaluate((b64) => window.__loadROMb64(b64), romB64);

// Skip the intro to the overworld entirely inside the page (synchronous core
// stepping, so this is fast). Both names become "AAAAAAA": each block mashes A
// to advance dialog / fill a name grid, then presses START to confirm it
// (START = END on the Gen1 naming screen). A final plain-A batch finishes Oak's
// last lines and drops the player into the bedroom.
await page.evaluate(() => {
  window.__stepFrames(1300);                                   // boot to title
  window.__press(7, 6, 10); window.__press(7, 6, 10); window.__press(4, 6, 10); // NEW GAME
  for (let blk = 0; blk < 16; blk++) {
    for (let i = 0; i < 30; i++) window.__press(4, 4, 6);      // advance / type
    window.__press(7, 5, 8); window.__press(7, 5, 8);         // confirm name
  }
  for (let i = 0; i < 100; i++) window.__press(4, 5, 12);      // finish -> bedroom
  window.__stepFrames(120);
  window.__renderOnce();
});
await page.waitForTimeout(200);
const shot = path.join(OUT, 'overworld_engine.png');
await page.screenshot({ path: shot });
const st = await page.evaluate(() => { const c = window.__core, rd = a => c.memory[a] & 0xff;
  return { LCDC: rd(0xff40).toString(16), map: rd(0xffb8) }; });
console.log('overworld render ->', shot, 'PPU', JSON.stringify(st));
await browser.close();
