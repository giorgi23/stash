/* Stash — offline YouTube playlist for iPhone.
   Videos are stored on the device (IndexedDB) and play without a connection. */
(() => {
  'use strict';

  // ---------- tiny IndexedDB wrapper ----------
  const DB_NAME = 'stash', DB_VERSION = 1;
  let dbPromise;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains('videos')) d.createObjectStore('videos', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }
  async function tx(store, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const s = t.objectStore(store);
      let result;
      Promise.resolve(fn(s)).then(r => { result = r; });
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Storage is full'));
    });
  }
  const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const store = {
    all: () => tx('videos', 'readonly', s => reqP(s.getAll())),
    get: id => tx('videos', 'readonly', s => reqP(s.get(id))),
    put: v => tx('videos', 'readwrite', s => { s.put(v); }),
    del: id => tx('videos', 'readwrite', s => { s.delete(id); }),
    getBlob: id => tx('blobs', 'readonly', s => reqP(s.get(id))),
    putBlob: (id, b) => tx('blobs', 'readwrite', s => { s.put(b, id); }),
    delBlob: id => tx('blobs', 'readwrite', s => { s.delete(id); }),
  };

  // ---------- settings ----------
  const settings = {
    get url() { return (localStorage.getItem('stash.server') || '').replace(/\/+$/, ''); },
    set url(v) { localStorage.setItem('stash.server', v.trim().replace(/\/+$/, '')); },
    get token() { return localStorage.getItem('stash.token') || ''; },
    set token(v) { localStorage.setItem('stash.token', v.trim()); },
    get ok() { return !!this.url; },
  };

  // ---------- helpers ----------
  const $ = sel => document.querySelector(sel);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const fmtDur = s => {
    if (!s && s !== 0) return '';
    s = Math.round(s);
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  };
  const fmtSize = b => !b ? '' : b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b < 1e6 ? '<1 MB' : Math.round(b / 1e6) + ' MB';

  function parseYouTubeId(input) {
    try {
      const u = new URL(input.trim());
      const host = u.hostname.replace(/^www\.|^m\.|^music\./, '');
      if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
      if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
        if (u.searchParams.get('v')) return u.searchParams.get('v');
        const m = u.pathname.match(/^\/(shorts|live|embed|v)\/([\w-]{6,})/);
        if (m) return m[2];
      }
    } catch (_) { /* not a URL */ }
    const bare = input.trim().match(/^[\w-]{11}$/);
    return bare ? bare[0] : null;
  }

  async function api(path, opts = {}) {
    const res = await fetch(settings.url + path, {
      ...opts,
      headers: { 'X-Token': settings.token, ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
    });
    if (!res.ok) {
      let msg = `Server error ${res.status}`;
      try { msg = (await res.json()).error || msg; } catch (_) {}
      const err = new Error(msg); err.status = res.status; throw err;
    }
    return res;
  }

  // ---------- banner ----------
  const banner = $('#banner');
  function showBanner(text) { banner.textContent = text; banner.hidden = !text; }
  function baseBanner() {
    const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
    const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
    if (isIOS && !standalone) return 'Tip: tap Share → "Add to Home Screen" first. Videos saved in a Safari tab are stored separately from the home-screen app.';
    if (!navigator.onLine) return "You're offline — saved videos still play.";
    return '';
  }
  const refreshBanner = () => { if (!downloading) showBanner(baseBanner()); };

  // ---------- rendering ----------
  let filter = 'unwatched';
  const thumbURLs = new Map();
  function thumbSrc(v) {
    if (v.thumbBlob) {
      if (!thumbURLs.has(v.id)) thumbURLs.set(v.id, URL.createObjectURL(v.thumbBlob));
      return thumbURLs.get(v.id);
    }
    return v.ytId ? `https://i.ytimg.com/vi/${v.ytId}/mqdefault.jpg` : '';
  }

  function stateText(v) {
    switch (v.status) {
      case 'queued': return 'Waiting…';
      case 'working': return v.stateText || 'Working…';
      case 'error': return v.error || 'Failed';
      case 'ready': return `Offline · ${fmtSize(v.size)}`;
      default: return '';
    }
  }

  async function render() {
    const vids = (await store.all()).sort((a, b) => b.addedAt - a.addedAt);
    const shown = vids.filter(v => filter === 'all' ? true : filter === 'watched' ? v.watched : !v.watched);
    const list = $('#list');
    list.textContent = '';
    const tpl = $('#itemTpl');
    for (const v of shown) {
      const el = tpl.content.firstElementChild.cloneNode(true);
      el.dataset.id = v.id;
      el.classList.add(v.status);
      if (v.watched) el.classList.add('watched');
      const img = el.querySelector('img');
      img.onerror = () => { img.style.visibility = 'hidden'; };
      const src = thumbSrc(v);
      if (src) img.src = src; else img.style.visibility = 'hidden';
      el.querySelector('.dur').textContent = fmtDur(v.duration);
      el.querySelector('.dur').hidden = !v.duration;
      el.querySelector('.watchbar').hidden = !(v.position > 5 && v.duration);
      el.querySelector('.watchbar div').style.width = v.duration ? Math.min(100, v.position / v.duration * 100) + '%' : 0;
      el.querySelector('.title').textContent = v.title || 'Loading…';
      el.querySelector('.sub').textContent = v.channel || '';
      el.querySelector('.dlbar div').style.width = (v.progress || 0) + '%';
      el.querySelector('.state').textContent = stateText(v);
      el.addEventListener('click', async e => {
        if (e.target.closest('.more')) return openMenu(v.id);
        const fresh = await store.get(v.id); // status may have changed since this row was drawn
        if (!fresh) return;
        if (fresh.status === 'ready') play(v.id);
        else if (fresh.status === 'error') openMenu(v.id);
      });
      list.appendChild(el);
    }
    const empty = $('#empty');
    empty.hidden = shown.length > 0;
    empty.textContent = vids.length === 0
      ? 'Nothing stashed yet. Download a video with any YouTube downloader site, then tap "Import video".'
      : filter === 'watched' ? 'Nothing watched yet.' : 'All caught up.';
    updateStorage();
  }

  // Update one row in place (avoids re-rendering on every progress tick)
  function paintRow(v) {
    const el = document.querySelector(`.item[data-id="${v.id}"]`);
    if (!el) return;
    el.className = `item ${v.status}${v.watched ? ' watched' : ''}`;
    el.querySelector('.title').textContent = v.title || 'Loading…';
    el.querySelector('.sub').textContent = v.channel || '';
    el.querySelector('.dur').textContent = fmtDur(v.duration);
    el.querySelector('.dur').hidden = !v.duration;
    el.querySelector('.dlbar div').style.width = (v.progress || 0) + '%';
    el.querySelector('.state').textContent = stateText(v);
  }

  async function updateStorage() {
    if (!navigator.storage?.estimate) return;
    const { usage = 0 } = await navigator.storage.estimate();
    $('#storage').textContent = usage > 5e6 ? `${fmtSize(usage)} used` : '';
  }

  // ---------- adding ----------
  async function addUrl(raw) {
    const ytId = parseYouTubeId(raw || '');
    if (!ytId) { alert("That doesn't look like a YouTube link."); return; }
    if (!settings.ok) { alert('Downloading from a link needs the server (Settings). Easiest: download the video with any downloader site and tap "Import video".'); return; }
    const existing = await store.get(ytId);
    if (existing) {
      if (existing.status === 'error') { existing.status = 'queued'; existing.error = ''; await store.put(existing); render(); pump(); }
      else alert('Already in your stash.');
      return;
    }
    const v = {
      id: ytId, ytId, url: `https://www.youtube.com/watch?v=${ytId}`,
      title: '', channel: '', duration: 0, status: 'queued', progress: 0,
      position: 0, watched: false, addedAt: Date.now(),
    };
    await store.put(v);
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    render();
    fetchThumb(v.id);
    pump();
  }

  async function fetchThumb(id) {
    try {
      const res = await fetch(`https://i.ytimg.com/vi/${id}/mqdefault.jpg`);
      if (!res.ok) return;
      const blob = await res.blob();
      const v = await store.get(id);
      if (v) { v.thumbBlob = blob; await store.put(v); }
    } catch (_) { /* thumbnail is optional */ }
  }

  // ---------- download queue (one at a time) ----------
  let downloading = false;

  async function wakeServer() {
    const started = Date.now();
    while (Date.now() - started < 120000) {
      try {
        const res = await fetch(settings.url + '/health', { cache: 'no-store' });
        if (res.ok) return;
      } catch (_) {}
      showBanner('Waking up the server (free servers sleep when idle, takes up to a minute)…');
      await sleep(3000);
    }
    throw new Error("Couldn't reach the server. Check Settings.");
  }

  async function pump() {
    if (downloading || !settings.ok || !navigator.onLine) { refreshBanner(); return; }
    const next = (await store.all()).filter(v => v.status === 'queued').sort((a, b) => a.addedAt - b.addedAt)[0];
    if (!next) { refreshBanner(); return; }
    downloading = true;
    showBanner('Downloading — keep Stash open until it finishes.');
    try { await download(next); }
    finally { downloading = false; }
    pump();
  }

  async function download(v) {
    const set = async (patch, persist = false) => {
      Object.assign(v, patch);
      paintRow(v);
      if (persist) await store.put(v);
    };
    try {
      await set({ status: 'working', stateText: 'Connecting…', progress: 2 }, true);
      await wakeServer();
      showBanner('Downloading — keep Stash open until it finishes.');

      if (!v.title) {
        await set({ stateText: 'Getting info…' });
        const info = await (await api('/info?url=' + encodeURIComponent(v.url))).json();
        await set({ title: info.title, channel: info.channel, duration: info.duration }, true);
      }

      // 1) the server downloads from YouTube (shown as 0–70%)
      let jobId = v.jobId, job;
      if (jobId) {
        try { job = await (await api(`/jobs/${jobId}`)).json(); } catch (_) { jobId = null; }
      }
      if (!jobId) {
        jobId = (await (await api('/jobs', { method: 'POST', body: JSON.stringify({ url: v.url }) })).json()).id;
        await set({ jobId }, true);
      }
      for (;;) {
        job = await (await api(`/jobs/${jobId}`)).json();
        if (job.status === 'error') throw new Error(job.error);
        if (job.status === 'done') break;
        const p = job.progress || 0;
        await set({
          stateText: job.stage === 'processing' ? 'Preparing video…' : `Fetching ${Math.round(p)}%`,
          progress: Math.max(v.progress, 3 + p * 0.67),
        });
        await sleep(1500);
      }

      // 2) the phone pulls the finished file (shown as 70–100%)
      await set({ stateText: 'Saving to iPhone…', progress: 70 });
      const res = await api(`/jobs/${jobId}/file`);
      const total = Number(res.headers.get('Content-Length')) || job.size || 0;
      const reader = res.body.getReader();
      const chunks = []; let got = 0, lastPaint = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); got += value.length;
        if (total && Date.now() - lastPaint > 300) {
          lastPaint = Date.now();
          await set({ stateText: `Saving ${Math.round(got / total * 100)}% · ${fmtSize(got)}`, progress: 70 + got / total * 30 });
        }
      }
      const blob = new Blob(chunks, { type: 'video/mp4' });
      try { await store.putBlob(v.id, blob); }
      catch (e) { throw new Error('Not enough storage on your iPhone for this video.'); }
      await set({ status: 'ready', progress: 100, size: blob.size, jobId: null, stateText: '' }, true);
      if (!v.thumbBlob) fetchThumb(v.id);
      updateStorage();
    } catch (e) {
      const offline = !navigator.onLine;
      await set({
        status: offline ? 'queued' : 'error',
        error: offline ? '' : (e.status === 401 ? 'Wrong access token — check Settings.' : e.message),
        jobId: e.status === 404 ? null : v.jobId,
        progress: 0,
      }, true);
    }
  }

  // ---------- player ----------
  let current = null, currentURL = null, lastSave = 0;
  const video = $('#video');

  async function play(id) {
    const v = await store.get(id);
    const blob = await store.getBlob(id);
    if (!blob) { alert('Video file missing — try deleting and re-adding it.'); return; }
    current = v;
    currentURL = URL.createObjectURL(blob);
    $('#playerTitle').textContent = v.title || '';
    $('#player').hidden = false;
    video.src = currentURL;
    video.onloadedmetadata = () => {
      if (v.position > 5 && v.position < video.duration - 10) video.currentTime = v.position;
      if (!v.duration) v.duration = video.duration;
    };
    video.play().catch(() => {});
  }

  async function savePosition(force) {
    if (!current) return;
    if (!force && Date.now() - lastSave < 4000) return;
    lastSave = Date.now();
    const v = await store.get(current.id);
    if (!v) return;
    v.position = video.currentTime || 0;
    if (video.duration && v.position / video.duration > 0.95) v.watched = true;
    current = v;
    await store.put(v);
  }

  video.addEventListener('timeupdate', () => savePosition(false));
  video.addEventListener('pause', () => savePosition(true));
  video.addEventListener('ended', async () => {
    if (!current) return;
    const v = await store.get(current.id);
    v.watched = true; v.position = 0;
    await store.put(v);
  });

  async function closePlayer() {
    await savePosition(true);
    video.pause();
    video.removeAttribute('src'); video.load();
    if (currentURL) URL.revokeObjectURL(currentURL);
    current = currentURL = null;
    $('#player').hidden = true;
    render();
  }
  $('#closePlayer').addEventListener('click', closePlayer);

  // ---------- item menu ----------
  async function openMenu(id) {
    const v = await store.get(id);
    if (!v) return;
    const wrap = document.createElement('div');
    wrap.className = 'menu-wrap';
    const menu = document.createElement('div');
    menu.className = 'menu';
    const title = document.createElement('p');
    title.textContent = v.title || v.url;
    menu.appendChild(title);
    const add = (label, fn, cls) => {
      const b = document.createElement('button');
      b.textContent = label; if (cls) b.className = cls;
      b.addEventListener('click', async () => { wrap.remove(); await fn(); });
      menu.appendChild(b);
    };
    if (v.status === 'ready') add('Play', () => play(id));
    if (v.status === 'error') {
      const msg = document.createElement('p'); msg.textContent = v.error; msg.style.whiteSpace = 'normal';
      menu.appendChild(msg);
      add('Try again', async () => { v.status = 'queued'; v.error = ''; await store.put(v); render(); pump(); });
    }
    add(v.watched ? 'Mark as not watched' : 'Mark as watched', async () => {
      v.watched = !v.watched; if (!v.watched) v.position = 0; await store.put(v); render();
    });
    add('Rename', async () => {
      const name = prompt('Title', v.title || '');
      if (name && name.trim()) { v.title = name.trim(); await store.put(v); render(); }
    });
    if (v.url) add('Open on YouTube', () => { window.open(v.url, '_blank'); });
    add('Delete', async () => {
      if (!confirm('Delete this video from your iPhone?')) return;
      await store.delBlob(id); await store.del(id);
      if (thumbURLs.has(id)) { URL.revokeObjectURL(thumbURLs.get(id)); thumbURLs.delete(id); }
      render();
    }, 'danger');
    add('Cancel', () => {});
    wrap.appendChild(menu);
    wrap.addEventListener('click', e => { if (e.target === wrap) wrap.remove(); });
    document.body.appendChild(wrap);
  }

  // ---------- settings sheet ----------
  function openSettings() {
    $('#serverUrl').value = settings.url;
    $('#serverToken').value = settings.token;
    $('#testResult').textContent = '';
    $('#settings').hidden = false;
  }
  $('#openSettings').addEventListener('click', openSettings);
  $('#settings').addEventListener('click', e => { if (e.target.id === 'settings') $('#settings').hidden = true; });
  $('#saveSettings').addEventListener('click', () => {
    settings.url = $('#serverUrl').value;
    settings.token = $('#serverToken').value;
    $('#settings').hidden = true;
    refreshBanner();
    pump();
  });
  $('#testConn').addEventListener('click', async () => {
    const out = $('#testResult');
    const url = $('#serverUrl').value.trim().replace(/\/+$/, '');
    const token = $('#serverToken').value.trim();
    out.textContent = 'Checking… (can take a minute if it was asleep)';
    try {
      const h = await fetch(url + '/health', { cache: 'no-store' });
      if (!h.ok) throw new Error('Server not responding');
      const r = await fetch(url + '/jobs/test', { headers: { 'X-Token': token } });
      out.textContent = r.status === 401 ? '✗ Server OK, but the token is wrong' : '✓ Connected';
    } catch (e) {
      out.textContent = '✗ ' + (e.message === 'Failed to fetch' ? "Can't reach that URL" : e.message);
    }
  });

  // ---------- add form ----------
  $('#addForm').addEventListener('submit', e => {
    e.preventDefault();
    const val = $('#urlInput').value;
    $('#urlInput').value = '';
    $('#urlInput').blur();
    addUrl(val);
  });
  $('#pasteBtn').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (parseYouTubeId(text)) { addUrl(text); return; }
      $('#urlInput').value = text;
    } catch (_) {
      $('#urlInput').focus();
    }
  });

  // ---------- import downloaded files ----------
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'video/*,.mp4,.mov,.m4v,.webm';
  fileInput.multiple = true;
  fileInput.hidden = true;
  document.body.appendChild(fileInput);

  const importBtn = document.createElement('button');
  importBtn.type = 'button';
  importBtn.className = 'primary import-btn';
  importBtn.textContent = '＋ Import video';
  $('#addForm').after(importBtn);
  importBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    for (const f of files) await importFile(f);
  });

  const cleanTitle = name => name
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s*[\[(](\d{3,4}p|hd|full hd|720p|1080p)[\])]\s*/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim() || 'Video';

  async function importFile(file) {
    const id = 'f-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    const v = {
      id, ytId: null, url: '', source: 'file',
      title: cleanTitle(file.name || ''), channel: '', duration: 0,
      status: 'working', stateText: 'Saving…', progress: 50,
      size: file.size, position: 0, watched: false, addedAt: Date.now(),
    };
    await store.put(v);
    await render();
    try {
      await store.putBlob(id, file);
    } catch (_) {
      await store.del(id); render();
      alert('Not enough storage on your iPhone for this video.');
      return;
    }
    const meta = await videoMeta(file);
    Object.assign(v, { status: 'ready', progress: 100, stateText: '', duration: meta.duration || 0 });
    if (meta.thumb) v.thumbBlob = meta.thumb;
    await store.put(v);
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    render();
  }

  // Reads duration and grabs a frame for the thumbnail. Never fails: falls back to nothing.
  function videoMeta(file) {
    return new Promise(resolve => {
      const url = URL.createObjectURL(file);
      const el = document.createElement('video');
      let duration = 0, finished = false;
      const finish = thumb => {
        if (finished) return; finished = true;
        URL.revokeObjectURL(url);
        resolve({ duration, thumb });
      };
      setTimeout(() => finish(null), 8000);
      el.muted = true; el.playsInline = true; el.preload = 'auto';
      el.onloadedmetadata = () => {
        duration = isFinite(el.duration) ? el.duration : 0;
        el.currentTime = Math.min(5, duration * 0.1 || 0.1);
      };
      el.onseeked = () => {
        try {
          const c = document.createElement('canvas');
          c.width = 320; c.height = Math.round(320 * (el.videoHeight / el.videoWidth || 9 / 16));
          c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
          c.toBlob(b => finish(b), 'image/jpeg', 0.75);
        } catch (_) { finish(null); }
      };
      el.onerror = () => finish(null);
      el.src = url;
    });
  }

  // ---------- tabs ----------
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
    filter = t.dataset.filter;
    render();
  }));

  // ---------- boot ----------
  addEventListener('online', () => { refreshBanner(); pump(); });
  addEventListener('offline', refreshBanner);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pump(); });

  (async () => {
    // Anything interrupted mid-download (app closed) goes back in the queue.
    for (const v of await store.all()) {
      if (v.status === 'working') { v.status = 'queued'; v.progress = 0; await store.put(v); }
    }
    // Support links like  .../?add=<youtube url>  (used by the iOS Share-sheet shortcut)
    const params = new URLSearchParams(location.search);
    const shared = params.get('add') || params.get('url') || params.get('text');
    if (shared) {
      history.replaceState(null, '', location.pathname);
      const match = shared.match(/https?:\/\/\S+/);
      await addUrl(match ? match[0] : shared);
    }
    await render();
    refreshBanner();
    pump();
  })();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
