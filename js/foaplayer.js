/*! foaplayer.js - drag-to-look 360-degree video player with first-order-ambisonics (FOA) binaural audio.
 *  Video: an equirectangular MP4 rendered through one shared WebGL context (yaw/pitch by mouse or touch drag).
 *  Audio: a 4-channel ACN/SN3D WAV decoded by the browser and rendered binaurally with Omnitone
 *  (Google, Apache-2.0, js/omnitone.min.js). The sound field is counter-rotated with the view, so a source
 *  stays attached to the object on screen while you look around. Only one player plays at a time.
 */
(function (global) {
  'use strict';
  var DEG = Math.PI / 180;
  var VS = 'attribute vec2 p;varying vec2 v;void main(){v=p;gl_Position=vec4(p,0.0,1.0);}';
  var FS = 'precision mediump float;varying vec2 v;uniform sampler2D tex;uniform float yaw,pitch,th,aspect;' +
    'void main(){vec3 d=normalize(vec3(v.x*th*aspect,v.y*th,1.0));' +
    'float cp=cos(pitch),sp=sin(pitch);d=vec3(d.x,cp*d.y+sp*d.z,-sp*d.y+cp*d.z);' +
    'float cy=cos(yaw),sy=sin(yaw);d=vec3(cy*d.x+sy*d.z,d.y,-sy*d.x+cy*d.z);' +
    'float lon=atan(d.x,d.z);float lat=asin(clamp(d.y,-1.0,1.0));' +
    'gl_FragColor=texture2D(tex,vec2(0.5+lon/6.2831853,0.5-lat/3.1415926));}';

  // Rotation handed to Omnitone (3x3, column-major): the view matrix Rx(-pitch) * Ry(yaw) in WebGL axes
  // (x right, y up, z back). yaw > 0 = looking to the right, pitch > 0 = looking up. Verified numerically with
  // Omnitone's FOARotator: a source on the left ends up behind after yaw +90, a source in front ends up below
  // after pitch +90, and the zenith ends up in front after pitch +90.
  var CONV = { yawSign: 1, pitchSign: 1 };
  function rotationMatrix(yaw, pitch) {
    var a = CONV.yawSign * yaw, b = CONV.pitchSign * pitch;
    var ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
    return [ca, -sb * sa, -cb * sa, 0, cb, -sb, sa, sb * ca, cb * ca];
  }

  var shared = null, players = [], current = null, rafId = 0, audioCtx = null;

  function getCtx() {
    if (!audioCtx) audioCtx = new (global.AudioContext || global.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }
  function wrap(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a <= -Math.PI) a += 2 * Math.PI; return a; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function getShared() {
    if (shared) return shared;
    var canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 9;
    var gl = canvas.getContext('webgl', { antialias: false, preserveDrawingBuffer: false, premultipliedAlpha: false });
    if (!gl) { shared = { gl: null }; return shared; }
    function sh(type, src) {
      var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }
    var prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog); gl.useProgram(prog);
    var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    shared = { canvas: canvas, gl: gl, u: {
      yaw: gl.getUniformLocation(prog, 'yaw'), pitch: gl.getUniformLocation(prog, 'pitch'),
      th: gl.getUniformLocation(prog, 'th'), aspect: gl.getUniformLocation(prog, 'aspect') } };
    return shared;
  }
  function makeTexture(gl) {
    var t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([16, 16, 20]));
    return t;
  }
  function requestDraw() { if (!rafId) rafId = global.requestAnimationFrame(tick); }
  function tick() {
    rafId = 0; var again = false;
    for (var i = 0; i < players.length; i++) {
      var p = players[i]; p.draw();
      if (p.playing || p.dragging) again = true;
    }
    if (again) requestDraw();
  }

  function FOAPlayer(el, opts) {
    this.el = el; this.opts = opts || {};
    this.yaw0 = (this.opts.yaw || 0) * DEG; this.pitch0 = (this.opts.pitch || 0) * DEG;
    this.yaw = this.yaw0; this.pitch = this.pitch0; this.fov = (this.opts.fov || 95) * DEG;
    this.playing = false; this.dragging = false; this.dirty = true; this.hasFrame = false; this.audioReady = null;
    el.classList.add('foa-player');
    el.innerHTML = '<canvas></canvas>' +
      '<button class="foa-play" type="button" aria-label="Play">&#9654;</button>' +
      '<div class="foa-hint">drag to look around</div><div class="foa-status"></div>' +
      '<div class="foa-hud"><span class="foa-compass">yaw 0&deg;</span><button class="foa-reset" type="button">reset view</button></div>';
    this.canvas = el.querySelector('canvas'); this.ctx2d = this.canvas.getContext('2d');
    this.playBtn = el.querySelector('.foa-play'); this.compass = el.querySelector('.foa-compass'); this.status = el.querySelector('.foa-status');
    this.video = document.createElement('video');
    this.video.muted = true; this.video.playsInline = true; this.video.preload = 'metadata';
    this.video.setAttribute('muted', ''); this.video.setAttribute('playsinline', '');
    this.video.src = this.opts.video; el.appendChild(this.video);
    var s = getShared();
    if (s.gl) this.tex = makeTexture(s.gl); else this.status.textContent = 'WebGL is not available in this browser.';
    if (this.opts.poster) this.loadPoster(this.opts.poster);
    this.bind(); players.push(this); this.resize(); requestDraw();
  }

  FOAPlayer.prototype.loadPoster = function (src) {
    var img = new Image(), self = this;
    img.onload = function () { if (!self.hasFrame) { self.upload(img); requestDraw(); } };
    img.src = src;
  };
  FOAPlayer.prototype.upload = function (source) {
    var gl = getShared().gl; if (!gl || !this.tex) return;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source); } catch (e) { /* frame not ready */ }
    this.dirty = true;
  };
  FOAPlayer.prototype.resize = function () {
    var r = this.el.getBoundingClientRect(), dpr = Math.min(global.devicePixelRatio || 1, 1.5);
    var w = Math.max(2, Math.round(r.width * dpr)), h = Math.max(2, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; this.dirty = true; }
  };
  FOAPlayer.prototype.draw = function () {
    var s = getShared(), gl = s.gl; if (!gl || !this.tex) return;
    if (this.playing && this.video.readyState >= 2) { this.upload(this.video); this.hasFrame = true; }
    if (!this.dirty) return;
    this.resize();
    var w = this.canvas.width, h = this.canvas.height;
    if (s.canvas.width !== w || s.canvas.height !== h) { s.canvas.width = w; s.canvas.height = h; }
    gl.viewport(0, 0, w, h); gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1f(s.u.yaw, this.yaw); gl.uniform1f(s.u.pitch, this.pitch);
    gl.uniform1f(s.u.th, Math.tan(this.fov / 2) * h / w); gl.uniform1f(s.u.aspect, w / h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.ctx2d.drawImage(s.canvas, 0, 0);
    this.dirty = false;
    this.compass.textContent = 'yaw ' + Math.round(this.yaw / DEG) + '°' +
      (Math.abs(this.pitch) >= 0.5 * DEG ? ', pitch ' + Math.round(this.pitch / DEG) + '°' : '');
    if (this.renderer) this.renderer.setRotationMatrix3(rotationMatrix(this.yaw, this.pitch));
  };

  FOAPlayer.prototype.bind = function () {
    var self = this, c = this.canvas, last = null;
    function pt(e) { return { x: e.clientX, y: e.clientY }; }
    c.addEventListener('pointerdown', function (e) {
      last = pt(e); self.dragging = true; self.moved = false; self.el.classList.add('dragging');
      if (c.setPointerCapture) { try { c.setPointerCapture(e.pointerId); } catch (err) {} }
      e.preventDefault(); requestDraw();
    });
    c.addEventListener('pointermove', function (e) {
      if (!self.dragging || !last) return;
      var p = pt(e), dx = p.x - last.x, dy = p.y - last.y; last = p;
      if (Math.abs(dx) + Math.abs(dy) > 2) { self.moved = true; self.el.classList.add('moved'); }
      var scale = self.fov / Math.max(1, c.clientWidth);   // radians per CSS pixel
      self.yaw = wrap(self.yaw - dx * scale);
      self.pitch = clamp(self.pitch + dy * scale, -80 * DEG, 80 * DEG);
      self.dirty = true; requestDraw();
    });
    function up() { self.dragging = false; self.el.classList.remove('dragging'); }
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    c.addEventListener('click', function () { if (!self.moved) self.toggle(); self.moved = false; });
    this.playBtn.addEventListener('click', function (e) { e.stopPropagation(); self.toggle(); });
    this.el.querySelector('.foa-reset').addEventListener('click', function (e) {
      e.stopPropagation(); self.yaw = self.yaw0; self.pitch = self.pitch0; self.dirty = true; requestDraw();
    });
    this.video.addEventListener('ended', function () {
      if (self.playing) { self.video.currentTime = 0; self.video.play(); self.startAudio(0); }
    });
    this.video.addEventListener('error', function () { self.status.textContent = 'video failed to load'; self.pause(); });
    global.addEventListener('resize', function () { self.resize(); self.dirty = true; requestDraw(); });
  };

  FOAPlayer.prototype.toggle = function () { if (this.playing) this.pause(); else this.play(); };
  FOAPlayer.prototype.play = function () {
    var self = this;
    if (current && current !== this) current.pause();
    current = this; this.playing = true; this.el.classList.add('playing'); this.playBtn.innerHTML = '&#10074;&#10074;';
    this.status.textContent = 'loading…';
    getCtx();
    this.ensureAudio().then(function () {
      if (!self.playing) return;
      self.status.textContent = '';
      var p = self.video.play();
      if (p && p.then) {
        p.then(function () { if (self.playing) self.startAudio(self.video.currentTime); requestDraw(); })
         .catch(function (err) { self.status.textContent = 'cannot play video: ' + err.message; self.pause(); });
      } else { self.startAudio(self.video.currentTime); requestDraw(); }
    }).catch(function (err) {
      self.status.textContent = 'audio failed: ' + (err && err.message ? err.message : err);
      self.playing = false; self.el.classList.remove('playing'); self.playBtn.innerHTML = '&#9654;';
    });
  };
  FOAPlayer.prototype.pause = function () {
    this.playing = false; this.el.classList.remove('playing'); this.playBtn.innerHTML = '&#9654;';
    this.video.pause(); this.stopAudio();
    if (current === this) current = null;
  };
  FOAPlayer.prototype.ensureAudio = function () {
    var self = this;
    if (this.audioReady) return this.audioReady;
    var ctx = getCtx();
    this.audioReady = fetch(this.opts.foa)
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + self.opts.foa); return r.arrayBuffer(); })
      .then(function (ab) { return ctx.decodeAudioData(ab); })
      .then(function (buf) {
        if (buf.numberOfChannels !== 4) throw new Error('expected a 4-channel FOA file, got ' + buf.numberOfChannels);
        self.buffer = buf;
        self.renderer = global.Omnitone.createFOARenderer(ctx, { renderingMode: 'ambisonic' });
        return self.renderer.initialize();
      })
      .then(function () {
        self.gain = ctx.createGain(); self.gain.gain.value = self.opts.gain || 1.0;
        self.renderer.output.connect(self.gain); self.gain.connect(ctx.destination);
        self.renderer.setRotationMatrix3(rotationMatrix(self.yaw, self.pitch));
      });
    return this.audioReady;
  };
  FOAPlayer.prototype.startAudio = function (offset) {
    this.stopAudio();
    var ctx = getCtx(), src = ctx.createBufferSource();
    src.buffer = this.buffer; src.connect(this.renderer.input);
    src.start(0, clamp(offset || 0, 0, Math.max(0, this.buffer.duration - 0.05)));
    this.source = src;
  };
  FOAPlayer.prototype.stopAudio = function () {
    if (this.source) { try { this.source.stop(); } catch (e) {} try { this.source.disconnect(); } catch (e) {} this.source = null; }
  };

  FOAPlayer.rotationMatrix = rotationMatrix;
  FOAPlayer.convention = CONV;
  FOAPlayer.players = players;
  FOAPlayer.audioContext = getCtx;
  global.FOAPlayer = FOAPlayer;
})(window);
