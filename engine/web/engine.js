// gb3d engine — Phase 1: live Game Boy core -> layered WebGL renderer.
//
// Each frame we step the emulator, then read the PPU state straight out of the
// core (tile DATA in core.memory, tile MAP in core.BGCHRBank1, OAM in
// core.memory[0xFE00..], scroll/palette registers) and draw the scene as
// SEPARATE layers of textured geometry:
//   * a 256x256 background "ground plane" quad (scrolled by SCX/SCY),
//   * one quad per visible OAM sprite,
//   * a window/HUD quad on top.
// Phase 1 renders them flat under an orthographic camera so the output matches
// the emulator. Phase 2 keeps the exact same layers but tilts the ground plane
// into perspective and stands the sprite quads up with shadows — which is why
// we build separate layers now instead of baking one framebuffer image.

(() => {
  const GBW = 160, GBH = 144;
  const SHADE = [255, 170, 85, 0];               // DMG light->dark, baked to gray
  const canvas = document.getElementById('gl');
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
  if (!gl) { alert('WebGL2 required'); return; }

  // ---- GL setup -------------------------------------------------------------
  const vs = `#version 300 es
    in vec2 a_pos; in vec2 a_uv; uniform vec2 u_res; out vec2 v_uv;
    void main(){ v_uv=a_uv; gl_Position=vec4(a_pos.x/u_res.x*2.0-1.0, 1.0-a_pos.y/u_res.y*2.0, 0.0, 1.0); }`;
  const fs = `#version 300 es
    precision highp float; in vec2 v_uv; uniform sampler2D u_tex; uniform float u_keyed; out vec4 o;
    void main(){ vec4 c=texture(u_tex,v_uv); if(u_keyed>0.5 && c.a<0.5) discard; o=vec4(c.rgb,1.0); }`;
  const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o);
    if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog); if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  const loc = { pos: gl.getAttribLocation(prog, 'a_pos'), uv: gl.getAttribLocation(prog, 'a_uv'),
    res: gl.getUniformLocation(prog, 'u_res'), keyed: gl.getUniformLocation(prog, 'u_keyed') };
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.enableVertexAttribArray(loc.pos); gl.vertexAttribPointer(loc.pos, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(loc.uv);  gl.vertexAttribPointer(loc.uv, 2, gl.FLOAT, false, 16, 8);
  gl.uniform2f(loc.res, GBW, GBH);

  const mkTex = () => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT); return t; };
  const bgTex = mkTex(), winTex = mkTex();
  const spriteTexPool = Array.from({ length: 40 }, mkTex);
  const bgBuf = new Uint8Array(256 * 256 * 4);
  const winBuf = new Uint8Array(256 * 256 * 4);

  // Draw one textured quad in GB-pixel coords (x0,y0)-(x1,y1) with uv rect.
  function quad(tex, x0, y0, x1, y1, u0, v0, u1, v1, keyed) {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1f(loc.keyed, keyed ? 1 : 0);
    const d = new Float32Array([
      x0, y0, u0, v0,  x1, y0, u1, v0,  x0, y1, u0, v1,
      x0, y1, u0, v1,  x1, y0, u1, v0,  x1, y1, u1, v1]);
    gl.bufferData(gl.ARRAY_BUFFER, d, gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // ---- emulator + PPU read --------------------------------------------------
  let core = null, running = false;
  let baseSpeed = 1, turboHeld = false;            // turbo: emulate N frames per render
  const effSpeed = () => turboHeld ? Math.max(3, baseSpeed) : baseSpeed;
  const rd = (a) => core.memory[a] & 0xff;

  function tilePx(index, unsignedBase, out) {           // 8x8 color indices -> out[64]
    const base = unsignedBase ? 0x8000 + index * 16 : 0x9000 + ((index << 24 >> 24) * 16);
    for (let y = 0; y < 8; y++) { const lo = rd(base + y * 2), hi = rd(base + y * 2 + 1);
      for (let x = 0; x < 8; x++) { const b = 7 - x; out[y * 8 + x] = ((lo >> b) & 1) | (((hi >> b) & 1) << 1); } }
  }
  const pal = (p, ci) => (p >> (ci * 2)) & 3;
  const tmp = new Uint8Array(64);

  // Decode a 32x32-tile map region (from BGCHRBank1) into a 256x256 RGBA buffer.
  function decodeMap(mapOff, signed, palReg, buf) {
    const map = core.BGCHRBank1;
    for (let ty = 0; ty < 32; ty++) for (let tx = 0; tx < 32; tx++) {
      tilePx(map[mapOff + ty * 32 + tx] & 0xff, !signed, tmp);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const s = SHADE[pal(palReg, tmp[y * 8 + x])];
        const o = ((ty * 8 + y) * 256 + (tx * 8 + x)) * 4;
        buf[o] = buf[o + 1] = buf[o + 2] = s; buf[o + 3] = 255;
      }
    }
  }

  function frame() {
    if (!running || !core) return;
    const n = effSpeed();
    for (let i = 0; i < n; i++) core.run();        // turbo: N emulated frames, one render
    window.__ranFrames = (window.__ranFrames || 0) + n;
    renderScene();
    tickFPS();
    requestAnimationFrame(frame);
  }

  function renderScene() {
    if (!core) return;
    const LCDC = rd(0xff40), SCY = rd(0xff42), SCX = rd(0xff43);
    const BGP = rd(0xff47), OBP0 = rd(0xff48), OBP1 = rd(0xff49), WY = rd(0xff4a), WX = rd(0xff4b);
    const bgOn = (LCDC & 1) !== 0, objOn = (LCDC & 2) !== 0, objSize = (LCDC & 4) ? 16 : 8;
    const bgMapOff = (LCDC & 8) ? 0x400 : 0x000, winMapOff = (LCDC & 0x40) ? 0x400 : 0x000;
    const signed = (LCDC & 0x10) === 0, winOn = (LCDC & 0x20) !== 0;

    resize();
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);

    // BG ground plane (scrolled). REPEAT wrap makes SCX/SCY scrolling wrap.
    if (bgOn) {
      decodeMap(bgMapOff, signed, BGP, bgBuf);
      gl.bindTexture(gl.TEXTURE_2D, bgTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 256, 0, gl.RGBA, gl.UNSIGNED_BYTE, bgBuf);
      const u0 = SCX / 256, v0 = SCY / 256, u1 = (SCX + GBW) / 256, v1 = (SCY + GBH) / 256;
      quad(bgTex, 0, 0, GBW, GBH, u0, v0, u1, v1, false);
    }

    // Sprites (OAM). color 0 is transparent.
    if (objOn) {
      let p = 0;
      for (let s = 0; s < 40 && p < spriteTexPool.length; s++) {
        const o = 0xfe00 + s * 4, sy = rd(o) - 16, sx = rd(o + 1) - 8, t = rd(o + 2), attr = rd(o + 3);
        if (sy <= -objSize || sy >= GBH || sx <= -8 || sx >= GBW) continue;
        const fY = attr & 0x40, fX = attr & 0x20, opal = (attr & 0x10) ? OBP1 : OBP0;
        const px = new Uint8Array(8 * objSize * 4);
        for (let row = 0; row < objSize; row++) {
          let ti = objSize === 16 ? (t & 0xfe) : t, r = row; if (row >= 8) { ti = (t & 0xfe) | 1; r = row - 8; }
          tilePx(ti, true, tmp);
          for (let col = 0; col < 8; col++) {
            const ci = tmp[r * 8 + col]; const srcRow = fY ? (objSize - 1 - row) : row, srcCol = fX ? (7 - col) : col;
            const oo = (srcRow * 8 + srcCol) * 4;
            if (ci === 0) { px[oo + 3] = 0; } else { const sh2 = SHADE[pal(opal, ci)]; px[oo] = px[oo + 1] = px[oo + 2] = sh2; px[oo + 3] = 255; }
          }
        }
        const tex = spriteTexPool[p++];
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 8, objSize, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
        quad(tex, sx, sy, sx + 8, sy + objSize, 0, 0, 1, 1, true);
      }
    }

    // Window / HUD (opaque, on top). Drawn from its own map at (WX-7, WY).
    if (winOn && WX <= 166 && WY <= GBH - 1) {
      decodeMap(winMapOff, signed, BGP, winBuf);
      const x0 = Math.max(0, WX - 7), y0 = Math.max(0, WY);
      gl.bindTexture(gl.TEXTURE_2D, winTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 256, 0, gl.RGBA, gl.UNSIGNED_BYTE, winBuf);
      quad(winTex, x0, y0, GBW, GBH, 0, 0, (GBW - x0) / 256, (GBH - y0) / 256, false);
    }
  }

  // ---- viewport / fps -------------------------------------------------------
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    // letterbox to the GB aspect ratio
    const scale = Math.min(canvas.width / GBW, canvas.height / GBH);
    const vw = Math.floor(GBW * scale), vh = Math.floor(GBH * scale);
    gl.viewport((canvas.width - vw) >> 1, (canvas.height - vh) >> 1, vw, vh);
  }
  let fpsT = 0, fpsN = 0; const fpsEl = document.getElementById('fps');
  function tickFPS() { fpsN++; const now = performance.now();
    if (now - fpsT > 500) { const s = effSpeed();
      fpsEl.textContent = Math.round(fpsN * 1000 / (now - fpsT)) + ' fps' + (s > 1 ? '  ·  ' + s + '×' : '');
      fpsT = now; fpsN = 0; } }

  // ---- turbo / speed --------------------------------------------------------
  const speedBtn = document.getElementById('speed');
  function setSpeed(v) { baseSpeed = Math.max(1, Math.min(3, v | 0)); if (speedBtn) speedBtn.textContent = baseSpeed + '×'; }
  if (speedBtn) speedBtn.addEventListener('click', () => setSpeed(baseSpeed % 3 + 1));
  window.__setSpeed = setSpeed;                    // test/introspection hook
  window.__getSpeed = effSpeed;

  // ---- input ----------------------------------------------------------------
  const KEY = { ArrowRight: 0, ArrowLeft: 1, ArrowUp: 2, ArrowDown: 3, z: 4, x: 5, Shift: 6, Enter: 7 };
  addEventListener('keydown', (e) => {
    if (e.key === '1' || e.key === '2' || e.key === '3') { setSpeed(+e.key); e.preventDefault(); return; }
    if (e.key === 'Tab' || e.key === ' ') { turboHeld = true; e.preventDefault(); return; }   // hold to turbo (3×)
    const b = KEY[e.key]; if (b !== undefined && core) { core.JoyPadEvent(b, true); e.preventDefault(); }
  });
  addEventListener('keyup', (e) => {
    if (e.key === 'Tab' || e.key === ' ') { turboHeld = false; e.preventDefault(); return; }
    const b = KEY[e.key]; if (b !== undefined && core) { core.JoyPadEvent(b, false); e.preventDefault(); }
  });

  // ---- ROM load / boot ------------------------------------------------------
  window.__loadROM = (bytes) => {
    core = new window.GameBoyCore([...bytes]);
    core.openMBC = () => [];
    core.start(); core.stopEmulator &= 1; core.iterations = 0;
    running = true;
    window.__core = core;                          // test introspection
    if (window.__auto !== false) requestAnimationFrame(frame);
  };
  // Headless test hooks: deterministically step frames and render on demand.
  window.__stepFrames = (n) => { for (let i = 0; i < n; i++) core.run(); };
  window.__renderOnce = () => renderScene();
  window.__press = (bit, downFrames = 6, gapFrames = 8) => {
    for (let i = 0; i < downFrames; i++) { core.JoyPadEvent(bit, true); core.run(); }
    core.JoyPadEvent(bit, false); for (let i = 0; i < gapFrames; i++) core.run();
  };
  window.__engineReady = true;
})();
