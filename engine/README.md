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
- **Phase 1 — Flat WebGL renderer (IN PROGRESS).** `web/` runs the core live in
  the browser and draws the scene as SEPARATE layers of textured WebGL geometry
  — a 256×256 BG "ground plane" quad (scrolled by SCX/SCY), one quad per OAM
  sprite, and a window/HUD quad — under an orthographic camera so it matches the
  emulator. Playable via keyboard. ✅ BG plane + sprites verified against the
  emulator (the title-screen Blastoise + sprites composite correctly). ⚠️ The
  window layer and some intro screens show artifacts from mid-frame raster
  tricks (per-scanline SCY/WY changes) — the SAME limitation Phase 0 flagged.
  The overworld (our 3D target) uses no such tricks, so it renders cleanly;
  intro/title/menu raster effects are a later refinement.
- **Phase 2 — 3D (IN PROGRESS).** A pitched perspective camera tilts the BG
  ground plane (0°/15°/35°/50°, press `T` or the HUD button). Overworld
  characters are clustered from their OAM tiles and stood up as camera-facing
  SLABS (with a little extrusion depth) rooted on the ground, each with a soft
  drop-shadow. ✅ The ground tilt renders correctly at 100+fps; the player
  stands on the tilted floor with a shadow. ⚠️ Known limit: the Gen1 overworld
  keeps the LCD window enabled and raster-positions it, so a single-snapshot
  read sees WY=0 (full screen); drawn flat that would cover the tilt, so when
  tilted we skip a window reaching the upper screen (WY<72) and keep genuine
  bottom text boxes. Flat mode (tilt 0, the default) draws every window at full
  fidelity. Raster-aware WY (and more pronounced standees) are refinements.

### Sprites in 3D (design note)

The 3D read comes from **shadows + perspective**, not from the sprites having
real geometry. Plan: billboard each 2D sprite upright on the tilted ground with
a soft drop-shadow ellipse (cheap, convincing — Paper Mario / Octopath "2.5D").
Optional upgrade: **voxelize** a sprite by treating each pixel as an extruded
cube, yielding a genuine blocky 3D model generated at runtime from the same VRAM
we already read. Hand-authored / AI meshes are out of scope for an offline,
deterministic, thousands-of-sprites PWA.

### Color & shading

Rendering is colorized with the games' authentic **Super Game Boy palettes**
(from `pret/pokered` `data/sgb`): the background uses the current map's area
palette (read from `wCurMap` at `0xD35E` — Pallet Town / Red's house =
`PAL_PALLET`, routes = `PAL_ROUTE`, etc.), overworld characters use a warm
skin/red OBJ palette, and the text box uses a crisp UI palette. A subtle
depth-darkening on the tilted ground reinforces the 3D. The per-species mon
palettes (`PAL_REDMON`/`GREENMON`/`BLUEMON`/…) are captured in `MON` for battle
sprites — activating those needs battle detection + a species→palette table
(next step). Palette RGB is authentic SGB (5-bit expanded to 8-bit).

### web/ — run it

```
cd engine && npm install && ./web/build-core.sh   # bundles the core (gitignored)
python3 -m http.server 8091 --directory web        # then open localhost:8091
```
`web/engine.js` is the whole renderer; `web/gbcore.bundle.js` is the vendored
core (built, not committed).

**Controls:** arrows = d-pad, `Z` = A, `X` = B, `Enter` = Start, `Shift` =
Select. **Turbo:** `1` / `2` / `3` set 1×/2×/3× speed (or tap the `1×` button to
cycle); **hold `Space`** for momentary 3× turbo. Turbo emulates N frames per
rendered frame, so game logic runs 2–3× faster while the display stays at 60fps.
**3D tilt:** press `T` (or the tilt button) to cycle 0°/15°/35°/50°.
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
