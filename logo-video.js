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

  const mediaProto = (name) => Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, name);
  const realPause = HTMLMediaElement.prototype.pause;
  const realPlay = HTMLMediaElement.prototype.play;  

  function playIntro(main) {
    if (!main.parentElement) return;
    log('arming intro');

    // preload the clip while the main stream is still starting
    const clip = document.createElement('video');
    clip.dataset.logoIntro = '1';
    clip.preload = 'auto';
    clip.playsInline = true;
    clip.src = new URL(CFG.clipUrl, location.href).href;
    clip.volume = main.volume;
    clip.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000;pointer-events:none;';

    const userMuted = main.muted;       // the viewer's real mute state
    let muted = userMuted;              // tracked through the overridden accessor
    let t0 = 0, pendingSeek = null, poll = null, done = false, proxied = false, launched = false;

    const onVolume = () => { clip.volume = main.volume; };
    main.addEventListener('volumechange', onVolume);

    // make the main element's transport state follow the clip while it plays
    const installProxy = () => {
      proxied = true;
      const own = (k, d) => Object.defineProperty(main, k, { configurable: true, ...d });
      own('paused', { get: () => clip.paused });
      own('pause', { value: () => { clip.pause(); main.dispatchEvent(new Event('pause')); } });
      own('play', {
        value: () => {
          const p = clip.play();
          main.dispatchEvent(new Event('play'));
          return p;
        },
      });
      own('muted', {
        get: () => muted,
        set: (v) => { muted = !!v; clip.muted = muted; main.dispatchEvent(new Event('volumechange')); },
      });
      own('currentTime', {
        get: () => mediaProto('currentTime').get.call(main),
        set: (v) => { pendingSeek = v; },             // seeks during the clip apply afterwards
      });
    };

    const cleanup = () => {
      if (done) return false;
      done = true;
      clearInterval(poll);
      main.removeEventListener('playing', onMainPlaying);
      main.removeEventListener('volumechange', onVolume);
      clip.pause();
      clip.remove();
      if (proxied) ['paused', 'pause', 'play', 'muted', 'currentTime'].forEach((k) => delete main[k]);
      main.muted = proxied ? muted : userMuted;
      main.style.visibility = '';
      document.documentElement.classList.remove('logo-intro-active');
      activeIntro = null;
      return true;
    };

    const finish = () => {
      if (!cleanup() || !main.isConnected) return;
      const target = pendingSeek ?? t0;
      try { if (Math.abs(main.currentTime - target) > 0.05) main.currentTime = target; } catch { /* ignore */ }
      realPlay.call(main).catch(() => {});
    };

    const startClip = () => {
      if (done) return;
      realPause.call(main);                            // safe now: Jellyfin has finished its own start-up
      // wait for the native 'pause' event to flush before faking transport state
      const go = () => {
        if (launched || done) return;
        launched = true;
        main.removeEventListener('pause', go);
        main.after(clip);
        main.style.visibility = 'hidden';
        document.documentElement.classList.add('logo-intro-active');
        installProxy();
        clip.muted = muted;
        clip.addEventListener('ended', finish);
        clip.addEventListener('error', finish);
        const flip = () => {
          main.dispatchEvent(new Event('volumechange'));
          main.dispatchEvent(new Event('play'));       // OSD flips to the "playing" state
        };
        clip.play().then(flip).catch(() => {
          clip.muted = true;                           // autoplay-with-sound blocked -> retry muted
          clip.play().then(flip).catch(finish);
        });
      };
      main.addEventListener('pause', go);
      setTimeout(go, 200);
    };

    function onMainPlaying() {
      main.removeEventListener('playing', onMainPlaying);
      t0 = main.currentTime;
      if (!userMuted) main.muted = true;               // no main-video audio while we wait
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