# gb3d engine (experimental) — emulator + our own 3D renderer

A ground-up rendering engine that runs the real Pokémon ROM in a Game Boy
emulator core for **authentic game logic**, reads the picture state out of the
emulator every frame, and re-renders the world ourselves in **real WebGL 3D**
(the overworld tilted into perspective, sprites billboarded, HUD/text flat on
top). This is the "best of both" path: perfect compatibility *and* a 3D we fully
control — unlike gen1recomp's love.js Mode-7, whose quality is capped by the
browser Lua runtime.

This directory is **experimental and self-contained**. The shipping app is still
the gen1recomp/love.js build under `docs/`; nothing here affects it.

## Roadmap

- **Phase 0 — Feasibility (DONE).** Prove we can reconstruct a frame purely from
  the emulator's PPU state. See `spike.js`. ✅ Verified: the title-screen
  Blastoise (which lives in the BG tilemap) reconstructs correctly from the
  emulator's internal map + tile data.
- **Phase 1 — Flat WebGL renderer.** Upload the 256×256 BG tile surface + sprite
  list to WebGL and draw it flat, matching the emulator.
- **Phase 2 — 3D.** Project the BG plane into perspective; keep sprites upright
  and the window/HUD flat on top. Camera + tilt controls.
- **Phase 3 — Integration.** Input, audio (APU), and battery saves (SRAM) into
  the existing shell/PWA; package offline.
- **Phase 4 — Harden + smoke gate**, like the current build has.

## Phase 0 findings (what the browser core must expose)

Running Blue headlessly through **serverboy** (a Node wrapper over the
Gameboy-Online JS core) and reconstructing frames turned up the exact contract a
core must satisfy for this engine:

1. **Tile DATA** (`0x8000–0x97FF`) is in the core's CPU `memory` array — fine.
2. **Tile MAP** (`0x9800–0x9FFF`) is **NOT** in `memory` (reads back zero via
   `serverboy.getMemory()`). Gameboy-Online keeps the live maps in a separate
   internal array, **`BGCHRBank1`** (2 KiB; `[0..0x3FF]`→`0x9800`,
   `[0x400..0x7FF]`→`0x9C00`). `spike.js` reads the map from there.
3. **OAM / sprites**: `getMemory()`'s `0xFE00` region is unreliable (Gen 1 builds
   sprites in a WRAM shadow buffer and OAM-DMAs them in). Read hardware OAM at a
   stable point (VBlank) or the shadow buffer.
4. **Read at VBlank.** Reading VRAM at an arbitrary instant catches it
   mid-rewrite. `doFrame()`/end-of-frame is the stable point.
5. **Mid-frame raster tricks exist.** The *title screen* rewrites sprite/scroll
   state mid-frame (that's why a single snapshot can't fully rebuild it). The
   **overworld does not** — it's a plain BG tilemap + <40 sprites — so the 3D
   diorama target is unaffected. Menus/battles that use raster effects will need
   care later.

Net: the approach is sound. For the **browser** build we need an in-browser core
that exposes the tilemap + OAM (Gameboy-Online itself does, via `BGCHRBank1` +
internals; alternatives: binjgb or WasmBoy). Core selection is Phase 1's first
task.

## Run the spike

```
cd engine && npm install
node spike.js /path/to/blue.gb ./out     # writes sp_emu / sp_recon_* PNGs
BOOT=1300 node spike.js blue.gb ./out    # BOOT picks the frame (1300 ≈ title)
```
`sp_recon_fullbg.png` is the 256×256 BG surface we will tilt in 3D.
