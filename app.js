'use strict';
(() => {
  const CFG = window.CC_CONFIG || {};
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const MODES = ['photo', 'video', 'scan', 'text', 'qr', 'read'];
  const LABELS = { photo: 'Photo', video: 'Video', scan: 'Scan', text: 'Text', read: 'Read', qr: 'QR' };
  const KINDS = ['photo', 'video', 'scan', 'text'];
  const ROOT = 'Custom Camera';
  const FOLDER_NAMES = { photo: 'Photos', video: 'Videos', scan: 'Scans', text: 'Texts' };
  const PREFIX = { photo: 'IMG', video: 'VID', scan: 'SCAN', text: 'TXT' };
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const CV_URL = 'https://docs.opencv.org/4.9.0/opencv.js';
  const JSQR_URL = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
  const AI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
  const store = {
    get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { } },
    del: k => { try { localStorage.removeItem(k); } catch { } },
  };

  /* ---------- helpers ---------- */
  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid);
    return el;
  }
  const icon = (id, cls = 'ic') => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('class', cls); const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', '#' + id); s.append(u); return s; };
  const scripts = {};
  function loadScript(src) {
    return scripts[src] ||= new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.async = true; s.onload = res;
      s.onerror = () => { delete scripts[src]; rej(new Error('script ' + src)); };
      document.head.append(s);
    });
  }
  let toastT;
  function toast(msg, ms = 2800) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms);
  }
  const pad = n => String(n).padStart(2, '0');
  function stamp(d = new Date()) {
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${String(d.getMilliseconds()).padStart(3, '0')}`;
  }
  const fmtTime = ms => { const s = Math.floor(ms / 1000), hh = Math.floor(s / 3600), mm = Math.floor(s % 3600 / 60), ss = s % 60; return (hh ? hh + ':' + pad(mm) : pad(mm)) + ':' + pad(ss); };
  const fmtDate = ms => new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const toBlob = (c, type = 'image/jpeg', q = 0.92) => new Promise(r => c.toBlob(r, type, q));
  const extFor = t => /mp4/.test(t) ? 'mp4' : /webm/.test(t) ? 'webm' : /pdf/.test(t) ? 'pdf' : /png/.test(t) ? 'png' : 'jpg';
  const blobToB64 = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(b); });
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ---------- IndexedDB ---------- */
  const idb = (() => {
    let p;
    const open = () => p ||= new Promise((res, rej) => {
      const r = indexedDB.open('custom-camera', 2);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('queue')) d.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
        if (!d.objectStoreNames.contains('thumbs')) d.createObjectStore('thumbs');
        if (!d.objectStoreNames.contains('qrlog')) d.createObjectStore('qrlog', { keyPath: 'id', autoIncrement: true });
        if (!d.objectStoreNames.contains('texts')) d.createObjectStore('texts');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    async function tx(s, mode, fn) {
      const d = await open();
      return new Promise((res, rej) => {
        const t = d.transaction(s, mode);
        const rq = fn(t.objectStore(s));
        t.oncomplete = () => res(rq && rq.result);
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error);
      });
    }
    return {
      add: (s, v) => tx(s, 'readwrite', o => o.add(v)),
      put: (s, v, k) => tx(s, 'readwrite', o => k === undefined ? o.put(v) : o.put(v, k)),
      get: (s, k) => tx(s, 'readonly', o => o.get(k)),
      all: s => tx(s, 'readonly', o => o.getAll()),
      del: (s, k) => tx(s, 'readwrite', o => o.delete(k)),
      count: s => tx(s, 'readonly', o => o.count()),
    };
  })();

  /* ---------- layers / back button ---------- */
  const layers = [];
  let ignorePop = 0;
  window.addEventListener('popstate', () => {
    if (ignorePop > 0) { ignorePop--; return; }
    const l = layers.pop();
    if (l === 'viewer') hideViewer();
    else if (l === 'gallery') hideGallery();
    else if (l === 'qr') $('#qrSheet').hidden = true;
    else if (l === 'text') $('#textSheet').hidden = true;
    else if (l === 'keys') $('#keys').hidden = true;
    else if (l === 'rec') finishRec(true);
  });
  function pushLayer(name) { layers.push(name); history.pushState({ l: name }, ''); }
  function popLayer(name) { const i = layers.lastIndexOf(name); if (i >= 0) { layers.splice(i, 1); ignorePop++; history.back(); } }

  /* ---------- theme ---------- */
  function applyTheme(t) {
    document.documentElement.dataset.theme = t; store.set('cc_theme', t);
    $('#themeUse').setAttribute('href', t === 'dark' ? '#i-sun' : '#i-moon');
  }
  applyTheme(store.get('cc_theme', matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));

  /* ---------- Google Drive ---------- */
  let needReconnect = false;
  const Drive = {
    token: null, exp: 0, client: null,
    configured() { return !!CFG.GOOGLE_CLIENT_ID && !CFG.GOOGLE_CLIENT_ID.startsWith('PASTE'); },
    connected() { return store.get('cc_drive') === '1'; },
    async init() {
      await loadScript('https://accounts.google.com/gsi/client');
      this.client = google.accounts.oauth2.initTokenClient({ client_id: CFG.GOOGLE_CLIENT_ID, scope: SCOPE, callback: () => { } });
    },
    getToken(interactive = false) {
      if (this.token && Date.now() < this.exp - 60000) return Promise.resolve(this.token);
      return new Promise(async (res, rej) => {
        try {
          if (!this.configured()) throw new Error('not configured');
          if (!this.client) await this.init();
          this.client.callback = r => {
            if (r.error) return rej(new Error('auth ' + r.error));
            this.token = r.access_token; this.exp = Date.now() + (+r.expires_in || 3600) * 1000;
            store.set('cc_drive', '1'); needReconnect = false; res(this.token);
          };
          this.client.error_callback = e => rej(new Error('auth ' + (e && e.type || 'failed')));
          this.client.requestAccessToken({ prompt: interactive && !this.connected() ? 'consent' : '' });
        } catch (e) { rej(e); }
      });
    },
    async api(path, opt = {}, retry = true) {
      const tok = await this.getToken();
      const r = await fetch('https://www.googleapis.com' + path, { ...opt, headers: { ...(opt.headers || {}), Authorization: 'Bearer ' + tok } });
      if (r.status === 401 && retry) { this.token = null; return this.api(path, opt, false); }
      if (!r.ok) { const e = new Error('drive ' + r.status); e.status = r.status; throw e; }
      return opt.raw ? r : r.json();
    },
    async findOrCreate(name, parent) {
      const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false and '${parent}' in parents`;
      const r = await this.api('/drive/v3/files?fields=files(id)&q=' + encodeURIComponent(q));
      if (r.files.length) return r.files[0].id;
      const c = await this.api('/drive/v3/files?fields=id', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] })
      });
      return c.id;
    },
    async folders() {
      let f = null;
      try { f = JSON.parse(store.get('cc_folders', 'null')); } catch { }
      if (f && f.root && KINDS.every(k => f[k])) return f;
      f = f && f.root ? f : { root: await this.findOrCreate(ROOT, 'root') };
      for (const k of KINDS) if (!f[k]) f[k] = await this.findOrCreate(FOLDER_NAMES[k], f.root);
      store.set('cc_folders', JSON.stringify(f));
      return f;
    },
    async withFolder(kind, fn) {
      try { return await fn((await this.folders())[kind]); }
      catch (e) {
        if (e.status === 404) { store.del('cc_folders'); return fn((await this.folders())[kind]); }
        throw e;
      }
    },
    async upload(kind, name, blob, meta = {}) {
      return this.withFolder(kind, async fid => {
        const tok = await this.getToken();
        const type = blob.type || 'application/octet-stream';
        const body = { name, parents: [fid] };
        if (meta.desc) body.description = String(meta.desc).slice(0, 3800);
        if (meta.fav) body.appProperties = { fav: '1' };
        const init = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': type },
          body: JSON.stringify(body)
        });
        if (!init.ok) { const e = new Error('init ' + init.status); e.status = init.status; throw e; }
        const put = await fetch(init.headers.get('Location'), { method: 'PUT', headers: { 'Content-Type': type }, body: blob });
        if (!put.ok) throw new Error('put ' + put.status);
        return put.json();
      });
    },
    async list(kind) {
      return this.withFolder(kind, async fid => {
        let out = [], pt = '';
        do {
          const q = `'${fid}' in parents and trashed=false`;
          const r = await this.api(`/drive/v3/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,name,mimeType,createdTime,thumbnailLink,description,appProperties)&orderBy=createdTime desc&pageSize=200${pt ? '&pageToken=' + pt : ''}`);
          out.push(...r.files.map(f => ({ id: f.id, name: f.name, kind, mime: f.mimeType, created: Date.parse(f.createdTime), thumb: f.thumbnailLink, desc: f.description || '', fav: !!(f.appProperties && f.appProperties.fav === '1') })));
          pt = r.nextPageToken;
        } while (pt && out.length < 2000);
        return out;
      });
    },
    async media(id) { const r = await this.api('/drive/v3/files/' + id + '?alt=media', { raw: true }); return r.blob(); },
    trash(id) { return this.api('/drive/v3/files/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) }); },
    setFav(id, on) { return this.api('/drive/v3/files/' + id + '?fields=id', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appProperties: { fav: on ? '1' : null } }) }); },
    overwrite(id, blob) { return this.api('/upload/drive/v3/files/' + id + '?uploadType=media&fields=id', { method: 'PATCH', headers: { 'Content-Type': blob.type || 'image/jpeg' }, body: blob }); },
  };
  const isAuthErr = e => /auth|popup|interaction|access_denied|not configured|401|403/i.test(String(e && e.message));

  /* ---------- upload queue ---------- */
  let flushing = false;
  async function flushQueue() {
    if (flushing || !navigator.onLine || !Drive.connected()) return;
    flushing = true;
    try {
      const items = await idb.all('queue');
      for (const it of items) {
        await Drive.upload(it.kind, it.name, it.blob, { desc: it.desc, fav: it.fav });
        await idb.del('queue', it.id);
      }
      if (items.length) { toast(items.length === 1 ? 'Saved to Drive' : items.length + ' files saved to Drive'); if (!$('#gallery').hidden) loadGallery(); }
    } catch (e) {
      console.warn('upload', e);
      if (isAuthErr(e)) needReconnect = true;
    } finally { flushing = false; updateCloudChip(); }
  }
  async function updateCloudChip() {
    const n = await idb.count('queue').catch(() => 0);
    const ok = Drive.connected() && !needReconnect;
    const c = $('#cloud');
    c.dataset.state = ok ? (n ? 'wait' : 'ok') : 'off';
    const label = needReconnect ? 'Reconnect Google Drive' : !Drive.connected() ? 'Connect Google Drive' : n ? n + ' waiting to upload' : 'Google Drive connected';
    c.setAttribute('aria-label', label); c.title = label;
  }
  async function connectDrive() {
    if (!Drive.configured()) { toast('Google sign-in is not set up yet'); return false; }
    try {
      await Drive.getToken(true); await Drive.folders();
      toast('Google Drive connected'); updateCloudChip(); renderOnboard(); flushQueue();
      return true;
    } catch (e) { console.warn(e); toast('Could not connect to Google'); return false; }
  }
  async function saveItem(kind, blob, thumb, extra = {}) {
    const name = `${PREFIX[kind]}_${stamp()}.${extFor(blob.type)}`;
    await idb.add('queue', { kind, name, blob, created: Date.now(), fav: false, desc: extra.desc || '' });
    if (thumb) { await idb.put('thumbs', thumb, name); await idb.put('thumbs', thumb, '__latest'); setLatest(thumb); }
    pulseThumb(); updateCloudChip(); flushQueue();
    return name;
  }
  function pulseThumb() { const t = $('#thumb'); t.classList.remove('pulse'); void t.offsetWidth; t.classList.add('pulse'); }
  let latestURL = null;
  function setLatest(blob) {
    if (latestURL) URL.revokeObjectURL(latestURL);
    latestURL = URL.createObjectURL(blob);
    $('#thumbImg').src = latestURL; $('#thumb').classList.add('has');
  }

  /* ---------- rotation sensor (works even when Android auto-rotate is off) ---------- */
  let rot = 0;
  function startSensor() {
    addEventListener('devicemotion', e => {
      const g = e.accelerationIncludingGravity;
      if (!g || g.x == null || g.y == null) return;
      if (Math.abs(g.z || 0) > 8.2) return;
      let a = Math.round(Math.atan2(g.x, g.y) / (Math.PI / 2)) * 90;
      if (a === -180) a = 180;
      if (a !== rot) { rot = a; document.documentElement.style.setProperty('--rot', a + 'deg'); }
    }, { passive: true });
  }
  function drawRot(src, sw, sh, a, crop) {
    const cx = crop || { x: 0, y: 0, w: sw, h: sh };
    const side = a === 90 || a === -90;
    const ow = side ? cx.h : cx.w, oh = side ? cx.w : cx.h;
    const c = document.createElement('canvas'); c.width = Math.round(ow); c.height = Math.round(oh);
    const x = c.getContext('2d');
    x.translate(c.width / 2, c.height / 2); x.rotate(a * Math.PI / 180);
    x.drawImage(src, cx.x, cx.y, cx.w, cx.h, -cx.w / 2, -cx.h / 2, cx.w, cx.h);
    return c;
  }
  function stampDate(c) {
    const d = new Date();
    const t = `${d.getDate()} ${d.toLocaleString('en', { month: 'long' })} ${d.getFullYear()} · ${d.toLocaleString('en', { weekday: 'short' }).toUpperCase()}`;
    const x = c.getContext('2d'), s = Math.max(18, Math.round(Math.max(c.width, c.height) * 0.016));
    x.font = `600 ${s}px ui-sans-serif, system-ui, sans-serif`; x.textAlign = 'right'; x.textBaseline = 'bottom';
    x.shadowColor = 'rgba(0,0,0,.65)'; x.shadowBlur = s * 0.35; x.fillStyle = 'rgba(255,255,255,.92)';
    x.fillText(t, c.width - s * 0.9, c.height - s * 0.8);
  }

  /* ---------- camera ---------- */
  const vf = $('#viewfinder');
  const ov = $('#overlay'), octx = ov.getContext('2d');
  let stream = null, track = null, imageCapture = null, photoOpts = null, busy = false, facing = 'environment', torchOn = false;
  let zoom = 1, zoomMode = 'none', zRange = { min: 1, max: 4 };

  function setBusy(on) { busy = on; document.body.classList.toggle('busy', on); }

  async function startCamera() {
    stopCamera();
    const base = { facingMode: { ideal: facing }, width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 } };
    try { stream = await navigator.mediaDevices.getUserMedia({ video: base, audio: false }); }
    catch (e1) {
      try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: false }); }
      catch (e2) { try { stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); } catch (e3) { $('#camError').hidden = false; return false; } }
    }
    $('#camError').hidden = true;
    track = stream.getVideoTracks()[0];
    vf.srcObject = stream;
    await vf.play().catch(() => { });
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    const adv = {};
    if (caps.focusMode && caps.focusMode.includes('continuous')) adv.focusMode = 'continuous';
    if (caps.exposureMode && caps.exposureMode.includes('continuous')) adv.exposureMode = 'continuous';
    if (caps.whiteBalanceMode && caps.whiteBalanceMode.includes('continuous')) adv.whiteBalanceMode = 'continuous';
    if (Object.keys(adv).length) await track.applyConstraints({ advanced: [adv] }).catch(() => { });
    // zoom
    if (caps.zoom && caps.zoom.max > caps.zoom.min) { zoomMode = 'hw'; zRange = { min: caps.zoom.min, max: Math.min(caps.zoom.max, 12) }; zoom = zRange.min; }
    else { zoomMode = 'digital'; zRange = { min: 1, max: 4 }; zoom = 1; }
    vf.style.transform = '';
    // torch
    torchOn = false;
    $('#flashBtn').hidden = !caps.torch;
    $('#flashBtn').classList.remove('on');
    imageCapture = null; photoOpts = null;
    if ('ImageCapture' in window) {
      try {
        imageCapture = new ImageCapture(track);
        const pc = await imageCapture.getPhotoCapabilities();
        if (pc.imageWidth && pc.imageWidth.max) photoOpts = { imageWidth: pc.imageWidth.max, imageHeight: pc.imageHeight.max };
      } catch { }
    }
    sizeOverlay();
    return true;
  }
  function stopCamera() {
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null; track = null; imageCapture = null;
  }
  async function setTorch(on) {
    if (!track) return;
    try { await track.applyConstraints({ advanced: [{ torch: on }] }); torchOn = on; }
    catch { torchOn = false; toast('Flash is not available'); }
    $('#flashBtn').classList.toggle('on', torchOn);
  }
  async function flipCamera() {
    if (rec) return toast('Stop recording first');
    facing = facing === 'environment' ? 'user' : 'environment';
    stopLoops(); await startCamera(); startLoops();
  }
  let zT, zRaf = 0;
  function applyZoom(z) {
    zoom = Math.min(zRange.max, Math.max(zRange.min, z));
    if (zoomMode === 'hw') { if (!zRaf) zRaf = requestAnimationFrame(() => { zRaf = 0; track && track.applyConstraints({ advanced: [{ zoom }] }).catch(() => { }); }); }
    else vf.style.transform = `scale(${zoom})`;
    const chip = $('#zoomChip'); chip.textContent = (zoom / zRange.min).toFixed(1) + '×'; chip.classList.add('show');
    clearTimeout(zT); zT = setTimeout(() => chip.classList.remove('show'), 900);
  }

  function thumbCanvas(src) {
    const sw = src.videoWidth || src.width, sh = src.videoHeight || src.height;
    const s = 240 / Math.max(sw, sh);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * s)); c.height = Math.max(1, Math.round(sh * s));
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return c;
  }
  const makeThumb = src => toBlob(thumbCanvas(src), 'image/jpeg', 0.72);

  let actx;
  function click() {
    try {
      actx ||= new (window.AudioContext || window.webkitAudioContext)();
      actx.resume();
      const t = actx.currentTime, o = actx.createOscillator(), g = actx.createGain();
      o.type = 'square'; o.frequency.setValueAtTime(1900, t); o.frequency.exponentialRampToValueAtTime(260, t + .05);
      g.gain.setValueAtTime(.16, t); g.gain.exponentialRampToValueAtTime(.001, t + .09);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + .1);
    } catch { }
  }
  function flashScreen() { const f = $('#flash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go'); }

  async function focusAt(cx, cy) {
    const ring = $('#focusRing');
    ring.style.left = cx + 'px'; ring.style.top = cy + 'px';
    ring.classList.remove('go'); void ring.offsetWidth; ring.classList.add('go');
    if (!track || !vf.videoWidth) return;
    const r = vf.getBoundingClientRect(), vw = vf.videoWidth, vh = vf.videoHeight;
    const sc = Math.max(r.width / vw, r.height / vh);
    const ox = (r.width - vw * sc) / 2, oy = (r.height - vh * sc) / 2;
    const x = Math.min(1, Math.max(0, ((cx - r.left) - ox) / (vw * sc)));
    const y = Math.min(1, Math.max(0, ((cy - r.top) - oy) / (vh * sc)));
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    try {
      const a = { pointsOfInterest: [{ x, y }] };
      if (caps.focusMode && caps.focusMode.includes('single-shot')) a.focusMode = 'single-shot';
      if (caps.exposureMode && caps.exposureMode.includes('single-shot')) a.exposureMode = 'single-shot';
      await track.applyConstraints({ advanced: [a] });
      setTimeout(() => {
        const b = {};
        if (caps.focusMode && caps.focusMode.includes('continuous')) b.focusMode = 'continuous';
        if (caps.exposureMode && caps.exposureMode.includes('continuous')) b.exposureMode = 'continuous';
        if (track && Object.keys(b).length) track.applyConstraints({ advanced: [b] }).catch(() => { });
      }, 3000);
    } catch { }
  }

  /* one still, upright, optionally stamped */
  async function captureImage({ withStamp = false } = {}) {
    const digital = zoomMode === 'digital' && zoom > 1.01;
    let blob = null, bmp = null;
    if (!digital && imageCapture) { try { blob = await imageCapture.takePhoto(photoOpts || undefined); } catch { } }
    let src, sw, sh;
    if (blob) { bmp = await createImageBitmap(blob); src = bmp; sw = bmp.width; sh = bmp.height; }
    else { src = vf; sw = vf.videoWidth; sh = vf.videoHeight; }
    if (!blob || rot !== 0 || withStamp || digital) {
      let crop = null;
      if (digital) { const w = sw / zoom, hh = sh / zoom; crop = { x: (sw - w) / 2, y: (sh - hh) / 2, w, h: hh }; }
      const c = drawRot(src, sw, sh, rot, crop);
      if (withStamp) stampDate(c);
      if (bmp && bmp.close) bmp.close();
      return { blob: await toBlob(c, 'image/jpeg', 0.93), canvas: c };
    }
    if (bmp && bmp.close) bmp.close();
    return { blob, canvas: null };
  }
  async function thumbOf(blob) { const b = await createImageBitmap(blob); const t = await makeThumb(b); if (b.close) b.close(); return t; }

  /* ---------- photo ---------- */
  const stampOn = () => store.get('cc_stamp', '1') === '1';
  function paintStamp() { const on = stampOn(); $('#stampChip').classList.toggle('on', on); $('#stampTxt').textContent = on ? 'Date stamp on' : 'Date stamp off'; $('#stampChip').setAttribute('aria-pressed', on); }
  async function capturePhoto() {
    if (busy || !track) return;
    setBusy(true); flashScreen(); click();
    try {
      const { blob } = await captureImage({ withStamp: stampOn() });
      await saveItem('photo', blob, await thumbOf(blob));
      toast('Saved', 1600);
    } catch (e) { console.error(e); toast('Could not take the photo'); }
    setBusy(false);
  }

  /* ---------- video ---------- */
  let rec = null, recChunks = [], recStart = 0, recAcc = 0, recTimer = null, micStream = null, recMime = '', recThumb = null, canvasTimer = null;
  function pickMime() {
    const c = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    return c.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
  }
  async function toggleRec() {
    if (!rec) return startRec();
    if (rec.state === 'recording') { rec.pause(); recAcc += Date.now() - recStart; paintRec(); }
    else if (rec.state === 'paused') { rec.resume(); recStart = Date.now(); paintRec(); }
  }
  function rotatedVideoTracks(a) {
    const iw = vf.videoWidth, ih = vf.videoHeight, sc = Math.min(1, 1920 / Math.max(iw, ih));
    const sw = Math.round(iw * sc), sh = Math.round(ih * sc), side = a === 90 || a === -90;
    const c = document.createElement('canvas'); c.width = side ? sh : sw; c.height = side ? sw : sh;
    const x = c.getContext('2d');
    canvasTimer = setInterval(() => {
      x.save(); x.translate(c.width / 2, c.height / 2); x.rotate(a * Math.PI / 180);
      x.drawImage(vf, -sw / 2, -sh / 2, sw, sh); x.restore();
    }, 33);
    return c.captureStream(30).getVideoTracks();
  }
  async function startRec() {
    if (!track || !stream) return;
    try { micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch { micStream = null; toast('Microphone is blocked, recording without sound'); }
    const vt = rot !== 0 ? rotatedVideoTracks(rot) : stream.getVideoTracks();
    const ms = new MediaStream([...vt, ...(micStream ? micStream.getAudioTracks() : [])]);
    recMime = pickMime();
    try {
      rec = new MediaRecorder(ms, { ...(recMime ? { mimeType: recMime } : {}), videoBitsPerSecond: 16000000, audioBitsPerSecond: 128000 });
    } catch (e) { toast('Video recording is not supported here'); cleanupMic(); clearInterval(canvasTimer); rec = null; return; }
    recChunks = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) recChunks.push(e.data); };
    rec.onstop = onRecStop;
    rec.start(1000);
    recStart = Date.now(); recAcc = 0;
    pushLayer('rec');
    recTimer = setInterval(paintRec, 250);
    if (navigator.vibrate) navigator.vibrate(30);
    paintRec();
  }
  function cleanupMic() { if (micStream) micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  function finishRec(fromPop = false) {
    if (!rec || rec.state === 'inactive') return;
    try { recThumb = drawRot(vf, vf.videoWidth, vf.videoHeight, rot); } catch { recThumb = null; }
    try { rec.stop(); } catch { }
    const i = layers.lastIndexOf('rec'); if (i >= 0) layers.splice(i, 1);
    if (!fromPop && document.visibilityState === 'visible') { ignorePop++; history.back(); }
  }
  async function onRecStop() {
    clearInterval(recTimer); clearInterval(canvasTimer);
    const base = ((rec && rec.mimeType) || recMime || 'video/webm').split(';')[0];
    const blob = new Blob(recChunks, { type: base });
    recChunks = []; rec = null; cleanupMic(); paintRec();
    if (blob.size < 2000) return;
    let th = null;
    try { if (recThumb) th = await makeThumb(recThumb); } catch { }
    recThumb = null;
    await saveItem('video', blob, th);
    toast('Video saved');
  }
  function paintRec() {
    const live = !!rec && rec.state !== 'inactive', paused = !!rec && rec.state === 'paused';
    const ms = recAcc + (rec && rec.state === 'recording' ? Date.now() - recStart : 0);
    document.body.classList.toggle('recording', live);
    document.body.classList.toggle('paused', paused);
    $('#recLabel').textContent = !live ? 'Start recording' : paused ? 'Paused · tap to resume' : 'Tap to pause';
    $('#recTime').textContent = live ? fmtTime(ms) : '';
    $('#recChip').hidden = !live;
    $('#chipTime').textContent = fmtTime(ms);
  }

  /* ---------- PDF writer (JPEG pages) ---------- */
  function buildPdf(pages) {
    const enc = new TextEncoder(), parts = [], xref = [];
    let off = 0;
    const push = b => { const u = typeof b === 'string' ? enc.encode(b) : b; parts.push(u); off += u.length; };
    const obj = (n, body) => { xref[n] = off; push(`${n} 0 obj\n${body}\nendobj\n`); };
    push('%PDF-1.4\n');
    const n = pages.length, kids = pages.map((_, i) => `${3 + i * 3} 0 R`);
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${n} >>`);
    pages.forEach((p, i) => {
      const pid = 3 + i * 3, cid = pid + 1, iid = pid + 2;
      const W = +(p.w * 0.48).toFixed(2), H = +(p.h * 0.48).toFixed(2);
      obj(pid, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${iid} 0 R >> >> /Contents ${cid} 0 R >>`);
      const c = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
      obj(cid, `<< /Length ${c.length} >>\nstream\n${c}\nendstream`);
      xref[iid] = off;
      push(`${iid} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.data.length} >>\nstream\n`);
      push(p.data); push('\nendstream\nendobj\n');
    });
    const total = 3 + n * 3, xo = off;
    push(`xref\n0 ${total}\n0000000000 65535 f \n`);
    for (let i = 1; i < total; i++) push(String(xref[i]).padStart(10, '0') + ' 00000 n \n');
    push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xo}\n%%EOF`);
    return new Blob(parts, { type: 'application/pdf' });
  }
  async function pdfFromPages(list) {
    const arr = await Promise.all(list.map(async p => ({ data: new Uint8Array(await p.blob.arrayBuffer()), w: p.w, h: p.h })));
    return buildPdf(arr);
  }

  /* ---------- document scan (OpenCV.js, loaded on demand) ---------- */
  let cvPromise = null, cvOK = false;
  function loadCV() {
    return cvPromise ||= (async () => {
      await loadScript(CV_URL);
      if (window.cv instanceof Promise) window.cv = await window.cv;
      else if (!window.cv.Mat) await new Promise(r => { window.cv.onRuntimeInitialized = r; });
      cvOK = true;
    })().catch(e => { cvPromise = null; throw e; });
  }
  function orderPts(p) {
    const sum = p.map(a => a.x + a.y), diff = p.map(a => a.y - a.x);
    return [p[sum.indexOf(Math.min(...sum))], p[diff.indexOf(Math.min(...diff))], p[sum.indexOf(Math.max(...sum))], p[diff.indexOf(Math.max(...diff))]];
  }
  function detectQuad(canvas) {
    const src = cv.imread(canvas), gray = new cv.Mat(), edges = new cv.Mat(), hier = new cv.Mat();
    const contours = new cv.MatVector(), kernel = cv.Mat.ones(5, 5, cv.CV_8U);
    let best = null;
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
      cv.Canny(gray, edges, 55, 160);
      cv.dilate(edges, edges, kernel);
      cv.findContours(edges, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      const total = canvas.width * canvas.height; let bestA = 0;
      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i), a = cv.contourArea(c);
        if (a > total * 0.14 && a > bestA) {
          const ap = new cv.Mat();
          cv.approxPolyDP(c, ap, 0.02 * cv.arcLength(c, true), true);
          if (ap.rows === 4 && cv.isContourConvex(ap)) {
            best = []; for (let j = 0; j < 4; j++) best.push({ x: ap.data32S[j * 2], y: ap.data32S[j * 2 + 1] });
            bestA = a;
          }
          ap.delete();
        }
        c.delete();
      }
    } finally { src.delete(); gray.delete(); edges.delete(); hier.delete(); contours.delete(); kernel.delete(); }
    return best ? orderPts(best) : null;
  }
  function warp(src, p) {
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const [tl, tr, br, bl] = p;
    const W = Math.max(50, Math.round(Math.max(d(br, bl), d(tr, tl)))), H = Math.max(50, Math.round(Math.max(d(tr, br), d(tl, bl))));
    const from = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
    const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, W, 0, W, H, 0, H]);
    const M = cv.getPerspectiveTransform(from, to), dst = new cv.Mat();
    cv.warpPerspective(src, dst, M, new cv.Size(W, H), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
    from.delete(); to.delete(); M.delete();
    return dst;
  }
  function enhanceScan(m) {
    const rgb = new cv.Mat(), bg = new cv.Mat(), out = new cv.Mat(), blur = new cv.Mat(), sharp = new cv.Mat(), fin = new cv.Mat();
    cv.cvtColor(m, rgb, cv.COLOR_RGBA2RGB);
    const sigma = Math.max(8, Math.min(rgb.cols, rgb.rows) / 14);
    cv.GaussianBlur(rgb, bg, new cv.Size(0, 0), sigma);
    cv.divide(rgb, bg, out, 255, -1);
    cv.GaussianBlur(out, blur, new cv.Size(0, 0), 1.6);
    cv.addWeighted(out, 1.6, blur, -0.6, 0, sharp);
    sharp.convertTo(fin, -1, 1.12, -14);
    rgb.delete(); bg.delete(); out.delete(); blur.delete(); sharp.delete();
    return fin;
  }
  function simpleEnhance(c) {
    const o = document.createElement('canvas'); o.width = c.width; o.height = c.height;
    const x = o.getContext('2d'); x.filter = 'brightness(1.15) contrast(1.35) saturate(.9)'; x.drawImage(c, 0, 0);
    return o;
  }
  async function shrink(c, target = 300 * 1024) {
    let q = 0.8, cur = c, b = await toBlob(cur, 'image/jpeg', q), guard = 0;
    while (b.size > target && guard++ < 9) {
      if (q > 0.5) q -= 0.07;
      else {
        const n = document.createElement('canvas');
        n.width = Math.round(cur.width * 0.85); n.height = Math.round(cur.height * 0.85);
        n.getContext('2d').drawImage(cur, 0, 0, n.width, n.height); cur = n;
      }
      b = await toBlob(cur, 'image/jpeg', q);
    }
    return { blob: b, w: cur.width, h: cur.height };
  }
  async function processScan(blob) {
    const bmp = await createImageBitmap(blob);
    const s = Math.min(1, 2200 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    if (bmp.close) bmp.close();
    let out = c, found = false;
    try {
      await loadCV();
      const ds = 640 / Math.max(c.width, c.height);
      const sm = document.createElement('canvas');
      sm.width = Math.round(c.width * ds); sm.height = Math.round(c.height * ds);
      sm.getContext('2d').drawImage(c, 0, 0, sm.width, sm.height);
      const q = detectQuad(sm);
      let src = cv.imread(c);
      if (q) { found = true; const w = warp(src, q.map(p => ({ x: p.x / ds, y: p.y / ds }))); src.delete(); src = w; }
      const cleaned = enhanceScan(src); src.delete();
      const oc = document.createElement('canvas'); cv.imshow(oc, cleaned); cleaned.delete();
      out = oc;
    } catch (e) { console.warn('scan fallback', e); out = simpleEnhance(c); }
    return { ...(await shrink(out)), found };
  }
  let pages = [];
  const scanFmt = () => store.get('cc_fmt', 'image');
  function paintFmt() {
    $$('#fmtSeg button').forEach(b => { const on = b.dataset.fmt === scanFmt(); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    paintPages();
  }
  function paintPages() {
    const n = pages.length;
    $('#doneBtn').hidden = !(scanFmt() === 'pdf' && n > 0);
    $('#undoChip').hidden = !(scanFmt() === 'pdf' && n > 0);
    $('#pageCount').textContent = n;
    $('#scanBtn').querySelector('span').textContent = scanFmt() === 'pdf' && n ? 'Next page' : 'Scan page';
  }
  async function scanCapture() {
    if (busy || !track) return;
    setBusy(true); flashScreen(); click();
    try {
      const { blob: raw } = await captureImage();
      const r = await processScan(raw);
      const kb = Math.round(r.blob.size / 1024);
      if (scanFmt() === 'pdf') {
        pages.push(r); paintPages();
        toast(`Page ${pages.length} added · ${kb} KB`);
      } else {
        await saveItem('scan', r.blob, await thumbOf(r.blob));
        toast((r.found ? 'Scan saved' : 'Saved, page edges not found') + ' · ' + kb + ' KB');
      }
    } catch (e) { console.error(e); toast('Scan failed'); }
    setBusy(false);
  }
  async function finishPdf() {
    if (!pages.length) return;
    const ps = pages; pages = []; paintPages();
    try {
      const pdf = await pdfFromPages(ps);
      await saveItem('scan', pdf, await thumbOf(ps[0].blob));
      toast(`PDF saved · ${ps.length} page${ps.length > 1 ? 's' : ''} · ${Math.round(pdf.size / 1024)} KB`);
    } catch (e) { console.error(e); toast('Could not make the PDF'); }
  }
  function sizeOverlay() { const d = devicePixelRatio || 1; ov.width = innerWidth * d; ov.height = innerHeight * d; }
  function drawQuad(q) {
    octx.clearRect(0, 0, ov.width, ov.height);
    if (!q || !vf.videoWidth) return;
    const d = devicePixelRatio || 1, r = vf.getBoundingClientRect(), vw = vf.videoWidth, vh = vf.videoHeight;
    const sc = Math.max(r.width / vw, r.height / vh), ox = (r.width - vw * sc) / 2, oy = (r.height - vh * sc) / 2;
    const P = q.map(p => ({ x: (p.x * sc + ox) * d, y: (p.y * sc + oy) * d }));
    octx.beginPath(); P.forEach((p, i) => i ? octx.lineTo(p.x, p.y) : octx.moveTo(p.x, p.y)); octx.closePath();
    octx.fillStyle = 'rgba(201,162,75,.16)'; octx.fill();
    octx.lineWidth = 4 * d; octx.lineJoin = 'round'; octx.strokeStyle = '#C9A24B'; octx.stroke();
    octx.fillStyle = '#fff'; P.forEach(p => { octx.beginPath(); octx.arc(p.x, p.y, 7 * d, 0, 7); octx.fill(); });
  }
  let scanLoop = null; const smallCanvas = document.createElement('canvas');
  function scanTick() {
    if (mode !== 'scan') return;
    if (cvOK && vf.videoWidth && !busy) {
      try {
        const s = 360 / Math.max(vf.videoWidth, vf.videoHeight);
        smallCanvas.width = Math.round(vf.videoWidth * s); smallCanvas.height = Math.round(vf.videoHeight * s);
        smallCanvas.getContext('2d').drawImage(vf, 0, 0, smallCanvas.width, smallCanvas.height);
        const q = detectQuad(smallCanvas);
        drawQuad(q ? q.map(p => ({ x: p.x / s, y: p.y / s })) : null);
      } catch (e) { console.warn(e); }
    }
    scanLoop = setTimeout(scanTick, 350);
  }

  /* ---------- AI (Google Gemini, keys stay on this phone) ---------- */
  const Keys = {
    get() { try { const a = JSON.parse(store.get('cc_keys', '[]')); return Array.isArray(a) ? a : []; } catch { return []; } },
    set(a) { store.set('cc_keys', JSON.stringify(a)); },
  };
  let keyIdx = 0, aiModel = store.get('cc_model', '');
  const MODELS = ['gemini-flash-latest', 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.1-flash-lite'];
  async function aiCall(key, parts) {
    const order = [...(aiModel ? [aiModel] : []), ...MODELS.filter(m => m !== aiModel)];
    let detail = '';
    for (const m of order) {
      let r;
      try {
        r = await fetch(AI_BASE + m + ':generateContent', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } })
        });
      } catch { const e = new Error('net'); e.detail = 'No internet connection'; e.fatal = true; throw e; }
      if (!r.ok) {
        let msg = ''; try { msg = (await r.json()).error.message || ''; } catch { }
        detail = (r.status + ' ' + msg).slice(0, 140);
        if (r.status === 404 || (r.status === 400 && /model/i.test(msg))) continue;
        const e = new Error('ai'); e.detail = detail; throw e;
      }
      try {
        const j = await r.json();
        const t = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts || []).map(p => p.text || '').join('');
        const out = JSON.parse(t.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim());
        aiModel = m; store.set('cc_model', m);
        return out;
      } catch { detail = 'Unreadable answer from the AI'; }
    }
    const e = new Error('ai'); e.detail = detail || 'No AI model available'; throw e;
  }
  async function gemini(parts) {
    const keys = Keys.get();
    if (!keys.length) { openKeys(); throw new Error('nokey'); }
    let err = null;
    for (let i = 0; i < keys.length; i++) {
      try { const out = await aiCall(keys[(keyIdx + i) % keys.length], parts); keyIdx = (keyIdx + i + 1) % keys.length; return out; }
      catch (e) { err = e; if (e.fatal) break; }
    }
    throw err || new Error('ai');
  }
  const why = e => (e && (e.detail || e.message)) || 'unknown';
  function explain(e) {
    const d = why(e);
    if (/No internet/i.test(d)) return 'There is no internet connection.';
    if (/^400/.test(d) && /key/i.test(d)) return 'Your AI key is not valid. Please check it on the key screen.';
    if (/^403/.test(d)) return 'Google refused this key. It may be restricted, or the Gemini service is not allowed for it.';
    if (/^429/.test(d)) return 'The AI is busy, or the free limit is used up. Please wait a minute and try again.';
    if (/^5\d\d/.test(d)) return 'Google AI is having trouble right now. Please try again shortly.';
    if (/Unreadable|nothing to say/i.test(d)) return 'The AI answered in a form I could not understand. Please try again.';
    return 'Something went wrong: ' + d;
  }
  function showError(e, speakIt = true) {
    const msg = explain(e);
    $('#errMsg').textContent = msg; $('#errRaw').textContent = why(e); $('#errBox').hidden = false;
    if (speakIt) { try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(msg); u.lang = navigator.language || 'en-IN'; speechSynthesis.speak(u); } catch { } }
  }
  async function aiImage(blob) {
    const b = await createImageBitmap(blob);
    const s = Math.min(1, 1400 / Math.max(b.width, b.height));
    const c = document.createElement('canvas'); c.width = Math.round(b.width * s); c.height = Math.round(b.height * s);
    c.getContext('2d').drawImage(b, 0, 0, c.width, c.height); if (b.close) b.close();
    return blobToB64(await toBlob(c, 'image/jpeg', 0.8));
  }
  const imgPart = b64 => ({ inlineData: { mimeType: 'image/jpeg', data: b64 } });
  function needKey() { if (Keys.get().length) return false; toast('Add your Google AI key first'); openKeys(); return true; }

  /* keys screen */
  function openKeys() { if (!$('#keys').hidden) return; renderKeys(); $('#keys').hidden = false; pushLayer('keys'); }
  function renderKeys() {
    const list = $('#keyList'); list.replaceChildren();
    Keys.get().forEach((k, i) => list.append(h('div', { class: 'krow' },
      h('code', { text: '•••• ' + k.slice(-4) }),
      h('button', { class: 'ib', 'aria-label': 'Copy key', onclick: async () => { try { await navigator.clipboard.writeText(k); toast('Copied'); } catch { toast('Could not copy'); } } }, icon('i-copy')),
      h('button', { class: 'ib', 'aria-label': 'Delete key', onclick: () => { const a = Keys.get(); a.splice(i, 1); Keys.set(a); renderKeys(); toast('Key removed'); } }, icon('i-trash')))));
  }
  async function saveKey() {
    const v = $('#keyInput').value.trim();
    if (v.length < 20) return toast('That does not look like a key');
    const a = Keys.get();
    if (a.includes(v)) return toast('Already saved');
    a.push(v); Keys.set(a); $('#keyInput').value = ''; renderKeys(); toast('Saved. Checking the key…', 10000);
    try { await aiCall(v, [{ text: 'Reply with this JSON: {"ok":true}' }]); toast('Key works'); }
    catch (e) { toast('Key saved, but it failed', 4000); showError(e); }
  }

  /* ---------- Text mode ---------- */
  const TEXT_PROMPT = `You turn photos of printed or handwritten text into clean, accurate text. Keep the original language and script. Return JSON only:
{"type":"card"|"label"|"document"|"other","title":"short title","fields":[{"label":"...","value":"..."}],"text":"full transcription"}
Rules: For a visiting card or similar, put each detail in fields using labels such as Name, Title, Company, Phone, Email, Website, Address (only those present) and keep "text" as the full transcription. For a document, page or long passage leave fields empty and put the full transcription in "text" with paragraphs separated by blank lines. For a short sign, label or note, give a title and the text. Never add commentary.`;
  function wrap(ctx, text, maxW) {
    const out = [];
    String(text).split('\n').forEach(par => {
      if (!par.trim()) { out.push(''); return; }
      const tokens = /\s/.test(par) ? par.split(/(\s+)/) : [...par];
      let line = '';
      tokens.forEach(t => {
        if (ctx.measureText(line + t).width > maxW && line.trim()) { out.push(line.trimEnd()); line = t.trimStart(); } else line += t;
      });
      if (line.trim()) out.push(line.trimEnd());
    });
    return out;
  }
  function labelCanvas(d) {
    const W = 1080, P = 64, ev = '#0C3C2D', gold = '#C9A24B', ivory = '#FBF8F2';
    const rows = (d.fields && d.fields.length) ? d.fields : [{ label: '', value: d.text || '' }];
    const draw = (ctx, paint) => {
      let y = 0;
      ctx.font = '700 46px ui-sans-serif, system-ui, sans-serif';
      const tl = wrap(ctx, d.title || 'Text', W - P * 2);
      const hh = 70 + tl.length * 58;
      if (paint) { ctx.fillStyle = ev; ctx.fillRect(0, 0, W, hh); ctx.fillStyle = gold; ctx.fillRect(0, hh, W, 5); ctx.fillStyle = ivory; ctx.textBaseline = 'top'; tl.forEach((l, i) => ctx.fillText(l, P, 36 + i * 58)); }
      y = hh + 46;
      rows.forEach(r => {
        if (r.label) { ctx.font = '700 25px ui-sans-serif, system-ui, sans-serif'; if (paint) { ctx.fillStyle = '#8A6A1F'; ctx.fillText(String(r.label).toUpperCase(), P, y); } y += 38; }
        ctx.font = '500 40px ui-sans-serif, system-ui, sans-serif';
        const ls = wrap(ctx, r.value, W - P * 2);
        ls.forEach(l => { if (paint) { ctx.fillStyle = ev; ctx.fillText(l, P, y); } y += 54; });
        y += 26;
      });
      ctx.font = '600 24px ui-sans-serif, system-ui, sans-serif';
      if (paint) { ctx.fillStyle = '#8A6A1F'; ctx.fillText('Custom Camera · ' + new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }), P, y + 6); }
      return y + 70;
    };
    const t = document.createElement('canvas').getContext('2d'); t.canvas.width = W;
    const H = draw(t, false);
    const c = document.createElement('canvas'); c.width = W; c.height = Math.max(420, Math.round(H));
    const x = c.getContext('2d'); x.fillStyle = ivory; x.fillRect(0, 0, W, c.height); x.textBaseline = 'top';
    draw(x, true);
    return c;
  }
  async function documentPages(d) {
    const W = 1240, H = 1754, M = 110, LH = 54, out = [];
    const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, W, H); x.fillStyle = '#111'; x.textBaseline = 'top'; return [c, x]; };
    let [c, x] = mk(), y = M;
    if (d.title) { x.font = '700 48px ui-sans-serif, system-ui, sans-serif'; wrap(x, d.title, W - M * 2).forEach(l => { x.fillText(l, M, y); y += 62; }); y += 24; }
    x.font = '400 33px ui-sans-serif, system-ui, sans-serif';
    for (const l of wrap(x, d.text || '', W - M * 2)) {
      if (y > H - M - LH) { out.push(c); [c, x] = mk(); x.font = '400 33px ui-sans-serif, system-ui, sans-serif'; y = M; }
      x.fillText(l, M, y); y += l ? LH : LH * 0.6;
    }
    out.push(c);
    return Promise.all(out.map(async cv2 => { const b = await toBlob(cv2, 'image/jpeg', 0.6); return { blob: b, w: cv2.width, h: cv2.height }; }));
  }
  let lastText = null;
  async function textCapture() {
    if (busy || !track || needKey()) return;
    setBusy(true); flashScreen(); click(); toast('Reading…', 20000);
    try {
      const { blob } = await captureImage();
      const d = await gemini([{ text: TEXT_PROMPT }, imgPart(await aiImage(blob))]);
      const plain = (d.fields && d.fields.length ? d.fields.map(f => `${f.label}: ${f.value}`).join('\n') : (d.text || '')).trim();
      if (!plain && !d.text) throw new Error('empty');
      const asLabel = (d.fields && d.fields.length) || (d.text || '').length < 700;
      let out, prev;
      if (asLabel) { const c = labelCanvas(d); out = await toBlob(c, 'image/jpeg', 0.9); prev = out; }
      else { const ps = await documentPages(d); out = await pdfFromPages(ps); prev = ps[0].blob; }
      const full = d.text || plain;
      const name = await saveItem('text', out, await thumbOf(prev), { desc: full });
      await idb.put('texts', full, name);
      lastText = { blob: out, text: full, name };
      $('#textPrev').src = URL.createObjectURL(prev);
      $('#textSheet').hidden = false; pushLayer('text');
      toast(asLabel ? 'Label saved' : 'PDF saved');
    } catch (e) { console.warn(e); if (e.message !== 'nokey') showError(e); }
    setBusy(false);
  }

  /* ---------- Read mode (speaks) ---------- */
  const READ_PROMPT = `You are the eyes of a person with low vision. Look at the photo. If it has text (a banner, sign, label, page, board), read it out exactly in its own language and natural order, starting with headings. If it is mostly a scene, place, object or person's surroundings, describe what is in front of them in 2 to 4 short sentences, and if you can recognise the place say where it probably is, using words like probably when unsure. Return JSON only: {"lang":"BCP-47 code of the language you will speak","speech":"what to say aloud"}`;
  const ASK_PROMPT = `You are the eyes of a person with low vision. Answer their question about this photo briefly and clearly, in the language of the question. If you are not sure, say so. Return JSON only: {"lang":"BCP-47 code of the language you will speak","speech":"the spoken answer"}`;
  const readCtx = { b64: null, last: '' };
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  function stopSpeech() { try { speechSynthesis.cancel(); } catch { } setSpeaking(false); }
  function setSpeaking(on) {
    document.body.classList.toggle('speaking', on);
    $('#readLabel').textContent = on ? 'Stop' : 'Read to me';
    $('#readIc').firstElementChild.setAttribute('href', on ? '#i-stop' : '#i-speaker');
  }
  function speak(text, lang) {
    stopSpeech();
    const chunks = String(text).match(/[^.!?।\n]+[.!?।]*\s*/g) || [String(text)];
    let n = 0; setSpeaking(true);
    chunks.forEach((c, i) => {
      const u = new SpeechSynthesisUtterance(c.trim()); if (!c.trim()) { return; }
      if (lang) u.lang = lang; n++;
      u.onend = u.onerror = () => { n--; if (n <= 0) setSpeaking(false); };
      speechSynthesis.speak(u);
    });
    if (!n) setSpeaking(false);
  }
  function say(msg) { speak(msg, navigator.language); toast(msg); }
  async function readCapture() {
    if (document.body.classList.contains('speaking')) { stopSpeech(); return; }
    if (busy || !track) return;
    if (!Keys.get().length) { say('Please add your Google AI key first'); openKeys(); return; }
    setBusy(true); click();
    try {
      const { blob } = await captureImage();
      readCtx.b64 = await aiImage(blob);
      const d = await gemini([{ text: READ_PROMPT }, imgPart(readCtx.b64)]);
      const sp = d.speech || d.text || d.description || ''; if (!sp) throw new Error('The AI sent back nothing to say');
      readCtx.last = sp; $('#askBtn').hidden = false;
      speak(sp, d.lang);
    } catch (e) { console.warn(e); if (e.message !== 'nokey') showError(e); }
    setBusy(false);
  }
  function listen() {
    return new Promise(res => {
      const r = new SR(); let done = false;
      r.lang = navigator.language || 'en-IN'; r.interimResults = false; r.maxAlternatives = 1;
      r.onresult = e => { done = true; res(e.results[0][0].transcript); };
      r.onerror = () => { if (!done) { done = true; res(null); } };
      r.onend = () => { if (!done) { done = true; res(null); } };
      try { r.start(); showHint('Listening…'); } catch { res(null); }
    });
  }
  async function askQuestion() {
    if (busy || !readCtx.b64) return;
    if (!SR) return say('Voice questions are not supported on this phone');
    stopSpeech(); click();
    const q = await listen();
    if (!q) return say('I did not hear a question');
    setBusy(true);
    try {
      const d = await gemini([{ text: ASK_PROMPT + `\nWhat you told them before: ${readCtx.last}\nTheir question: ${q}` }, imgPart(readCtx.b64)]);
      const sp = d.speech || d.text || ''; if (!sp) throw new Error('Nothing to say');
      readCtx.last = sp; speak(sp, d.lang);
    } catch (e) { showError(e); }
    setBusy(false);
  }

  /* ---------- QR ---------- */
  let qrTimer = null, qrPause = 0, detector = null;
  async function decodeQR(src, w, h) {
    if ('BarcodeDetector' in window) {
      try {
        detector ||= new BarcodeDetector({ formats: ['qr_code'] });
        const r = await detector.detect(src);
        return r[0] ? r[0].rawValue : null;
      } catch { }
    }
    await loadScript(JSQR_URL);
    const s = Math.min(1, 900 / Math.max(w, h));
    const c = document.createElement('canvas'); c.width = Math.round(w * s); c.height = Math.round(h * s);
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(src, 0, 0, c.width, c.height);
    const d = x.getImageData(0, 0, c.width, c.height);
    const r = window.jsQR(d.data, c.width, c.height, { inversionAttempts: 'attemptBoth' });
    return r ? r.data : null;
  }
  async function qrTick() {
    if (mode !== 'qr') return;
    try {
      if (Date.now() > qrPause && vf.videoWidth) { const text = await decodeQR(vf, vf.videoWidth, vf.videoHeight); if (text) handleQR(text); }
    } catch { }
    qrTimer = setTimeout(qrTick, 140);
  }
  const OPENABLE = /^(https?|upi|tel|mailto|sms|smsto|geo|market|whatsapp|tg|intent):/i;
  async function handleQR(text) {
    qrPause = Date.now() + 5000;
    if (navigator.vibrate) navigator.vibrate([40, 40, 40]);
    idb.add('qrlog', { text, time: Date.now() }).catch(() => { });
    if (OPENABLE.test(text.trim())) { toast('Opening…', 1500); setTimeout(() => { location.href = text.trim(); }, 250); }
    else { $('#qrText').textContent = text; $('#qrSheet').hidden = false; pushLayer('qr'); }
  }

  /* ---------- modes, strip, gestures ---------- */
  let mode = 'photo';
  const HINTS = { photo: 'Tap to focus · pinch to zoom', video: 'Tap the bar to start recording', scan: 'Hold steady over the document', text: 'Point at text and tap Capture', read: 'Tap Read to hear what is ahead', qr: 'Point at a QR code' };
  let hintT;
  function showHint(t) { const el = $('#hint'); el.textContent = t; el.classList.add('show'); clearTimeout(hintT); hintT = setTimeout(() => el.classList.remove('show'), 2400); }
  function buildStrip() {
    const tr = $('#stripTrack');
    MODES.forEach(m => tr.append(h('button', { 'data-mode': m, 'aria-label': LABELS[m] + ' mode', text: LABELS[m], onclick: () => setMode(m) })));
    paintStrip();
  }
  function paintStrip() {
    const i = MODES.indexOf(mode);
    $$('#stripTrack button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  }
  function stopLoops() { clearTimeout(scanLoop); clearTimeout(qrTimer); octx.clearRect(0, 0, ov.width, ov.height); }
  function startLoops() {
    if (mode === 'scan') { loadCV().catch(() => toast('Edge detection needs internet the first time')); scanTick(); }
    if (mode === 'qr') qrTick();
  }
  function setMode(m) {
    if (m === mode) return;
    if (rec) finishRec();
    if (mode === 'scan' && pages.length) finishPdf();
    if (mode === 'read') stopSpeech();
    mode = m; document.body.dataset.mode = m;
    paintStrip(); stopLoops(); startLoops(); showHint(HINTS[m]);
  }
  const stepMode = d => { const i = MODES.indexOf(mode) + d; if (i >= 0 && i < MODES.length) setMode(MODES[i]); };

  let tS = null, pinch = null, lastMulti = 0;
  const touch = $('#touch');
  const dist = e => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
  touch.addEventListener('touchstart', e => {
    if (e.touches.length === 2) { pinch = { d: dist(e), z: zoom }; tS = null; lastMulti = Date.now(); return; }
    if (e.touches.length === 1) { const t = e.touches[0]; tS = { x: t.clientX, y: t.clientY, t: Date.now() }; }
  }, { passive: true });
  touch.addEventListener('touchmove', e => {
    if (pinch && e.touches.length === 2) { lastMulti = Date.now(); applyZoom(pinch.z * dist(e) / pinch.d); }
  }, { passive: true });
  touch.addEventListener('touchend', e => {
    if (pinch) { if (e.touches.length < 2) pinch = null; return; }
    if (!tS || Date.now() - lastMulti < 250) { tS = null; return; }
    const t = e.changedTouches[0], dx = t.clientX - tS.x, dy = t.clientY - tS.y, dt = Date.now() - tS.t;
    tS = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) { stepMode(dx < 0 ? 1 : -1); return; }
    if (dy > 80 && dy > Math.abs(dx) * 1.5) { peek(); return; }
    if (Math.abs(dx) < 16 && Math.abs(dy) < 16 && dt < 450) focusAt(t.clientX, t.clientY);
  });

  /* ---------- items, gallery ---------- */
  const gal = { section: 'all', items: [], view: [], qr: [], loading: false, sel: null };
  const emptyText = () => gal.section === 'qr' ? 'No QR codes scanned yet.' : gal.section === 'fav' ? 'Tap the heart on anything to find it here.' : Drive.connected() ? 'Nothing here yet. Capture something!' : 'Connect Google Drive to see everything you have saved.';
  let cachedList = [];
  try { cachedList = JSON.parse(store.get('cc_list', '[]')); } catch { }
  async function mergeItems(remote) {
    const pending = await idb.all('queue').catch(() => []);
    const names = new Set(remote.map(r => r.name));
    const pend = pending.filter(p => !names.has(p.name)).map(p => ({ id: 'q' + p.id, qid: p.id, name: p.name, kind: p.kind, mime: p.blob.type, created: p.created, pending: true, blob: p.blob, desc: p.desc || '', fav: !!p.fav }));
    return [...pend, ...remote].sort((a, b) => b.created - a.created);
  }
  function saveCache() { store.set('cc_list', JSON.stringify(gal.items.filter(x => !x.pending).map(({ blob, ...r }) => r))); cachedList = JSON.parse(store.get('cc_list', '[]')); }

  async function openGallery() {
    if (rec) finishRec();
    $('#gallery').hidden = false; pushLayer('gallery');
    if (!gal.items.length) { gal.items = await mergeItems(cachedList); renderGallery(); }
    loadGallery();
  }
  function hideGallery() { $('#gallery').hidden = true; gal.sel = null; paintSel(); }
  async function loadGallery() {
    gal.loading = true; renderGallery();
    let remote = [], ok = false;
    if (Drive.connected() && navigator.onLine) {
      try { for (const k of KINDS) remote.push(...await Drive.list(k)); ok = true; }
      catch (e) { console.warn(e); if (isAuthErr(e)) { needReconnect = true; updateCloudChip(); toast('Tap the cloud icon to reconnect'); } }
    }
    if (!ok) remote = cachedList;
    gal.items = await mergeItems(remote);
    if (ok) saveCache();
    gal.qr = (await idb.all('qrlog').catch(() => [])).sort((a, b) => b.time - a.time);
    gal.loading = false; renderGallery(); updateCloudChip();
    if (!$('#thumb').classList.contains('has') && gal.items[0]) { const img = new Image(); loadThumb(gal.items[0], $('#thumbImg'), 160).then(() => $('#thumb').classList.add('has')); }
  }
  async function loadThumb(it, img, size = 240) {
    const local = async () => { const b = await idb.get('thumbs', it.name).catch(() => null); if (b) img.src = URL.createObjectURL(b); };
    if (!it.thumb || it.pending) return local();
    const url = it.thumb.replace(/=s\d+$/, '=s' + size);
    img.onerror = async () => {
      img.onerror = null;
      try { const tok = await Drive.getToken(); const r = await fetch(url, { headers: { Authorization: 'Bearer ' + tok } }); if (r.ok) { img.src = URL.createObjectURL(await r.blob()); return; } } catch { }
      local();
    };
    img.src = url;
  }
  function cell(it, idx) {
    const img = h('img', { alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
    loadThumb(it, img);
    const sel = gal.sel && gal.sel.has(it.id);
    const el = h('button', { class: 'cell ' + it.kind + (sel ? ' sel' : ''), 'aria-label': (it.kind === 'text' ? 'Text' : it.kind) + (it.fav ? ', favourite' : ''),
      onclick: () => { if (gal.sel) { gal.sel.has(it.id) ? gal.sel.delete(it.id) : gal.sel.add(it.id); renderGallery(); paintSel(); } else openViewer(idx); } },
      img,
      it.kind === 'video' ? h('span', { class: 'badge play', text: '▶' }) : null,
      it.mime === 'application/pdf' ? h('span', { class: 'badge play', text: 'PDF' }) : null,
      it.pending ? h('span', { class: 'badge wait', text: '↑' }) : null,
      it.fav ? h('span', { class: 'badge fav' }, icon('i-heart')) : null,
      gal.sel ? h('span', { class: 'badge chk' }, sel ? icon('i-check', 'ic sm') : null) : null);
    return el;
  }
  function renderQRList(body) {
    if (!gal.qr.length) { body.append(h('div', { class: 'empty', text: emptyText() })); return; }
    gal.qr.forEach(q => body.append(h('button', { class: 'qrow', onclick: () => handleQR(q.text) }, h('div', { class: 'qt', text: q.text }), h('div', { class: 'qd', text: fmtDate(q.time) }))));
  }
  function renderGallery() {
    const body = $('#galBody'); body.replaceChildren();
    $$('#galTabs button').forEach(b => b.classList.toggle('on', b.dataset.sec === gal.section));
    if (gal.section === 'qr') { renderQRList(body); return; }
    const list = gal.items.filter(i => gal.section === 'all' || (gal.section === 'fav' ? i.fav : i.kind === gal.section));
    gal.view = list;
    if (!list.length) { body.append(h('div', { class: 'empty', text: gal.loading ? 'Loading…' : emptyText() })); return; }
    let y = null, m = null, d = null, grid = null;
    list.forEach((it, idx) => {
      const dt = new Date(it.created), ny = dt.getFullYear(), nm = dt.getMonth(), nd = dt.getDate();
      if (ny !== y) { y = ny; m = null; d = null; body.append(h('h2', { class: 'yr', text: String(y) })); }
      if (nm !== m) { m = nm; d = null; body.append(h('h3', { class: 'mo', text: dt.toLocaleString(undefined, { month: 'long' }) })); }
      if (nd !== d) { d = nd; body.append(h('h4', { class: 'dy', text: dt.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) })); grid = h('div', { class: 'grid' }); body.append(grid); }
      grid.append(cell(it, idx));
    });
  }
  function paintSel() {
    const on = !!gal.sel;
    $('#selBar').hidden = !on;
    if (on) $('#selCount').textContent = gal.sel.size + ' selected';
    $('#galSelect').classList.toggle('on', on);
  }

  /* peek: swipe down on camera to browse the latest items */
  async function peek() {
    const kind = KINDS.includes(mode) ? mode : 'photo';
    if (!gal.items.length) gal.items = await mergeItems(cachedList);
    gal.view = gal.items.filter(i => i.kind === kind);
    if (!gal.view.length) { toast('Nothing here yet'); return; }
    view.peek = true; openViewer(0);
  }

  /* ---------- viewer ---------- */
  const view = { i: 0, url: null, blob: null, peek: false, enh: null };
  const mediaCache = new Map();
  async function mediaBlob(it) {
    if (mediaCache.has(it.id)) return mediaCache.get(it.id);
    const b = await Drive.media(it.id);
    mediaCache.set(it.id, b); if (mediaCache.size > 6) mediaCache.delete(mediaCache.keys().next().value);
    return b;
  }
  async function openViewer(i) { view.i = i; $('#viewer').hidden = false; if (!layers.includes('viewer')) pushLayer('viewer'); await showItem(); }
  function hideViewer() {
    $('#viewer').hidden = true; $('#vStage').replaceChildren(); view.peek = false; view.enh = null;
    if (view.url) URL.revokeObjectURL(view.url); view.url = null; view.blob = null;
  }
  function paintViewerBar(it) {
    const isPdf = it.mime === 'application/pdf';
    $('#vEnhance').hidden = it.kind !== 'photo';
    $('#vCopy').hidden = it.kind !== 'text';
    $('#vPdf').hidden = !isPdf;
    $('#vBar').hidden = $('#vEnhance').hidden && $('#vCopy').hidden && $('#vPdf').hidden;
    $('#enhBar').hidden = true;
    $('#vFav').classList.toggle('on', !!it.fav);
  }
  async function showItem() {
    const it = gal.view[view.i]; if (!it) return;
    const stage = $('#vStage');
    if (view.url) URL.revokeObjectURL(view.url); view.url = null; view.blob = null; view.enh = null;
    stage.replaceChildren(h('div', { class: 'spin' }));
    $('#vTitle').textContent = fmtDate(it.created);
    $('#vSub').textContent = it.pending ? 'Waiting to upload' : it.name;
    paintViewerBar(it);
    try {
      const blob = it.pending ? it.blob : await mediaBlob(it);
      if (gal.view[view.i] !== it) return;
      view.blob = blob; view.url = URL.createObjectURL(blob);
      if (it.kind === 'video') stage.replaceChildren(h('video', { src: view.url, controls: '', playsinline: '', autoplay: '' }));
      else if (it.mime === 'application/pdf') { const im = h('img', { class: 'pdfprev', alt: 'PDF preview' }); loadThumb(it, im, 1000); stage.replaceChildren(im); }
      else stage.replaceChildren(h('img', { src: view.url, alt: '' }));
    } catch (e) { stage.replaceChildren(h('div', { class: 'empty', text: 'Could not load. Check your connection.' })); }
  }
  function stepViewer(d) {
    const n = view.i + d;
    if (n < 0 && view.peek) { history.back(); return; }
    if (n >= 0 && n < gal.view.length) { view.i = n; showItem(); }
  }
  let vs = null;
  $('#vStage').addEventListener('touchstart', e => { vs = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null; }, { passive: true });
  $('#vStage').addEventListener('touchend', e => {
    if (!vs || view.enh) return; const t = e.changedTouches[0], dx = t.clientX - vs.x, dy = t.clientY - vs.y; vs = null;
    if (Math.abs(dy) > 70 && Math.abs(dy) > Math.abs(dx) * 1.4) stepViewer(dy > 0 ? 1 : -1);
    else if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.4) stepViewer(dx < 0 ? 1 : -1);
  });
  let delArm = 0;
  async function trashItem(it) {
    if (it.pending) await idb.del('queue', it.qid); else await Drive.trash(it.id);
    await idb.del('thumbs', it.name).catch(() => { });
    gal.items = gal.items.filter(x => x !== it);
  }
  async function onDelete() {
    const btn = $('#vDel');
    if (!delArm) { btn.classList.add('arm'); toast('Tap delete again to confirm'); delArm = setTimeout(() => { delArm = 0; btn.classList.remove('arm'); }, 3000); return; }
    clearTimeout(delArm); delArm = 0; btn.classList.remove('arm');
    const it = gal.view[view.i]; if (!it) return;
    try {
      await trashItem(it); saveCache();
      gal.view = gal.view.filter(x => x !== it); renderGallery(); updateCloudChip();
      if (!gal.view.length) { history.back(); return; }
      view.i = Math.min(view.i, gal.view.length - 1); showItem(); toast('Deleted');
    } catch (e) { console.warn(e); toast('Could not delete'); }
  }
  async function itemBlob(it) { return it.pending ? it.blob : mediaBlob(it); }
  async function shareBlobs(list) {
    try {
      const files = list.map(({ it, blob }) => new File([blob], it.name, { type: blob.type }));
      if (navigator.canShare && navigator.canShare({ files })) await navigator.share({ files });
      else { files.forEach(f => { const a = h('a', { href: URL.createObjectURL(f), download: f.name }); document.body.append(a); a.click(); a.remove(); }); }
    } catch (e) { if (e.name !== 'AbortError') toast('Could not share'); }
  }
  async function onShare() { const it = gal.view[view.i]; if (!it || !view.blob) return; await shareBlobs([{ it, blob: view.blob }]); }
  async function toggleFav(it) {
    it.fav = !it.fav;
    try {
      if (it.pending) { const rec2 = await idb.get('queue', it.qid); if (rec2) { rec2.fav = it.fav; await idb.put('queue', rec2); } }
      else { await Drive.setFav(it.id, it.fav); saveCache(); }
    } catch (e) { it.fav = !it.fav; toast('Could not update favourite'); }
    $('#vFav').classList.toggle('on', !!it.fav); renderGallery();
  }

  /* enhance (on this phone, no key needed) */
  function enhanceCanvas(bmp) {
    const s = Math.min(1, 4096 / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * s), hh = Math.round(bmp.height * s);
    const c = document.createElement('canvas'); c.width = w; c.height = hh;
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(bmp, 0, 0, w, hh);
    const img = x.getImageData(0, 0, w, hh), d = img.data;
    const hist = new Uint32Array(256); let sum = 0, cnt = 0;
    for (let i = 0; i < d.length; i += 16) { const l = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0; hist[l]++; sum += l; cnt++; }
    let lo = 0, hi = 255, acc = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc > cnt * 0.005) { lo = i; break; } }
    acc = 0; for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc > cnt * 0.005) { hi = i; break; } }
    if (hi - lo < 40) { lo = 0; hi = 255; }
    const mean = sum / cnt, gamma = mean < 115 ? 0.85 : mean > 170 ? 1.08 : 1;
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) lut[i] = 255 * Math.pow(Math.min(1, Math.max(0, (i - lo) / (hi - lo))), gamma);
    for (let i = 0; i < d.length; i += 4) {
      let r = lut[d[i]], g = lut[d[i + 1]], b = lut[d[i + 2]];
      const l = r * 0.299 + g * 0.587 + b * 0.114;
      d[i] = l + (r - l) * 1.18; d[i + 1] = l + (g - l) * 1.18; d[i + 2] = l + (b - l) * 1.18;
    }
    x.putImageData(img, 0, 0);
    const bc = document.createElement('canvas'); bc.width = w; bc.height = hh;
    const bx = bc.getContext('2d', { willReadFrequently: true }); bx.filter = 'blur(1.6px)'; bx.drawImage(c, 0, 0);
    const bd = bx.getImageData(0, 0, w, hh).data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] += 0.55 * (d[i] - bd[i]); d[i + 1] += 0.55 * (d[i + 1] - bd[i + 1]); d[i + 2] += 0.55 * (d[i + 2] - bd[i + 2]);
    }
    x.putImageData(img, 0, 0);
    return c;
  }
  async function onEnhance() {
    const it = gal.view[view.i]; if (!it || it.kind !== 'photo' || !view.blob) return;
    toast('Enhancing…', 6000);
    try {
      const bmp = await createImageBitmap(view.blob); const c = enhanceCanvas(bmp); if (bmp.close) bmp.close();
      const out = await toBlob(c, 'image/jpeg', 0.93);
      view.enh = out;
      const url = URL.createObjectURL(out);
      $('#vStage').replaceChildren(h('img', { src: url, alt: '' }));
      $('#vBar').hidden = true; $('#enhBar').hidden = false; toast('Enhanced. Save it as new or overwrite.');
    } catch (e) { console.warn(e); toast('Could not enhance this photo'); }
  }
  function cancelEnhance() { view.enh = null; showItem(); }
  async function saveEnhanced(overwrite) {
    const it = gal.view[view.i]; const out = view.enh; if (!it || !out) return;
    try {
      if (overwrite) {
        if (it.pending) { const r = await idb.get('queue', it.qid); if (r) { r.blob = out; await idb.put('queue', r); it.blob = out; } }
        else { await Drive.overwrite(it.id, out); mediaCache.delete(it.id); }
        await idb.put('thumbs', await thumbOf(out), it.name);
        toast('Overwritten');
      } else { await saveItem('photo', out, await thumbOf(out)); toast('Saved as new'); }
      view.enh = null; await loadGallery(); if (overwrite) showItem(); else { history.back(); }
    } catch (e) { console.warn(e); toast('Could not save'); }
  }

  /* ---------- onboarding: install first, then connect Drive ---------- */
  let deferredInstall = null;
  const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  store.del('cc_installed');
  const needInstall = () => !isStandalone() && !sessionStorage.getItem('cc_skip_install');
  const needConnect = () => !Drive.connected() && !sessionStorage.getItem('cc_skip_drive');
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; renderOnboard(); });
  window.addEventListener('appinstalled', () => { deferredInstall = null; toast('Installed. Open it from your home screen'); renderOnboard(); });
  function renderOnboard() {
    const step = needInstall() ? 'install' : needConnect() ? 'connect' : null;
    const box = $('#onboard');
    if (!step) { box.hidden = true; return; }
    box.hidden = false; box.dataset.step = step;
    if (step === 'install') {
      $('#obTitle').textContent = 'Install Custom Camera';
      $('#obText').textContent = deferredInstall ? 'Add it to your home screen so it opens like a normal app, full screen.' : 'Open the Chrome menu (three dots) and choose Install app. This goes away once it is installed.';
      $('#obPrimary').textContent = 'Install app'; $('#obSecondary').textContent = 'Not now';
    } else {
      $('#obTitle').textContent = 'Connect Google Drive';
      $('#obText').textContent = 'One time only. Everything you capture saves into a Custom Camera folder in your Drive.';
      $('#obPrimary').textContent = 'Connect Google Drive'; $('#obSecondary').textContent = 'Later';
    }
  }

  /* ---------- wiring ---------- */
  $('#onboard').addEventListener('click', e => e.stopPropagation());
  $('#obPrimary').addEventListener('click', async () => {
    const step = $('#onboard').dataset.step;
    if (step === 'install') {
      if (!deferredInstall) { toast('Use the Chrome menu, then Install app'); return; }
      deferredInstall.prompt(); await deferredInstall.userChoice.catch(() => ({})); deferredInstall = null; renderOnboard();
    } else connectDrive();
  });
  $('#obSecondary').addEventListener('click', () => { sessionStorage.setItem($('#onboard').dataset.step === 'install' ? 'cc_skip_install' : 'cc_skip_drive', '1'); renderOnboard(); });
  $('#shutterBtn').addEventListener('click', capturePhoto);
  $('#recBtn').addEventListener('click', toggleRec);
  $('#scanBtn').addEventListener('click', scanCapture);
  $('#doneBtn').addEventListener('click', finishPdf);
  $('#undoChip').addEventListener('click', () => { pages.pop(); paintPages(); toast('Last page removed'); });
  $('#errClose').addEventListener('click', () => { $('#errBox').hidden = true; try { speechSynthesis.cancel(); } catch { } });
  $('#textBtn').addEventListener('click', textCapture);
  $('#readBtn').addEventListener('click', readCapture);
  $('#askBtn').addEventListener('click', askQuestion);
  $('#stampChip').addEventListener('click', () => { store.set('cc_stamp', stampOn() ? '0' : '1'); paintStamp(); });
  $$('#fmtSeg button').forEach(b => b.addEventListener('click', () => { store.set('cc_fmt', b.dataset.fmt); paintFmt(); }));
  $('#flashBtn').addEventListener('click', () => setTorch(!torchOn));
  $('#flipBtn').addEventListener('click', flipCamera);
  $('#themeBtn').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  $('#keyBtn').addEventListener('click', openKeys);
  $('#keysBack').addEventListener('click', () => history.back());
  $('#keySave').addEventListener('click', saveKey);
  $('#keyInput').addEventListener('keydown', e => { if (e.key === 'Enter') saveKey(); });
  $('#cloud').addEventListener('click', () => {
    if (!Drive.connected() || needReconnect) connectDrive();
    else { flushQueue(); updateCloudChip(); toast('Google Drive is connected'); }
  });
  $('#thumb').addEventListener('click', openGallery);
  $('#galBack').addEventListener('click', () => history.back());
  $('#vClose').addEventListener('click', () => history.back());
  $('#galRefresh').addEventListener('click', loadGallery);
  $('#galSelect').addEventListener('click', () => { gal.sel = gal.sel ? null : new Set(); renderGallery(); paintSel(); });
  $('#selCancel').addEventListener('click', () => { gal.sel = null; renderGallery(); paintSel(); });
  $('#selShare').addEventListener('click', async () => {
    const its = gal.items.filter(i => gal.sel && gal.sel.has(i.id)); if (!its.length) return toast('Select something first');
    toast('Preparing…', 8000);
    try { await shareBlobs(await Promise.all(its.map(async it => ({ it, blob: await itemBlob(it) })))); } catch { toast('Could not prepare the files'); }
  });
  let selArm = 0;
  $('#selDel').addEventListener('click', async () => {
    const its = gal.items.filter(i => gal.sel && gal.sel.has(i.id)); if (!its.length) return toast('Select something first');
    const b = $('#selDel');
    if (!selArm) { b.classList.add('arm'); toast(`Tap again to delete ${its.length}`); selArm = setTimeout(() => { selArm = 0; b.classList.remove('arm'); }, 3000); return; }
    clearTimeout(selArm); selArm = 0; b.classList.remove('arm');
    try { for (const it of its) await trashItem(it); saveCache(); gal.sel = null; renderGallery(); paintSel(); updateCloudChip(); toast('Deleted'); } catch (e) { toast('Could not delete some items'); }
  });
  const SECS = ['all', 'fav', 'photo', 'video', 'scan', 'text', 'qr'];
  function setSection(sec) {
    gal.section = sec; renderGallery(); $('#galBody').scrollTop = 0;
    const b = $(`#galTabs button[data-sec="${sec}"]`); if (b) b.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }
  $$('#galTabs button').forEach(b => b.addEventListener('click', () => setSection(b.dataset.sec)));
  let gs = null;
  $('#gallery').addEventListener('touchstart', e => { gs = e.touches.length === 1 && !gal.sel ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null; }, { passive: true });
  $('#gallery').addEventListener('touchend', e => {
    if (!gs) return; const t = e.changedTouches[0], dx = t.clientX - gs.x, dy = t.clientY - gs.y; gs = null;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) { const i = SECS.indexOf(gal.section) + (dx < 0 ? 1 : -1); if (i >= 0 && i < SECS.length) setSection(SECS[i]); }
  });
  $('#vFav').addEventListener('click', () => { const it = gal.view[view.i]; if (it) toggleFav(it); });
  $('#vShare').addEventListener('click', onShare);
  $('#vDel').addEventListener('click', onDelete);
  $('#vEnhance').addEventListener('click', onEnhance);
  $('#enhNew').addEventListener('click', () => saveEnhanced(false));
  $('#enhOver').addEventListener('click', () => saveEnhanced(true));
  $('#enhCancel').addEventListener('click', cancelEnhance);
  $('#vCopy').addEventListener('click', async () => {
    const it = gal.view[view.i]; if (!it) return;
    const t = (await idb.get('texts', it.name).catch(() => null)) || it.desc;
    if (!t) return toast('No text saved for this one');
    try { await navigator.clipboard.writeText(t); toast('Text copied'); } catch { toast('Could not copy'); }
  });
  $('#vPdf').addEventListener('click', () => { if (view.url) window.open(view.url, '_blank'); });
  $('#qrPick').addEventListener('click', () => $('#qrFile').click());
  $('#qrFile').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const bmp = await createImageBitmap(f);
      const text = await decodeQR(bmp, bmp.width, bmp.height);
      if (text) handleQR(text); else toast('No QR code found in that photo');
    } catch { toast('Could not read that image'); }
  });
  $('#qrCopy').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('#qrText').textContent); toast('Copied'); } catch { toast('Could not copy'); } });
  $('#qrClose').addEventListener('click', () => history.back());
  $('#textClose').addEventListener('click', () => history.back());
  $('#textCopy').addEventListener('click', async () => { if (!lastText) return; try { await navigator.clipboard.writeText(lastText.text); toast('Text copied'); } catch { toast('Could not copy'); } });
  $('#textShare').addEventListener('click', () => { if (lastText) shareBlobs([{ it: { name: lastText.name }, blob: lastText.blob }]); });
  $('#camRetry').addEventListener('click', async () => { if (await startCamera()) startLoops(); });
  addEventListener('resize', sizeOverlay);
  addEventListener('online', flushQueue);
  addEventListener('pagehide', () => { finishRec(true); if (pages.length) finishPdf(); });
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') { finishRec(true); if (pages.length) finishPdf(); stopSpeech(); stopLoops(); setTimeout(() => { if (document.visibilityState === 'hidden') stopCamera(); }, 800); }
    else { if (!stream) { if (await startCamera()) startLoops(); } flushQueue(); }
  });

  /* ---------- start ---------- */
  (async function init() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
    buildStrip(); paintStamp(); paintFmt(); paintRec(); renderOnboard(); updateCloudChip(); startSensor();
    const lt = await idb.get('thumbs', '__latest').catch(() => null);
    if (lt) setLatest(lt);
    if (Drive.configured()) Drive.init().catch(() => { });
    if (await startCamera()) { showHint(HINTS.photo); startLoops(); }
    flushQueue();
  })();
})();
