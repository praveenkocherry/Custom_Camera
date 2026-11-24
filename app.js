'use strict';
(() => {
  const CFG = window.CC_CONFIG || {};
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const MODES = ['photo', 'video', 'scan', 'qr'];
  const ROOT = 'Custom Camera';
  const FOLDER_NAMES = { photo: 'Photos', video: 'Videos', scan: 'Scans' };
  const PREFIX = { photo: 'IMG', video: 'VID', scan: 'SCAN' };
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const CV_URL = 'https://docs.opencv.org/4.9.0/opencv.js';
  const JSQR_URL = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';

  /* ---------- small helpers ---------- */
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
  const extFor = t => /mp4/.test(t) ? 'mp4' : /webm/.test(t) ? 'webm' : /png/.test(t) ? 'png' : 'jpg';

  /* ---------- IndexedDB (offline queue, thumbnails, QR history) ---------- */
  const idb = (() => {
    let p;
    const open = () => p ||= new Promise((res, rej) => {
      const r = indexedDB.open('custom-camera', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
        d.createObjectStore('thumbs');
        d.createObjectStore('qrlog', { keyPath: 'id', autoIncrement: true });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    async function tx(store, mode, fn) {
      const d = await open();
      return new Promise((res, rej) => {
        const t = d.transaction(store, mode);
        const rq = fn(t.objectStore(store));
        t.oncomplete = () => res(rq && rq.result);
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error);
      });
    }
    return {
      add: (s, v) => tx(s, 'readwrite', o => o.add(v)),
      put: (s, v, k) => tx(s, 'readwrite', o => o.put(v, k)),
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
    else if (l === 'rec') finishRec(true);
  });
  function pushLayer(name) { layers.push(name); history.pushState({ l: name }, ''); }

  /* ---------- Google Drive ---------- */
  let needReconnect = false;
  const Drive = {
    token: null, exp: 0, client: null,
    configured() { return !!CFG.GOOGLE_CLIENT_ID && !CFG.GOOGLE_CLIENT_ID.startsWith('PASTE'); },
    connected() { return localStorage.getItem('cc_drive') === '1'; },
    async init() {
      await loadScript('https://accounts.google.com/gsi/client');
      this.client = google.accounts.oauth2.initTokenClient({ client_id: CFG.GOOGLE_CLIENT_ID, scope: SCOPE, callback: () => {} });
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
            localStorage.setItem('cc_drive', '1'); needReconnect = false; res(this.token);
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
      try { f = JSON.parse(localStorage.getItem('cc_folders') || 'null'); } catch { }
      if (f) return f;
      const root = await this.findOrCreate(ROOT, 'root');
      f = { root };
      for (const k of Object.keys(FOLDER_NAMES)) f[k] = await this.findOrCreate(FOLDER_NAMES[k], root);
      localStorage.setItem('cc_folders', JSON.stringify(f));
      return f;
    },
    async withFolder(kind, fn) {
      try { return await fn((await this.folders())[kind]); }
      catch (e) {
        if (e.status === 404) { localStorage.removeItem('cc_folders'); return fn((await this.folders())[kind]); }
        throw e;
      }
    },
    async upload(kind, name, blob) {
      return this.withFolder(kind, async fid => {
        const tok = await this.getToken();
        const type = blob.type || 'application/octet-stream';
        const init = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': type },
          body: JSON.stringify({ name, parents: [fid] })
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
          const r = await this.api(`/drive/v3/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,name,mimeType,createdTime,thumbnailLink)&orderBy=createdTime desc&pageSize=200${pt ? '&pageToken=' + pt : ''}`);
          out.push(...r.files.map(f => ({ id: f.id, name: f.name, kind, mime: f.mimeType, created: Date.parse(f.createdTime), thumb: f.thumbnailLink })));
          pt = r.nextPageToken;
        } while (pt && out.length < 2000);
        return out;
      });
    },
    async media(id) { const r = await this.api('/drive/v3/files/' + id + '?alt=media', { raw: true }); return r.blob(); },
    trash(id) { return this.api('/drive/v3/files/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) }); },
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
        await Drive.upload(it.kind, it.name, it.blob);
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
    const connected = Drive.connected() && !needReconnect;
    $('#cloud').dataset.state = connected ? (n ? 'wait' : 'ok') : 'off';
    $('#cloudText').textContent = needReconnect ? 'Reconnect' : !Drive.connected() ? 'Connect' : n ? n + ' waiting' : 'Drive';
  }
  async function connectDrive() {
    if (!Drive.configured()) { toast('Google sign-in is not set up yet'); return false; }
    try {
      await Drive.getToken(true);
      await Drive.folders();
      toast('Google Drive connected');
      updateCloudChip(); renderOnboard(); flushQueue();
      return true;
    } catch (e) { console.warn(e); toast('Could not connect to Google'); return false; }
  }

  async function saveItem(kind, blob, thumb) {
    const name = `${PREFIX[kind]}_${stamp()}.${extFor(blob.type)}`;
    await idb.add('queue', { kind, name, blob, created: Date.now() });
    if (thumb) { await idb.put('thumbs', thumb, name); await idb.put('thumbs', thumb, '__latest'); setLatest(thumb); }
    updateCloudChip();
    flushQueue();
  }
  let latestURL = null;
  function setLatest(blob) {
    if (latestURL) URL.revokeObjectURL(latestURL);
    latestURL = URL.createObjectURL(blob);
    $('#thumbImg').src = latestURL; $('#thumb').classList.add('has');
  }

  /* ---------- camera ---------- */
  const vf = $('#viewfinder');
  const ov = $('#overlay'), octx = ov.getContext('2d');
  let stream = null, track = null, imageCapture = null, photoOpts = null, busy = false;

  async function startCamera() {
    stopCamera();
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 } }, audio: false
      });
    } catch (e1) {
      try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }); }
      catch (e2) { $('#camError').hidden = false; return false; }
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
  function grabFrame() {
    const c = document.createElement('canvas');
    c.width = vf.videoWidth; c.height = vf.videoHeight;
    c.getContext('2d').drawImage(vf, 0, 0);
    return c;
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
  function flash() {
    const f = $('#flash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
    if (navigator.vibrate) navigator.vibrate(25);
  }

  /* tap to focus */
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
      const adv = { pointsOfInterest: [{ x, y }] };
      if (caps.focusMode && caps.focusMode.includes('single-shot')) adv.focusMode = 'single-shot';
      if (caps.exposureMode && caps.exposureMode.includes('single-shot')) adv.exposureMode = 'single-shot';
      await track.applyConstraints({ advanced: [adv] });
      setTimeout(() => {
        const a = {};
        if (caps.focusMode && caps.focusMode.includes('continuous')) a.focusMode = 'continuous';
        if (caps.exposureMode && caps.exposureMode.includes('continuous')) a.exposureMode = 'continuous';
        if (track && Object.keys(a).length) track.applyConstraints({ advanced: [a] }).catch(() => { });
      }, 3000);
    } catch { }
  }

  /* photo */
  async function takeStill() {
    let blob = null;
    if (imageCapture) { try { blob = await imageCapture.takePhoto(photoOpts || undefined); } catch { } }
    if (!blob) blob = await toBlob(grabFrame(), 'image/jpeg', 0.95);
    return blob;
  }
  async function capturePhoto() {
    if (busy || !track) return;
    busy = true; flash(); click();
    try {
      const blob = await takeStill();
      const bmp = await createImageBitmap(blob);
      const th = await makeThumb(bmp); if (bmp.close) bmp.close();
      await saveItem('photo', blob, th);
    } catch (e) { console.error(e); toast('Could not take the photo'); }
    busy = false;
  }

  /* video */
  let rec = null, recChunks = [], recStart = 0, recAcc = 0, recTimer = null, micStream = null, recMime = '', recThumb = null;
  function pickMime() {
    const c = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    return c.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
  }
  async function toggleRec() {
    if (!rec) return startRec();
    if (rec.state === 'recording') { rec.pause(); recAcc += Date.now() - recStart; paintRec(); }
    else if (rec.state === 'paused') { rec.resume(); recStart = Date.now(); paintRec(); }
  }
  async function startRec() {
    if (!track || !stream) return;
    try { micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch { micStream = null; toast('Microphone is blocked, recording without sound'); }
    const ms = new MediaStream([...stream.getVideoTracks(), ...(micStream ? micStream.getAudioTracks() : [])]);
    recMime = pickMime();
    try {
      rec = new MediaRecorder(ms, { ...(recMime ? { mimeType: recMime } : {}), videoBitsPerSecond: 16000000, audioBitsPerSecond: 128000 });
    } catch (e) { toast('Video recording is not supported here'); cleanupMic(); rec = null; return; }
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
    try { recThumb = thumbCanvas(vf); } catch { recThumb = null; }
    try { rec.stop(); } catch { }
    const i = layers.lastIndexOf('rec'); if (i >= 0) layers.splice(i, 1);
    if (!fromPop && document.visibilityState === 'visible') { ignorePop++; history.back(); }
  }
  async function onRecStop() {
    clearInterval(recTimer);
    const base = ((rec && rec.mimeType) || recMime || 'video/webm').split(';')[0];
    const blob = new Blob(recChunks, { type: base });
    recChunks = []; rec = null; cleanupMic(); paintRec();
    if (blob.size < 2000) return;
    let th = null;
    try { if (recThumb) th = await toBlob(recThumb, 'image/jpeg', 0.72); } catch { }
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
  function enhance(m) {
    const rgb = new cv.Mat(), bg = new cv.Mat(), out = new cv.Mat(), blur = new cv.Mat(), sharp = new cv.Mat(), fin = new cv.Mat();
    cv.cvtColor(m, rgb, cv.COLOR_RGBA2RGB);
    const sigma = Math.max(8, Math.min(rgb.cols, rgb.rows) / 14);
    cv.GaussianBlur(rgb, bg, new cv.Size(0, 0), sigma);       // paper colour + shadows
    cv.divide(rgb, bg, out, 255, -1);                         // flatten lighting, white paper
    cv.GaussianBlur(out, blur, new cv.Size(0, 0), 1.6);
    cv.addWeighted(out, 1.6, blur, -0.6, 0, sharp);           // crisp text
    sharp.convertTo(fin, -1, 1.12, -14);                      // punch up contrast
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
    return b;
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
      const cleaned = enhance(src); src.delete();
      const oc = document.createElement('canvas'); cv.imshow(oc, cleaned); cleaned.delete();
      out = oc;
    } catch (e) { console.warn('scan fallback', e); out = simpleEnhance(c); }
    return { blob: await shrink(out), found };
  }
  async function scanCapture() {
    if (busy || !track) return;
    busy = true; flash(); click();
    const btn = $('#scanBtn'); btn.classList.add('working');
    try {
      const raw = await takeStill();
      const { blob, found } = await processScan(raw);
      const bmp = await createImageBitmap(blob);
      const th = await makeThumb(bmp); if (bmp.close) bmp.close();
      await saveItem('scan', blob, th);
      toast((found ? 'Scan saved' : 'Saved, page edges not found') + ' · ' + Math.round(blob.size / 1024) + ' KB');
    } catch (e) { console.error(e); toast('Scan failed'); }
    btn.classList.remove('working'); busy = false;
  }
  function sizeOverlay() { const d = devicePixelRatio || 1; ov.width = innerWidth * d; ov.height = innerHeight * d; }
  function drawQuad(q) {
    octx.clearRect(0, 0, ov.width, ov.height);
    if (!q || !vf.videoWidth) return;
    const d = devicePixelRatio || 1, r = vf.getBoundingClientRect(), vw = vf.videoWidth, vh = vf.videoHeight;
    const sc = Math.max(r.width / vw, r.height / vh), ox = (r.width - vw * sc) / 2, oy = (r.height - vh * sc) / 2;
    const P = q.map(p => ({ x: (p.x * sc + ox) * d, y: (p.y * sc + oy) * d }));
    octx.beginPath(); P.forEach((p, i) => i ? octx.lineTo(p.x, p.y) : octx.moveTo(p.x, p.y)); octx.closePath();
    octx.fillStyle = 'rgba(52,225,160,.16)'; octx.fill();
    octx.lineWidth = 4 * d; octx.lineJoin = 'round'; octx.strokeStyle = '#34e1a0'; octx.stroke();
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

  /* ---------- QR ---------- */
  let qrTimer = null, qrPause = 0, detector = null;
  async function decodeQR(src, w, h) {
    if ('BarcodeDetector' in window) {
      try {
        detector ||= new BarcodeDetector({ formats: ['qr_code'] });
        const r = await detector.detect(src);
        if (r[0]) return r[0].rawValue;
        return null;
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
      if (Date.now() > qrPause && vf.videoWidth) {
        const text = await decodeQR(vf, vf.videoWidth, vf.videoHeight);
        if (text) handleQR(text);
      }
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

  /* ---------- modes, gestures ---------- */
  let mode = 'photo';
  const HINTS = { photo: 'Tap to focus · double-tap to capture', video: 'Tap the bar to start recording', scan: 'Hold steady over the document', qr: 'Point at a QR code' };
  let hintT;
  function showHint(t) { const el = $('#hint'); el.textContent = t; el.classList.add('show'); clearTimeout(hintT); hintT = setTimeout(() => el.classList.remove('show'), 2400); }
  function stopLoops() { clearTimeout(scanLoop); clearTimeout(qrTimer); octx.clearRect(0, 0, ov.width, ov.height); }
  function startLoops() {
    if (mode === 'scan') { loadCV().catch(() => toast('Edge detection needs internet the first time')); scanTick(); }
    if (mode === 'qr') qrTick();
  }
  function setMode(m) {
    if (m === mode) return;
    if (rec) finishRec();
    mode = m; document.body.dataset.mode = m;
    $('#tabs').style.setProperty('--i', MODES.indexOf(m));
    $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
    stopLoops(); startLoops(); showHint(HINTS[m]);
  }
  const stepMode = d => { const i = MODES.indexOf(mode) + d; if (i >= 0 && i < MODES.length) setMode(MODES[i]); };

  let tStart = null, lastTap = { t: 0, x: 0, y: 0 };
  const touch = $('#touch');
  touch.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) { tStart = null; return; }
    const t = e.touches[0]; tStart = { x: t.clientX, y: t.clientY, t: Date.now() };
  }, { passive: true });
  touch.addEventListener('touchend', e => {
    if (!tStart) return;
    const t = e.changedTouches[0], dx = t.clientX - tStart.x, dy = t.clientY - tStart.y, dt = Date.now() - tStart.t;
    tStart = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) { stepMode(dx < 0 ? 1 : -1); return; }
    if (Math.abs(dx) < 16 && Math.abs(dy) < 16 && dt < 450) onTap(t.clientX, t.clientY);
  });
  function onTap(x, y) {
    const now = Date.now();
    if (mode === 'photo') {
      if (now - lastTap.t < 340 && Math.hypot(x - lastTap.x, y - lastTap.y) < 70) { lastTap.t = 0; capturePhoto(); return; }
      lastTap = { t: now, x, y };
    }
    focusAt(x, y);
  }

  /* ---------- gallery ---------- */
  const gal = { section: 'all', items: [], view: [], qr: [], loading: false };
  const emptyText = () => gal.section === 'qr' ? 'No QR codes scanned yet.' : Drive.connected() ? 'Nothing here yet. Capture something!' : 'Connect Google Drive to see everything you have saved.';

  async function openGallery() {
    if (rec) finishRec();
    $('#gallery').hidden = false; pushLayer('gallery'); loadGallery();
  }
  function hideGallery() { $('#gallery').hidden = true; }

  async function loadGallery() {
    gal.loading = true; renderGallery();
    const pending = await idb.all('queue').catch(() => []);
    let remote = [], ok = false;
    if (Drive.connected() && navigator.onLine) {
      try {
        for (const k of ['photo', 'video', 'scan']) remote.push(...await Drive.list(k));
        ok = true; localStorage.setItem('cc_list', JSON.stringify(remote));
      } catch (e) { console.warn(e); if (isAuthErr(e)) { needReconnect = true; updateCloudChip(); toast('Tap Reconnect to refresh your Drive'); } }
    }
    if (!ok) { try { remote = JSON.parse(localStorage.getItem('cc_list') || '[]'); } catch { remote = []; } }
    const names = new Set(remote.map(r => r.name));
    const pend = pending.filter(p => !names.has(p.name)).map(p => ({ id: 'q' + p.id, qid: p.id, name: p.name, kind: p.kind, mime: p.blob.type, created: p.created, pending: true, blob: p.blob }));
    gal.items = [...pend, ...remote].sort((a, b) => b.created - a.created);
    gal.qr = (await idb.all('qrlog').catch(() => [])).sort((a, b) => b.time - a.time);
    gal.loading = false; renderGallery(); updateCloudChip();
    if (!$('#thumb').classList.contains('has') && gal.items[0]) { const t = gal.items[0].thumb; if (t) { $('#thumbImg').src = t.replace(/=s\d+$/, '=s160'); $('#thumb').classList.add('has'); } }
  }

  function cell(it, idx) {
    const img = h('img', { alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
    const local = async () => { const b = await idb.get('thumbs', it.name).catch(() => null); if (b) img.src = URL.createObjectURL(b); };
    if (it.thumb && !it.pending) { img.src = it.thumb.replace(/=s\d+$/, '=s240'); img.onerror = () => { img.onerror = null; local(); }; }
    else local();
    return h('button', { class: 'cell ' + it.kind, 'aria-label': it.kind, onclick: () => openViewer(idx) },
      img,
      it.kind === 'video' ? h('span', { class: 'badge play', text: '▶' }) : null,
      it.pending ? h('span', { class: 'badge wait', text: '↑' }) : null);
  }
  function renderQRList(body) {
    if (!gal.qr.length) { body.append(h('div', { class: 'empty', text: emptyText() })); return; }
    gal.qr.forEach(q => body.append(h('button', { class: 'qrow', onclick: () => handleQR(q.text) },
      h('div', { class: 'qt', text: q.text }), h('div', { class: 'qd', text: fmtDate(q.time) }))));
  }
  function renderGallery() {
    const body = $('#galBody'); body.replaceChildren();
    $$('#galTabs button').forEach(b => b.classList.toggle('on', b.dataset.sec === gal.section));
    if (gal.section === 'qr') { renderQRList(body); return; }
    const list = gal.items.filter(i => gal.section === 'all' || i.kind === gal.section);
    gal.view = list;
    if (!list.length) { body.append(h('div', { class: 'empty', text: gal.loading ? 'Loading…' : emptyText() })); return; }
    let y = null, m = null, d = null, grid = null;
    list.forEach((it, idx) => {
      const dt = new Date(it.created), ny = dt.getFullYear(), nm = dt.getMonth(), nd = dt.getDate();
      if (ny !== y) { y = ny; m = null; d = null; body.append(h('h2', { class: 'yr', text: String(y) })); }
      if (nm !== m) { m = nm; d = null; body.append(h('h3', { class: 'mo', text: dt.toLocaleString(undefined, { month: 'long' }) })); }
      if (nd !== d) {
        d = nd; body.append(h('h4', { class: 'dy', text: dt.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) }));
        grid = h('div', { class: 'grid' }); body.append(grid);
      }
      grid.append(cell(it, idx));
    });
  }

  /* ---------- viewer ---------- */
  const view = { i: 0, url: null, blob: null };
  const mediaCache = new Map();
  async function mediaBlob(it) {
    if (mediaCache.has(it.id)) return mediaCache.get(it.id);
    const b = await Drive.media(it.id);
    mediaCache.set(it.id, b); if (mediaCache.size > 6) mediaCache.delete(mediaCache.keys().next().value);
    return b;
  }
  async function openViewer(i) { view.i = i; $('#viewer').hidden = false; pushLayer('viewer'); await showItem(); }
  function hideViewer() {
    $('#viewer').hidden = true; $('#vStage').replaceChildren();
    if (view.url) URL.revokeObjectURL(view.url); view.url = null; view.blob = null;
  }
  async function showItem() {
    const it = gal.view[view.i]; if (!it) return;
    const stage = $('#vStage');
    if (view.url) URL.revokeObjectURL(view.url); view.url = null; view.blob = null;
    stage.replaceChildren(h('div', { class: 'spin' }));
    $('#vTitle').textContent = fmtDate(it.created);
    $('#vSub').textContent = it.pending ? 'Waiting to upload' : it.name;
    try {
      const blob = it.pending ? it.blob : await mediaBlob(it);
      if (gal.view[view.i] !== it) return;
      view.blob = blob; view.url = URL.createObjectURL(blob);
      stage.replaceChildren(it.kind === 'video' ? h('video', { src: view.url, controls: '', playsinline: '', autoplay: '' }) : h('img', { src: view.url, alt: '' }));
    } catch (e) { stage.replaceChildren(h('div', { class: 'empty', text: 'Could not load. Check your connection.' })); }
  }
  function stepViewer(d) { const n = view.i + d; if (n >= 0 && n < gal.view.length) { view.i = n; showItem(); } }
  let vs = null;
  $('#vStage').addEventListener('touchstart', e => { vs = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null; }, { passive: true });
  $('#vStage').addEventListener('touchend', e => {
    if (!vs) return; const t = e.changedTouches[0], dx = t.clientX - vs.x, dy = t.clientY - vs.y; vs = null;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) stepViewer(dx < 0 ? 1 : -1);
  });
  let delArm = 0;
  async function onDelete() {
    const btn = $('#vDel');
    if (!delArm) { btn.classList.add('arm'); toast('Tap delete again to confirm'); delArm = setTimeout(() => { delArm = 0; btn.classList.remove('arm'); }, 3000); return; }
    clearTimeout(delArm); delArm = 0; btn.classList.remove('arm');
    const it = gal.view[view.i]; if (!it) return;
    try {
      if (it.pending) { await idb.del('queue', it.qid); } else { await Drive.trash(it.id); }
      await idb.del('thumbs', it.name).catch(() => { });
      gal.items = gal.items.filter(x => x !== it);
      localStorage.setItem('cc_list', JSON.stringify(gal.items.filter(x => !x.pending)));
      renderGallery(); updateCloudChip();
      if (!gal.view.length) { history.back(); return; }
      view.i = Math.min(view.i, gal.view.length - 1); showItem(); toast('Deleted');
    } catch (e) { console.warn(e); toast('Could not delete'); }
  }
  async function onShare() {
    const it = gal.view[view.i]; if (!it || !view.blob) return;
    try {
      const file = new File([view.blob], it.name, { type: view.blob.type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file] });
      else { const a = h('a', { href: URL.createObjectURL(view.blob), download: it.name }); document.body.append(a); a.click(); a.remove(); }
    } catch (e) { if (e.name !== 'AbortError') toast('Could not share'); }
  }

  /* ---------- onboarding: install first, then connect Drive ---------- */
  let deferredInstall = null;
  const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  try { localStorage.removeItem('cc_installed'); } catch { }
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
      $('#obText').textContent = deferredInstall ? 'Add it to your home screen so it opens like a normal app, full screen.' : 'Open the Chrome menu (three dots) and choose Install app. This button goes away once it is installed.';
      $('#obPrimary').textContent = 'Install app';
      $('#obSecondary').textContent = 'Not now';
    } else {
      $('#obTitle').textContent = 'Connect Google Drive';
      $('#obText').textContent = 'One time only. Photos, videos and scans will save into a Custom Camera folder in your Drive.';
      $('#obPrimary').textContent = 'Connect Google Drive';
      $('#obSecondary').textContent = 'Later';
    }
  }
  $('#obPrimary').addEventListener('click', async () => {
    const step = $('#onboard').dataset.step;
    if (step === 'install') {
      if (!deferredInstall) { toast('Use the Chrome menu, then Install app'); return; }
      deferredInstall.prompt();
      const r = await deferredInstall.userChoice.catch(() => ({}));
      deferredInstall = null;
      renderOnboard();
    } else connectDrive();
  });
  $('#obSecondary').addEventListener('click', () => {
    sessionStorage.setItem($('#onboard').dataset.step === 'install' ? 'cc_skip_install' : 'cc_skip_drive', '1');
    renderOnboard();
  });

  /* ---------- wiring ---------- */
  $$('#tabs button').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('#recBtn').addEventListener('click', toggleRec);
  $('#scanBtn').addEventListener('click', scanCapture);
  $('#thumb').addEventListener('click', openGallery);
  $('#galBack').addEventListener('click', () => history.back());
  $('#vClose').addEventListener('click', () => history.back());
  $('#galRefresh').addEventListener('click', loadGallery);
  $('#vShare').addEventListener('click', onShare);
  $('#vDel').addEventListener('click', onDelete);
  $$('#galTabs button').forEach(b => b.addEventListener('click', () => { gal.section = b.dataset.sec; renderGallery(); $('#galBody').scrollTop = 0; }));
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
  $('#cloud').addEventListener('click', () => {
    if (!Drive.connected() || needReconnect) connectDrive();
    else { flushQueue(); updateCloudChip(); toast('Google Drive is connected'); }
  });
  $('#camRetry').addEventListener('click', async () => { if (await startCamera()) startLoops(); });
  addEventListener('resize', sizeOverlay);
  addEventListener('online', flushQueue);
  addEventListener('pagehide', () => finishRec(true));
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') { finishRec(true); stopLoops(); setTimeout(() => { if (document.visibilityState === 'hidden') stopCamera(); }, 800); }
    else { if (!stream) { if (await startCamera()) startLoops(); } flushQueue(); }
  });

  /* ---------- start ---------- */
  (async function init() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
    $$('#tabs button')[0].classList.add('on');
    paintRec(); renderOnboard(); updateCloudChip();
    const lt = await idb.get('thumbs', '__latest').catch(() => null);
    if (lt) setLatest(lt);
    if (Drive.configured()) Drive.init().catch(() => { });
    if (await startCamera()) { showHint(HINTS.photo); startLoops(); }
    flushQueue();
  })();
})();
