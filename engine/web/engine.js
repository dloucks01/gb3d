// gb3d engine — Phase 2: live Game Boy core -> 3D WebGL renderer.
//
// Same layered read as Phase 1 (BG tile MAP in core.BGCHRBank1, tile DATA in
// core.memory, OAM sprites, scroll/palette regs), but now drawn in 3D:
//   * the background is a GROUND PLANE quad the camera pitches over (the tilt),
//   * overworld characters are clustered from their OAM tiles and stood up as
//     camera-facing SLABS rooted on the ground, each with a soft drop-shadow,
//   * the window/HUD is drawn flat in screen space on top.
// The 3D read comes from perspective + shadows; the sprite keeps its crisp 2D
// face. Tilt: 0 = flat top-down (matches the emulator), up to ~50°.

(() => {
  const GBW = 160, GBH = 144;
  const SHADE = [255, 170, 85, 0];               // DMG light->dark, baked to gray
  const TILT_LEVELS = [0, 15, 35, 50];
  const CAM_DIST = 174, FOV = 45 * Math.PI / 180; // D & fov chosen so tilt 0 frames 160x144
  const SLAB_DEPTH = 3;                           // slab thickness (world units) — the "extrusion"
  let tiltDeg = 0;

  const canvas = document.getElementById('gl');
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: true, preserveDrawingBuffer: true });
  if (!gl) { alert('WebGL2 required'); return; }

  // ---- tiny mat4 (column-major) --------------------------------------------
  const sub = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
  const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0]/l, a[1]/l, a[2]/l]; };
  const mul4 = (a, b) => { const o = new Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0;
      for (let k = 0; k < 4; k++) s += a[k*4+r] * b[c*4+k]; o[c*4+r] = s; } return o; };
  const persp = (fovy, asp, n, f) => { const t = 1 / Math.tan(fovy/2);
    return [t/asp,0,0,0, 0,t,0,0, 0,0,(f+n)/(n-f),-1, 0,0,(2*f*n)/(n-f),0]; };
  function lookAt(eye, ctr, up) {
    const z = norm(sub(eye, ctr)), x = norm(cross(up, z)), y = cross(z, x);
    return [x[0],y[0],z[0],0, x[1],y[1],z[1],0, x[2],y[2],z[2],0,
            -dot(x,eye),-dot(y,eye),-dot(z,eye),1];
  }
  const orthoGB = [2/GBW,0,0,0, 0,-2/GBH,0,0, 0,0,-1,0, -1,1,0,1]; // GB px -> clip (y down)

  // ---- GL program (u_mvp * vec3 pos) ---------------------------------------
  const vs = `#version 300 es
    in vec3 a_pos; in vec2 a_uv; uniform mat4 u_mvp; out vec2 v_uv;
    void main(){ v_uv=a_uv; gl_Position=u_mvp*vec4(a_pos,1.0); }`;
  const fs = `#version 300 es
    precision highp float; in vec2 v_uv; uniform sampler2D u_tex;
    uniform float u_keyed, u_alpha; uniform vec3 u_tint; out vec4 o;
    void main(){ vec4 c=texture(u_tex,v_uv); if(u_keyed>0.5 && c.a<0.5) discard;
      o=vec4(c.rgb*u_tint, c.a*u_alpha); }`;
  const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o);
    if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog); if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  const loc = { pos: gl.getAttribLocation(prog, 'a_pos'), uv: gl.getAttribLocation(prog, 'a_uv'),
    mvp: gl.getUniformLocation(prog, 'u_mvp'), tex: gl.getUniformLocation(prog, 'u_tex'),
    keyed: gl.getUniformLocation(prog, 'u_keyed'), alpha: gl.getUniformLocation(prog, 'u_alpha'),
    tint: gl.getUniformLocation(prog, 'u_tint') };
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.enableVertexAttribArray(loc.pos); gl.vertexAttribPointer(loc.pos, 3, gl.FLOAT, false, 20, 0);
  gl.enableVertexAttribArray(loc.uv);  gl.vertexAttribPointer(loc.uv, 2, gl.FLOAT, false, 20, 12);

  const mkTex = (wrap) => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const w = wrap || gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, w);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, w); return t; };
  const bgTex = mkTex(gl.REPEAT), winTex = mkTex(gl.REPEAT);
  const bgBuf = new Uint8Array(256 * 256 * 4), winBuf = new Uint8Array(256 * 256 * 4);

  // Soft radial shadow texture (built once).
  const shadowTex = (() => { const S = 32, d = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const dx = (x - S/2) / (S/2), dy = (y - S/2) / (S/2), r = Math.hypot(dx, dy);
      const a = Math.max(0, 1 - r); const o = (y * S + x) * 4;
      d[o] = d[o+1] = d[o+2] = 0; d[o+3] = Math.round(a * a * 150);
    }
    const t = mkTex(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, S, S, 0, gl.RGBA, gl.UNSIGNED_BYTE, d);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); return t; })();
  const whiteTex = (() => { const t = mkTex(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255,255,255,255])); return t; })();

  let mvp = orthoGB;
  function setMVP(m) { mvp = m; gl.uniformMatrix4fv(loc.mvp, false, new Float32Array(m)); }
  // Draw a quad from 4 world corners p0..p3 (TL,TR,BR,BL) with matching uvs.
  function drawQuad(tex, p, uv, { keyed = false, alpha = 1, tint = [1,1,1] } = {}) {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1f(loc.keyed, keyed ? 1 : 0); gl.uniform1f(loc.alpha, alpha); gl.uniform3fv(loc.tint, tint);
    const d = new Float32Array([
      p[0][0],p[0][1],p[0][2], uv[0][0],uv[0][1],  p[1][0],p[1][1],p[1][2], uv[1][0],uv[1][1],  p[2][0],p[2][1],p[2][2], uv[2][0],uv[2][1],
      p[0][0],p[0][1],p[0][2], uv[0][0],uv[0][1],  p[2][0],p[2][1],p[2][2], uv[2][0],uv[2][1],  p[3][0],p[3][1],p[3][2], uv[3][0],uv[3][1]]);
    gl.bufferData(gl.ARRAY_BUFFER, d, gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // ---- emulator + PPU read --------------------------------------------------
  let core = null, running = false;
  let baseSpeed = 1, turboHeld = false;
  const effSpeed = () => turboHeld ? Math.max(3, baseSpeed) : baseSpeed;
  const rd = (a) => core.memory[a] & 0xff;
  const tmp = new Uint8Array(64);
  function tilePx(index, unsignedBase, out) {
    const base = unsignedBase ? 0x8000 + index * 16 : 0x9000 + ((index << 24 >> 24) * 16);
    for (let y = 0; y < 8; y++) { const lo = rd(base + y*2), hi = rd(base + y*2 + 1);
      for (let x = 0; x < 8; x++) { const b = 7 - x; out[y*8+x] = ((lo>>b)&1) | (((hi>>b)&1)<<1); } }
  }
  const pal = (p, ci) => (p >> (ci*2)) & 3;
  function decodeMap(mapOff, signed, palReg, buf) {
    const map = core.BGCHRBank1;
    for (let ty = 0; ty < 32; ty++) for (let tx = 0; tx < 32; tx++) {
      tilePx(map[mapOff + ty*32 + tx] & 0xff, !signed, tmp);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const s = SHADE[pal(palReg, tmp[y*8+x])]; const o = ((ty*8+y)*256 + (tx*8+x)) * 4;
        buf[o]=buf[o+1]=buf[o+2]=s; buf[o+3]=255;
      }
    }
  }

  // Cluster visible OAM sprites into connected characters (adjacent bboxes),
  // so a 4-tile overworld character becomes ONE standing slab, not four.
  function readSpriteClusters(objSize, OBP0, OBP1) {
    const items = [];
    for (let s = 0; s < 40; s++) {
      const o = 0xfe00 + s*4, sy = rd(o) - 16, sx = rd(o+1) - 8, t = rd(o+2), attr = rd(o+3);
      if (sy <= -objSize || sy >= GBH || sx <= -8 || sx >= GBW) continue;
      items.push({ sx, sy, t, attr });
    }
    const boxes = items.map(s => ({ x0: s.sx, y0: s.sy, x1: s.sx+8, y1: s.sy+objSize, items: [s] }));
    let merged = true;
    while (merged) { merged = false;
      for (let i = 0; i < boxes.length; i++) for (let j = i+1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1) {  // overlap/adjacent
          a.x0 = Math.min(a.x0, b.x0); a.y0 = Math.min(a.y0, b.y0);
          a.x1 = Math.max(a.x1, b.x1); a.y1 = Math.max(a.y1, b.y1);
          a.items = a.items.concat(b.items); boxes.splice(j, 1); merged = true; j--;
        }
      }
    }
    return boxes;
  }
  // Decode a whole sprite (8x8 or 8x16) into color indices, no flips applied.
  const spRaw = new Uint8Array(8 * 16);
  function spriteRaw(s, objSize) {
    tilePx(objSize === 16 ? (s.t & 0xfe) : s.t, true, tmp);
    for (let i = 0; i < 64; i++) spRaw[i] = tmp[i];
    if (objSize === 16) { tilePx((s.t & 0xfe) | 1, true, tmp); for (let i = 0; i < 64; i++) spRaw[64 + i] = tmp[i]; }
    return spRaw;
  }
  // Composite a cluster's sprites into one RGBA texture.
  const clusterTexPool = Array.from({ length: 24 }, () => mkTex());
  function compositeCluster(box, objSize, OBP0, OBP1, texObj) {
    const W = box.x1 - box.x0, H = box.y1 - box.y0, px = new Uint8Array(W * H * 4);
    for (const s of box.items) {
      const fY = s.attr & 0x40, fX = s.attr & 0x20, opal = (s.attr & 0x10) ? OBP1 : OBP0;
      const sp = spriteRaw(s, objSize);
      for (let row = 0; row < objSize; row++) for (let col = 0; col < 8; col++) {
        const sr = fY ? (objSize - 1 - row) : row, sc = fX ? (7 - col) : col;
        const ci = sp[sr * 8 + sc]; if (ci === 0) continue;
        const dx = (s.sx - box.x0) + col, dy = (s.sy - box.y0) + row;
        if (dx < 0 || dx >= W || dy < 0 || dy >= H) continue;
        const oo = (dy * W + dx) * 4, v = SHADE[pal(opal, ci)];
        px[oo] = px[oo+1] = px[oo+2] = v; px[oo+3] = 255;
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, texObj);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { W, H };
  }

  function frame() {
    if (!running || !core) return;
    const n = effSpeed();
    for (let i = 0; i < n; i++) core.run();
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
    gl.clearColor(0.02, 0.03, 0.05, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // Camera: pitch over the ground. tilt 0 = straight down (flat).
    const th = tiltDeg * Math.PI / 180;
    const ctr = [80, 0, 72], up = [0, 0, -1];
    const eye = [80, CAM_DIST * Math.cos(th), 72 + CAM_DIST * Math.sin(th)];
    const view = lookAt(eye, ctr, up);
    setMVP(mul4(persp(FOV, GBW / GBH, 1, 2000), view));
    const fwd = norm(sub(ctr, eye)), right = norm(cross(fwd, up)), camUp = cross(right, fwd);

    // --- ground plane (BG), depth-written ---
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.disable(gl.BLEND);
    if (bgOn) {
      decodeMap(bgMapOff, signed, BGP, bgBuf);
      gl.bindTexture(gl.TEXTURE_2D, bgTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 256, 0, gl.RGBA, gl.UNSIGNED_BYTE, bgBuf);
      const u0 = SCX/256, v0 = SCY/256, u1 = (SCX+GBW)/256, v1 = (SCY+GBH)/256;
      drawQuad(bgTex, [[0,0,0],[GBW,0,0],[GBW,0,GBH],[0,0,GBH]],
        [[u0,v0],[u1,v0],[u1,v1],[u0,v1]]);
    }

    // --- sprites: shadows then standing slabs ---
    if (objOn && !window.__groundOnly && !window.__skipSprites) {
      const boxes = readSpriteClusters(objSize, OBP0, OBP1)
        .sort((a, b) => a.y1 - b.y1);                 // far (small y) first for clean overlap
      const metas = boxes.map((box, i) => ({ box, tex: clusterTexPool[i % clusterTexPool.length],
        dim: compositeCluster(box, objSize, OBP0, OBP1, clusterTexPool[i % clusterTexPool.length]) }));

      // shadows (blended, no depth write)
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
      for (const { box } of metas) {
        const cx = (box.x0 + box.x1) / 2, cz = box.y1 - 1, hx = (box.x1 - box.x0) * 0.6, hz = (box.y1 - box.y0) * 0.22 + 2;
        drawQuad(shadowTex, [[cx-hx,0.3,cz-hz],[cx+hx,0.3,cz-hz],[cx+hx,0.3,cz+hz],[cx-hx,0.3,cz+hz]],
          [[0,0],[1,0],[1,1],[0,1]], { alpha: 1 });
      }
      // standing slabs (keyed, depth write). Slight extrusion: a darker back
      // quad offset away from the camera gives the sprite real thickness.
      gl.disable(gl.BLEND); gl.depthMask(true);
      for (const { box, tex, dim } of metas) {
        const w = dim.W, h = dim.H, cx = (box.x0 + box.x1) / 2, cz = box.y1;
        const baseL = [cx - w/2*right[0], 0, cz - w/2*right[2]];
        const baseR = [cx + w/2*right[0], 0, cz + w/2*right[2]];
        const back = [-fwd[0]*SLAB_DEPTH, -fwd[1]*SLAB_DEPTH, -fwd[2]*SLAB_DEPTH];
        const upH = [camUp[0]*h, camUp[1]*h, camUp[2]*h];
        const bl = [baseL[0], 0, baseL[2]], br = [baseR[0], 0, baseR[2]];
        const tl = [bl[0]+upH[0], upH[1], bl[2]+upH[2]], tr = [br[0]+upH[0], upH[1], br[2]+upH[2]];
        // back slab (thickness) — darker, drawn first
        const bl2 = [bl[0]+back[0], bl[1]+back[1], bl[2]+back[2]], br2 = [br[0]+back[0], br[1]+back[1], br[2]+back[2]];
        const tl2 = [tl[0]+back[0], tl[1]+back[1], tl[2]+back[2]], tr2 = [tr[0]+back[0], tr[1]+back[1], tr[2]+back[2]];
        drawQuad(tex, [tl2, tr2, br2, bl2], [[0,0],[1,0],[1,1],[0,1]], { keyed: true, tint: [0.45,0.45,0.5] });
        // side connectors (give the slab visible edges)
        drawQuad(whiteTex, [tl2, tl, bl, bl2], [[0,0],[1,0],[1,1],[0,1]], { keyed: false, tint: [0.3,0.3,0.34] });
        drawQuad(whiteTex, [tr, tr2, br2, br], [[0,0],[1,0],[1,1],[0,1]], { keyed: false, tint: [0.3,0.3,0.34] });
        // front face (the sprite)
        drawQuad(tex, [tl, tr, br, bl], [[0,0],[1,0],[1,1],[0,1]], { keyed: true });
      }
    }

    // --- window / HUD, flat in screen space, on top ---
    // The Gen1 overworld keeps the window enabled and raster-positions it, so a
    // single-snapshot read sees WY=0 (full screen). Drawn flat that would cover
    // the tilted ground, so when tilted we skip a window that reaches the upper
    // screen (WY<72) and keep only genuine bottom text boxes. Flat mode (tilt 0)
    // draws every window at full fidelity.
    const winFlattens = tiltDeg > 0 && WY < 72;
    if (winOn && !winFlattens && !window.__groundOnly && !window.__skipWindow && WX <= 166 && WY <= GBH - 1) {
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.depthMask(false);
      setMVP(orthoGB);
      decodeMap(winMapOff, signed, BGP, winBuf);
      gl.bindTexture(gl.TEXTURE_2D, winTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 256, 0, gl.RGBA, gl.UNSIGNED_BYTE, winBuf);
      const x0 = Math.max(0, WX - 7), y0 = Math.max(0, WY);
      drawQuad(winTex, [[x0,y0,0],[GBW,y0,0],[GBW,GBH,0],[x0,GBH,0]],
        [[0,0],[(GBW-x0)/256,0],[(GBW-x0)/256,(GBH-y0)/256],[0,(GBH-y0)/256]]);
    }
  }

  // ---- viewport / fps -------------------------------------------------------
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const scale = Math.min(canvas.width / GBW, canvas.height / GBH);
    const vw = Math.floor(GBW * scale), vh = Math.floor(GBH * scale);
    gl.viewport((canvas.width - vw) >> 1, (canvas.height - vh) >> 1, vw, vh);
  }
  let fpsT = 0, fpsN = 0; const fpsEl = document.getElementById('fps');
  function tickFPS() { fpsN++; const now = performance.now();
    if (now - fpsT > 500) { const s = effSpeed();
      fpsEl.textContent = Math.round(fpsN*1000/(now-fpsT)) + ' fps' + (s>1?'  ·  '+s+'×':'') + '  ·  tilt '+tiltDeg+'°';
      fpsT = now; fpsN = 0; } }

  // ---- turbo / tilt controls ------------------------------------------------
  const speedBtn = document.getElementById('speed');
  function setSpeed(v) { baseSpeed = Math.max(1, Math.min(3, v|0)); if (speedBtn) speedBtn.textContent = baseSpeed + '×'; }
  if (speedBtn) speedBtn.addEventListener('click', () => setSpeed(baseSpeed % 3 + 1));
  window.__setSpeed = setSpeed; window.__getSpeed = effSpeed;
  const tiltBtn = document.getElementById('tilt');
  function cycleTilt() { const i = (TILT_LEVELS.indexOf(tiltDeg) + 1) % TILT_LEVELS.length; setTilt(TILT_LEVELS[i]); }
  function setTilt(d) { tiltDeg = d; if (tiltBtn) tiltBtn.textContent = 'tilt ' + d + '°'; }
  if (tiltBtn) tiltBtn.addEventListener('click', cycleTilt);
  window.__setTilt = setTilt;

  // ---- input ----------------------------------------------------------------
  const KEY = { ArrowRight: 0, ArrowLeft: 1, ArrowUp: 2, ArrowDown: 3, z: 4, x: 5, Shift: 6, Enter: 7 };
  addEventListener('keydown', (e) => {
    if (e.key === '1' || e.key === '2' || e.key === '3') { setSpeed(+e.key); e.preventDefault(); return; }
    if (e.key === 't' || e.key === 'T') { cycleTilt(); e.preventDefault(); return; }
    if (e.key === 'Tab' || e.key === ' ') { turboHeld = true; e.preventDefault(); return; }
    const b = KEY[e.key]; if (b !== undefined && core) { core.JoyPadEvent(b, true); e.preventDefault(); }
  });
  addEventListener('keyup', (e) => {
    if (e.key === 'Tab' || e.key === ' ') { turboHeld = false; e.preventDefault(); return; }
    const b = KEY[e.key]; if (b !== undefined && core) { core.JoyPadEvent(b, false); e.preventDefault(); }
  });

  // ---- ROM load / boot + test hooks -----------------------------------------
  window.__loadROM = (bytes) => {
    core = new window.GameBoyCore([...bytes]);
    core.openMBC = () => [];
    core.start(); core.stopEmulator &= 1; core.iterations = 0;
    running = true; window.__core = core;
    if (window.__auto !== false) requestAnimationFrame(frame);
  };
  window.__stepFrames = (k) => { for (let i = 0; i < k; i++) core.run(); };
  window.__renderOnce = () => renderScene();
  window.__press = (bit, downFrames = 6, gapFrames = 8) => {
    for (let i = 0; i < downFrames; i++) { core.JoyPadEvent(bit, true); core.run(); }
    core.JoyPadEvent(bit, false); for (let i = 0; i < gapFrames; i++) core.run();
  };
  window.__debugMVP = () => {
    const th = tiltDeg * Math.PI / 180, ctr = [80,0,72], up = [0,0,-1];
    const eye = [80, CAM_DIST*Math.cos(th), 72 + CAM_DIST*Math.sin(th)];
    const m = mul4(persp(FOV, GBW/GBH, 1, 2000), lookAt(eye, ctr, up));
    const pr = (p) => { const x=m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12], y=m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13], w=m[3]*p[0]+m[7]*p[1]+m[11]*p[2]+m[15];
      return [(x/w).toFixed(3), (y/w).toFixed(3)]; };
    return { tilt: tiltDeg, nearC: pr([80,0,144]), farC: pr([80,0,0]) };
  };
  window.__sampleAt = (fx, fy) => {                // read the real framebuffer (gl y is bottom-up)
    const vp = gl.getParameter(gl.VIEWPORT), buf = new Uint8Array(4);
    const px = (vp[0] + vp[2] * fx) | 0, py = (vp[1] + vp[3] * fy) | 0;
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return [...buf];
  };
  window.__kick = () => requestAnimationFrame(frame);  // start the rAF loop (forces paints)
  window.__engineReady = true;
})();
