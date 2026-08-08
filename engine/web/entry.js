// Browser entry: expose the (CommonJS) Game Boy core as a global. We drive it
// ourselves and read VRAM/OAM out of it; we do NOT use its own renderer.
const GameBoyCore = require('serverboy/src/gameboy_core/gameboy.js');
window.GameBoyCore = GameBoyCore;
