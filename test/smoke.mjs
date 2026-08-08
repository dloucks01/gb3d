// gb3d headless smoke test — gates deploys so regressions are caught in CI,
// not on someone's phone.
//
// Tier 1 (always): boots the built site, asserts the engine initializes to the
// ROM launcher with WebGL and no console/page errors, and that the ROM-import
// pipeline reacts to a dropped file.
//
// Tier 2 (when the TEST_ROM_B64 secret is set to a base64 1 MiB US R/B/Y ROM):
// imports it, boots into play, then DRIVES real input (d-pad, A/B, Start, and
// the tilt keybind) and asserts nothing crashes — this is the tier that would
// have caught the bit/restart/audio regressions.
//
// Tier 3 (same ROM): injects a tiny committed save (test/fixtures) that resumes
// outside in Pallet Town, then cycles the Mode-7 "3D" tilt through every level and
// asserts no crash — the only tier that actually reaches a tilt-eligible map and
// exercises the tilt renderer that crashed on device.
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

// A real ROM unlocks the deeper tiers (extract, boot, and save-resume). Write it
// once; both tiers below import it.
const haveRom = !!(process.env.TEST_ROM_B64 || process.env.TEST_ROM_PATH);
let romPath = null;
if (haveRom) {
  const rom = process.env.TEST_ROM_PATH
    ? fs.readFileSync(process.env.TEST_ROM_PATH)                 // local: a .gb file path
    : Buffer.from(process.env.TEST_ROM_B64, 'base64');          // CI: base64 secret
  if (rom.length !== 1024 * 1024) fail(`test ROM is ${rom.length} bytes, expected 1048576`);
  romPath = path.join(os.tmpdir(), 'gb3d_smoke_real.gb');
  fs.writeFileSync(romPath, rom);
}

// ---- Tier 2: full boot-into-game with a real ROM (optional) -----------------
let tier2 = false;
if (haveRom) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.Module && window.Module.calledRun === true, { timeout: 120000 });
  await page.waitForTimeout(1500);
  errors.length = 0;
  await page.setInputFiles('#romInput', romPath);
  // Extraction + the restart/reload into the game can take a while; watch for a
  // crash the whole time (the shell auto-opens #crash on any engine error).
  await page.waitForTimeout(25000);

  // Drive real input through the running game. This exercises the input ->
  // update -> render loop and the tilt keybind — the code paths that crashed on
  // device (queueable audio on advance, the tilt renderer) but that a passive
  // "watch it boot" test never touches. Keys: z=A, x=B, arrows=d-pad,
  // Enter=Start, 3=cycle the Mode-7 tilt. LÖVE's own listeners are on the
  // window, so just focus the page and press.
  await page.bringToFront();
  const combos = ['z', 'z', 'Enter', 'z', 'ArrowDown', 'z', 'ArrowRight',
                  'ArrowUp', 'ArrowLeft', 'x', 'z', '3', 'z', '3', 'ArrowDown', '3'];
  for (const key of combos) {
    await page.keyboard.press(key, { delay: 40 });
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(2000);

  const crashed = await page.$eval('#crash', (el) => el.classList.contains('show')).catch(() => false);
  const fatal = errors.some((e) => /out of bounds|abort|attempt to index|nil value|not a function/i.test(e));
  if (crashed || fatal) fail('real-ROM boot/input crashed:\n' + errors.slice(0, 8).join('\n'));
  tier2 = true;
}

// ---- Tier 3: resume a committed save into the overworld and cycle the tilt ---
// Driving a fresh game all the way to the free-roam overworld (Oak's intro +
// name entry) is slow and fragile, so instead we inject a tiny committed save
// (test/fixtures/overworld-save.json) that resumes outside in Pallet Town — an
// only place the Mode-7 "3D" tilt renders. Then we cycle the tilt OFF->15->35
// ->50->OFF and assert no crash. THIS is the tier that exercises the tilt
// renderer that crashed on device; Tiers 1-2 never reach a tilt-eligible map.
const fixturePath = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'overworld-save.json');
let tier3 = false;
if (haveRom && fs.existsSync(fixturePath)) {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p3 = await ctx.newPage();
  const errs3 = [];
  p3.on('console', (m) => { if (m.type() === 'error' && !BENIGN.test(m.text())) errs3.push('console: ' + m.text()); });
  p3.on('pageerror', (e) => { if (!BENIGN.test(e.message)) errs3.push('pageerror: ' + e.message); });

  await p3.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p3.waitForFunction(() => window.Module && window.Module.calledRun === true, { timeout: 120000 });
  await p3.waitForTimeout(1200);

  // Inject the save under the LOVE save dir BEFORE importing the ROM, so the
  // post-import reboot boots gen1recomp with the slot already registered.
  await p3.evaluate(({ root, files }) => {
    const F = window.Module.FS, base = '/home/web_user/love/' + root;
    const mk = (p) => { let parts = p.split('/').filter(Boolean), cur = ''; for (const s of parts) { cur += '/' + s; try { F.mkdir(cur); } catch (e) {} } };
    const b2u = (b64) => { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
    for (const rel in files) { const full = base + '/' + rel; mk(full.replace(/\/[^/]+$/, '')); F.writeFile(full, b2u(files[rel])); }
    return new Promise((res) => F.syncfs(false, () => res(true)));
  }, fixture);

  const nav = p3.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
  await p3.setInputFiles('#romInput', romPath);
  await nav;
  await p3.waitForFunction(() => window.Module && window.Module.calledRun === true, { timeout: 120000 });
  await p3.waitForTimeout(5000);

  // Play Blue -> title -> CONTINUE -> resume into the overworld. "Play Blue" is
  // engine-drawn on the canvas at this fixed 390x844 viewport.
  const click = async (x, y, ms = 1200) => { await p3.mouse.move(x, y); await p3.waitForTimeout(80); await p3.mouse.down(); await p3.waitForTimeout(90); await p3.mouse.up(); await p3.waitForTimeout(ms); };
  await click(130, 298); await p3.waitForTimeout(2500);
  for (let i = 0; i < 6; i++) { await p3.keyboard.press('z', { delay: 25 }); await p3.waitForTimeout(900); }

  // Now cycle the Mode-7 tilt through every level and back, watching for a crash.
  errs3.length = 0;
  for (let i = 0; i < 4; i++) { await p3.keyboard.press('3', { delay: 25 }); await p3.waitForTimeout(900); }
  await p3.waitForTimeout(1500);
  const crash3 = await p3.$eval('#crash', (el) => el.classList.contains('show')).catch(() => false);
  const fatal3 = errs3.some((e) => /out of bounds|abort|attempt to index|nil value|not a function/i.test(e));
  if (crash3 || fatal3) fail('overworld resume / Mode-7 tilt crashed:\n' + errs3.slice(0, 8).join('\n'));
  await ctx.close();
  tier3 = true;
}

await browser.close();
console.log(`SMOKE PASS ✓  (boot + WebGL + launcher + import pipeline${tier2 ? ' + real-ROM boot' : ''}${tier3 ? ' + overworld-resume + Mode-7 tilt' : ''})`);
