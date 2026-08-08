# Test fixtures

## `overworld-save.json`

A tiny gen1recomp **Pokémon Blue** save that resumes in an overworld map
(`REDS_HOUSE_2F`) — the only kind of map where the Mode-7 "3D" tilt renders.
The smoke test (`test/smoke.mjs`, Tier 3) injects it before importing the ROM so
the launcher shows a loaded slot, resumes straight into the overworld, and cycles
the tilt through every level asserting no crash. Reaching that map from a fresh
game (Oak's intro + name entry) is slow and fragile, so we ship the save instead.

It contains two files gen1recomp writes under its LOVE save dir
(`<love-save>/pokemon-love2d/`):

- `options.lua` — the slot **registry**: `saveSlots.blue = { active="slot1",
  list={"slot1"} }` plus `lastVersion="blue"`. Without this the launcher shows
  "0 slots" no matter what save files exist (see `src/core/SaveData.lua`: the
  registry lives in `options.lua`, not on disk-scan).
- `saves/blue/slot1.lua` — the save state itself (player in `REDS_HOUSE_2F`).

No ROM or copyrighted data is included — only this ~700-byte save state and the
options file. The game's ROM-derived data/assets regenerate from the user's own
imported ROM on boot.

### Regenerating

If a gen1recomp bump changes the save format, regenerate the fixture:

1. Serve a build: `python3 -m http.server 8080 --directory docs`.
2. Headless (or by hand on a phone): import a US Blue ROM, start a new game,
   skip the intro, and once you have overworld control press **Start → SAVE →
   YES**. (`Escape` is Start; `z`=A. Any map where the tilt renders works.)
3. Export the two files from the emscripten FS under
   `/home/web_user/love/pokemon-love2d/`: `options.lua` and
   `saves/blue/slot1.lua`, base64 them, and rebuild `overworld-save.json` as
   `{ root:"pokemon-love2d", files:{ "options.lua":<b64>,
   "saves/blue/slot1.lua":<b64> } }`.

The in-browser **☰ → Backup** button exports the whole save dir if you'd rather
grab it from a real device; keep only those two files.
