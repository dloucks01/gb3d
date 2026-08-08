// Phase 0 spike — feasibility proof for the "emulator + our own 3D renderer"
// engine. It runs Pokémon Blue in a headless Game Boy core (serverboy's
// Gameboy-Online) and reconstructs a frame PURELY from the emulator's internal
// PPU state, then writes both the emulator's own screen and our reconstruction
// so they can be compared.
//
// What it proves: we can pull the full background tilemap (the 256x256 surface
// we will tilt into 3D) and the tile graphics straight out of the running
// emulator every frame and re-render them ourselves — the whole premise of the
// engine. Verified: the title screen's Blastoise, which lives in the BG map,
// reconstructs correctly.
//
// KEY FINDING (documented in engine/README.md): Gameboy-Online does NOT keep the
// live tilemap in its CPU `memory` array (0x9800-0x9FFF reads back as zero via
// serverboy's getMemory()). The maps live in a separate internal array,
// `BGCHRBank1` (2 KiB, mirroring 0x9800-0x9FFF). Tile DATA is in `memory`
// (0x8000-0x97FF). Any core we adopt for the browser build must expose both.
//
// Usage: node spike.js <rom.gb> [outdir]   (BOOT=<frames> to pick the frame)
const fs = require('fs');
const path = require('path');
const GameBoyCore = require('serverboy/src/gameboy_core/gameboy.js');
const { PNG } = require('pngjs');

const ROM = process.argv[2];
const OUT = process.argv[3] || '.';
const BOOT = parseInt(process.env.BOOT || '1300', 10);   // 1300 ~ the title screen
if (!ROM) { console.error('usage: node spike.js <rom.gb> [outdir]'); process.exit(1); }

const core = new GameBoyCore([...fs.readFileSync(ROM)]);
core.openMBC = function () { return []; };
core.start(); core.stopEmulator &= 1; core.iterations = 0;
for (let i = 0; i < BOOT; i++) core.run();

const mem = core.memory;             // tile DATA (0x8000-0x97FF) lives here
const map = core.BGCHRBank1;         // tile MAP  (0x9800-0x9FFF) lives here
const rd = (a) => mem[a] & 0xff;

const LCDC = rd(0xff40), SCY = rd(0xff42), SCX = rd(0xff43);
const BGP = rd(0xff47), OBP0 = rd(0xff48), OBP1 = rd(0xff49), WY = rd(0xff4a), WX = rd(0xff4b);
const bgOn = (LCDC & 1) !== 0, objOn = (LCDC & 2) !== 0, objSize = (LCDC & 4) ? 16 : 8;
const bgMapOff = (LCDC & 8) ? 0x400 : 0x000;         // 0x9C00 vs 0x9800 inside BGCHRBank1
const winMapOff = (LCDC & 0x40) ? 0x400 : 0x000;
const signed = (LCDC & 0x10) === 0;                  // 0x8800 signed vs 0x8000 unsigned
const winOn = (LCDC & 0x20) !== 0;
console.log(`frame ${BOOT}: LCDC=${LCDC.toString(16)} bg=${bgOn} obj=${objOn} bgMap=${(LCDC&8)?'9C00':'9800'} ` +
            `tileData=${signed ? '8800' : '8000'} win=${winOn} SCX=${SCX} SCY=${SCY} BGP=${BGP.toString(16)}`);

const SHADE = [0xff, 0xaa, 0x55, 0x00];
const pal = (p, ci) => (p >> (ci * 2)) & 3;
function tile(index, unsignedBase) {                 // 8x8 color indices (0..3)
  const base = unsignedBase ? 0x8000 + index * 16 : 0x9000 + ((index << 24 >> 24) * 16);
  const px = new Uint8Array(64);
  for (let y = 0; y < 8; y++) { const lo = rd(base + y * 2), hi = rd(base + y * 2 + 1);
    for (let x = 0; x < 8; x++) { const b = 7 - x; px[y * 8 + x] = ((lo >> b) & 1) | (((hi >> b) & 1) << 1); } }
  return px;
}

// The full 256x256 BG map — the surface the 3D renderer will tilt.
function fullBG() {
  const img = new PNG({ width: 256, height: 256 });
  for (let ty = 0; ty < 32; ty++) for (let tx = 0; tx < 32; tx++) {
    const px = tile(map[bgMapOff + ty * 32 + tx] & 0xff, !signed);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const s = SHADE[pal(BGP, px[y * 8 + x])]; const o = ((ty * 8 + y) * 256 + (tx * 8 + x)) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = s; img.data[o + 3] = 255;
    }
  }
  return img;
}

// The visible 160x144 viewport: scrolled BG + window + sprites (OAM in memory).
function viewport() {
  const img = new PNG({ width: 160, height: 144 });
  const put = (x, y, s) => { const o = (y * 160 + x) * 4; img.data[o] = img.data[o + 1] = img.data[o + 2] = s; img.data[o + 3] = 255; };
  for (let y = 0; y < 144; y++) for (let x = 0; x < 160; x++) {
    if (!bgOn) { put(x, y, 0xff); continue; }
    const by = (y + SCY) & 0xff, bx = (x + SCX) & 0xff;
    put(x, y, SHADE[pal(BGP, tile(map[bgMapOff + (by >> 3) * 32 + (bx >> 3)] & 0xff, !signed)[(by & 7) * 8 + (bx & 7)])]);
  }
  if (winOn && WX <= 166 && WY <= 143) for (let y = Math.max(0, WY); y < 144; y++) for (let x = Math.max(0, WX - 7); x < 160; x++) {
    const wy = y - WY, wx = x - (WX - 7);
    put(x, y, SHADE[pal(BGP, tile(map[winMapOff + (wy >> 3) * 32 + (wx >> 3)] & 0xff, !signed)[(wy & 7) * 8 + (wx & 7)])]);
  }
  if (objOn) for (let s = 0; s < 40; s++) {
    const o = 0xfe00 + s * 4, sy = rd(o) - 16, sx = rd(o + 1) - 8, t = rd(o + 2), attr = rd(o + 3);
    const fY = attr & 0x40, fX = attr & 0x20, opal = (attr & 0x10) ? OBP1 : OBP0;
    for (let row = 0; row < objSize; row++) {
      let ti = objSize === 16 ? (t & 0xfe) : t, r = row; if (row >= 8) { ti = (t & 0xfe) | 1; r = row - 8; }
      const px = tile(ti, true), yy = sy + (fY ? (objSize - 1 - row) : row); if (yy < 0 || yy >= 144) continue;
      for (let col = 0; col < 8; col++) { const ci = px[(fY ? 7 - r : r) * 8 + (fX ? 7 - col : col)]; if (!ci) continue;
        const xx = sx + col; if (xx < 0 || xx >= 160) continue; put(xx, yy, SHADE[pal(opal, ci)]); }
    }
  }
  return img;
}

function emu() {
  const scr = core.currentScreen; const img = new PNG({ width: 160, height: 144 });
  for (let i = 0; i < 160 * 144 * 4; i++) img.data[i] = scr[i];
  return img;
}

fs.writeFileSync(path.join(OUT, 'sp_emu.png'), PNG.sync.write(emu()));
fs.writeFileSync(path.join(OUT, 'sp_recon_viewport.png'), PNG.sync.write(viewport()));
fs.writeFileSync(path.join(OUT, 'sp_recon_fullbg.png'), PNG.sync.write(fullBG()));
console.log(`wrote sp_emu.png, sp_recon_viewport.png, sp_recon_fullbg.png to ${OUT}`);
