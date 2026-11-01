(() => {
  'use strict';
  if (window.__logoIntroLoaded) return;
  window.__logoIntroLoaded = true;

  const CFG = {
    clipUrl: 'logo-intro.mp4',     // resolved relative to /web/ (works with a base URL too)
    videoSelector: 'video.htmlvideoplayer',
    sessionGraceMs: 2500,          // gap allowed between episodes before the session counts as ended
    osdWaitMs: 2500,               // max wait for the player UI before showing the clip anyway
    infoMaxAgeMs: 20000,           // how long a PlaybackInfo observation stays valid
    debug: false,
  };
  const log = (...a) => CFG.debug && console.log('[LogoIntro]', ...a);

  // hide Jellyfin's loading spinner while the clip is showing
  const style = document.createElement('style');
  style.textContent =
    'html.logo-intro-active .docspinner,html.logo-intro-active .mdl-spinner{display:none!important}';
  document.documentElement.appendChild(style);

  // ---- 1. observe PlaybackInfo requests (resume detection) ----
  let lastInfo = null;
  const rx = /\/Items\/([0-9a-f-]{32,36})\/PlaybackInfo/i;

  function ticksFromObject(obj) {
    for (const k of Object.keys(obj || {}))
      if (k.toLowerCase() === 'starttimeticks') return Number(obj[k]) || 0;
    return null;
  }

  function lookupSavedPosition(id) {
    try {
      const c = window.ApiClient;
      return Promise.resolve(c.getItem(c.getCurrentUserId(), id))
        .then((it) => Number(it?.UserData?.PlaybackPositionTicks) || 0)
        .catch(() => 0);
    } catch { return Promise.resolve(0); }
  }

  function noteRequest(url, body) {
    try {
      const s = String(url);
      const m = rx.exec(s);
      if (!m) return;
      let ticks = null;
      for (const [k, v] of new URL(s, location.href).searchParams)
        if (k.toLowerCase() === 'starttimeticks') ticks = Number(v) || 0;
      if (ticks === null && typeof body === 'string') {
        try { ticks = ticksFromObject(JSON.parse(body)); } catch { /* not JSON */ }
      }
      const info = { id: m[1], ticks, at: Date.now() };
      info.saved = lookupSavedPosition(m[1]).then((p) => { info.savedTicks = p; return p; });
      lastInfo = info;
      log('PlaybackInfo', { id: info.id, startTicks: ticks });
    } catch { /* ignore */ }
  }

  const _fetch = window.fetch;
  window.fetch = function (input, init) {
    noteRequest(input instanceof Request ? input.url : input, init && init.body);
    return _fetch.apply(this, arguments);
  };
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__liUrl = url;
    return _open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (this.__liUrl) noteRequest(this.__liUrl, body);
    return _send.apply(this, arguments);
  };

  // ---- 2. session state ----
  let sessionActive = false;
  let endTimer = null;
  let activeIntro = null;

  function scheduleEnd() {
    clearTimeout(endTimer);
    endTimer = setTimeout(() => {
      sessionActive = false;
      if (activeIntro) activeIntro.abort();
      log('session ended');
    }, CFG.sessionGraceMs);
  }

  async function isResume() {
    const info = lastInfo;
    if (!info || Date.now() - info.at > CFG.infoMaxAgeMs) { log('no fresh PlaybackInfo'); return false; }
    if (info.ticks > 0) { log('resume (request start position)', info.ticks); return true; }
    const saved = await Promise.race([
      info.saved,
      new Promise((r) => setTimeout(() => r(0), CFG.lookupTimeoutMs)),
    ]);
    log('saved position ticks', saved);
    return saved > 0;
  }

  async function onMediaLoad(video) {
    clearTimeout(endTimer);
    if (sessionActive) { log('same session -> no intro'); return; }
    sessionActive = true;
    if (await isResume()) { log('resume -> no intro'); return; }
    playIntro(video);
  }

  // ---- 3. intro rendered inside the player container, started once the player UI is up ----
  function playerUiReady(main) {
    const onTop = main.closest('.videoPlayerContainer')
      ?.classList.contains('videoPlayerContainer-onTop');
    return location.hash.includes('/video') && !onTop;
  }

  function playIntro(main) {
    if (!main.parentElement) return;
    log('arming intro');

    // preload the clip while the main stream is still starting
    const clip = document.createElement('video');
    clip.dataset.logoIntro = '1';
    clip.preload = 'auto';
    clip.playsInline = true;
    clip.src = new URL(CFG.clipUrl, location.href).href;
    clip.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000;pointer-events:none;';

    const wasMuted = main.muted;
    let t0 = 0, poll = null, done = false, clipStarted = false;

    const hold = () => { if (clipStarted && !main.paused) main.pause(); };

    const cleanup = () => {
      if (done) return false;
      done = true;
      clearInterval(poll);
      main.removeEventListener('playing', onMainPlaying);
      main.removeEventListener('playing', hold);
      clip.pause();
      clip.remove();
      main.style.visibility = '';
      if (!wasMuted) main.muted = false;
      document.documentElement.classList.remove('logo-intro-active');
      activeIntro = null;
      return true;
    };

    const finish = () => {
      if (!cleanup() || !main.isConnected) return;
      try { if (main.currentTime - t0 > 0.05) main.currentTime = t0; } catch { /* ignore */ }
      main.play().catch(() => {});
    };

    const startClip = () => {
      if (done) return;
      clipStarted = true;
      main.pause();                                   // safe now: Jellyfin has finished its own start-up
      main.after(clip);
      main.style.visibility = 'hidden';               // clip takes the main video's place in the stack
      document.documentElement.classList.add('logo-intro-active');
      main.addEventListener('playing', hold);         // ignore play presses during the clip
      clip.addEventListener('ended', finish);
      clip.addEventListener('error', finish);
      clip.play().catch(() => {
        clip.muted = true;
        clip.play().catch(finish);
      });
    };

    function onMainPlaying() {
      main.removeEventListener('playing', onMainPlaying);
      t0 = main.currentTime;
      if (!wasMuted) main.muted = true;               // no main-video audio while we wait
      const started = Date.now();
      poll = setInterval(() => {
        if (done) return;
        const ready = playerUiReady(main);
        if (ready || Date.now() - started > CFG.osdWaitMs) {
          log('player UI', ready ? 'ready' : 'wait timed out', { hash: location.hash });
          clearInterval(poll);
          startClip();
        }
      }, 50);
    }

    activeIntro = { main, abort: cleanup };
    if (!main.paused) onMainPlaying();
    else main.addEventListener('playing', onMainPlaying);
  }

  // ---- 4. wire up video elements ----
  const wired = new WeakSet();
  function wire(video) {
    if (wired.has(video) || video.dataset.logoIntro) return;
    wired.add(video);
    video.addEventListener('loadstart', () => onMediaLoad(video));
    video.addEventListener('emptied', scheduleEnd);
    if (video.currentSrc || video.getAttribute('src')) onMediaLoad(video);
  }
  const scan = (root) => {
    if (root.nodeType !== 1) return;
    if (root.matches(CFG.videoSelector)) wire(root);
    root.querySelectorAll?.(CFG.videoSelector).forEach(wire);
  };
  const hasVideo = (n) =>
    n.nodeType === 1 && !n.dataset?.logoIntro &&
    (n.matches(CFG.videoSelector) || n.querySelector?.(CFG.videoSelector));

  new MutationObserver((muts) => {
    for (const m of muts) {
      m.addedNodes.forEach(scan);
      m.removedNodes.forEach((n) => {
        if (!hasVideo(n)) return;
        // player closed during the clip: stop it immediately
        if (activeIntro && !activeIntro.main.isConnected) activeIntro.abort();
        scheduleEnd();
      });
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  scan(document.body || document.documentElement);
})();