// gb3d headless smoke test — gates deploys so regressions are caught in CI,
// not on someone's phone.
//
// Tier 1 (always): boots the built site, asserts the engine initializes to the
// ROM launcher with WebGL and no console/page errors, and that the ROM-import
// pipeline reacts to a dropped file.
//
// Tier 2 (when the TEST_ROM_B64 secret is set to a base64 1 MiB US R/B/Y ROM):
// imports it and asserts the game extracts and boots into play WITHOUT crashing
// — this is the tier that would have caught the bit/restart/audio regressions.
//
// Env:
//   BASE_URL       site to test (default http://127.0.0.1:8080)
//   PW_EXECUTABLE  chromium path (unset in CI -> Playwright's bundled build)
//   TEST_ROM_B64   optional base64 ROM for the full boot-into-game test
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let chromium;
try { ({ chromium } = await import('playwright')); }
catch { ({ chromium } = await import('playwright-core')); }

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080';
const EXE = process.env.PW_EXECUTABLE || undefined;
const fail = (m) => { console.error('SMOKE FAIL: ' + m); process.exit(1); };
const BENIGN = /made for version|may not be compatible|Queueable Sources can not be looped/i;

const browser = await chromium.launch({
  executablePath: EXE, headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--ignore-gpu-blocklist', '--no-sandbox', '--disable-background-networking'],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' && !BENIGN.test(m.text())) errors.push('console: ' + m.text()); });
page.on('pageerror', (e) => { if (!BENIGN.test(e.message)) errors.push('pageerror: ' + e.message); });

// ---- Tier 1: boot to the ROM launcher --------------------------------------
await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
try { await page.waitForFunction(() => window.Module && window.Module.calledRun === true, { timeout: 120000 }); }
catch { fail('engine never finished booting (Module.calledRun stayed false)'); }

const webgl = await page.evaluate(() => { try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; } });
if (!webgl) fail('no WebGL context');

await page.waitForTimeout(1500);
const launcher = await page.$eval('#romBtn', (el) => getComputedStyle(el).display !== 'none').catch(() => false);
if (!launcher) fail('ROM launcher ("Choose ROM") never appeared');
if (errors.length) fail('errors during boot:\n' + errors.join('\n'));

// ---- Tier 1: import pipeline reacts (synthetic 1 MiB file) ------------------
const synthetic = path.join(os.tmpdir(), 'gb3d_smoke_synth.gb');
fs.writeFileSync(synthetic, Buffer.alloc(1024 * 1024));   // correct size, wrong hash
await page.setInputFiles('#romInput', synthetic);
await page.waitForTimeout(2500);
const consumed = await page.evaluate(() => { try { window.Module.FS.stat('/home/web_user/gen1_romdrop.gb'); return false; } catch { return true; } });
if (!consumed) fail('import pipeline never consumed the dropped ROM (JS->FS->Lua poll broken)');

// ---- Tier 2: full boot-into-game with a real ROM (optional) -----------------
let tier2 = false;
if (process.env.TEST_ROM_B64 || process.env.TEST_ROM_PATH) {
  const rom = process.env.TEST_ROM_PATH
    ? fs.readFileSync(process.env.TEST_ROM_PATH)                 // local: a .gb file path
    : Buffer.from(process.env.TEST_ROM_B64, 'base64');          // CI: base64 secret
  if (rom.length !== 1024 * 1024) fail(`test ROM is ${rom.length} bytes, expected 1048576`);
  const romPath = path.join(os.tmpdir(), 'gb3d_smoke_real.gb');
  fs.writeFileSync(romPath, rom);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.Module && window.Module.calledRun === true, { timeout: 120000 });
  await page.waitForTimeout(1500);
  errors.length = 0;
  await page.setInputFiles('#romInput', romPath);
  // Extraction + the restart/reload into the game can take a while; watch for a
  // crash the whole time (the shell auto-opens #crash on any engine error).
  await page.waitForTimeout(25000);
  const crashed = await page.$eval('#crash', (el) => el.classList.contains('show')).catch(() => false);
  const fatal = errors.some((e) => /out of bounds|abort|attempt to index|nil value|not a function/i.test(e));
  if (crashed || fatal) fail('real-ROM extract/boot crashed:\n' + errors.slice(0, 8).join('\n'));
  tier2 = true;
}

await browser.close();
console.log(`SMOKE PASS ✓  (boot + WebGL + launcher + import pipeline${tier2 ? ' + real-ROM boot' : ''})`);
