(() => {
  'use strict';
  if (window.__logoIntroLoaded) return;
  window.__logoIntroLoaded = true;

  const CFG = {
    clipUrl: 'logo-intro.mp4',     // resolved relative to /web/ (works with a base URL too)
    videoSelector: 'video.htmlvideoplayer',
    sessionGraceMs: 2500,          // gap allowed between episodes before the session counts as ended
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
  function noteUrl(u) {
    try {
      const s = String(u);
      const m = rx.exec(s);
      if (!m) return;
      const t = new URL(s, location.href).searchParams.get('StartTimeTicks');
      lastInfo = { id: m[1], ticks: t === null ? null : Number(t) || 0, at: Date.now() };
      log('PlaybackInfo', lastInfo);
    } catch { /* ignore */ }
  }
  const _fetch = window.fetch;
  window.fetch = function (input) {
    noteUrl(input instanceof Request ? input.url : input);
    return _fetch.apply(this, arguments);
  };
  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    noteUrl(url);
    return _open.apply(this, arguments);
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

  function isResume() {
    if (!lastInfo || Date.now() - lastInfo.at > CFG.infoMaxAgeMs) return false;
    return lastInfo.ticks !== null && lastInfo.ticks > 0;
  }

  function onMediaLoad(video) {
    clearTimeout(endTimer);
    if (sessionActive) { log('same session -> no intro'); return; }
    sessionActive = true;
    if (isResume()) { log('resume -> no intro'); return; }
    playIntro(video);
  }

  // ---- 3. intro rendered inside the player container ----
  function playIntro(main) {
    log('playing intro');
    if (!main.parentElement) return;

    const clip = document.createElement('video');
    clip.dataset.logoIntro = '1';
    clip.src = new URL(CFG.clipUrl, location.href).href;
    clip.playsInline = true;
    clip.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000;z-index:1;';
    main.after(clip);                                   // same container, above the main video, below the OSD
    document.documentElement.classList.add('logo-intro-active');

    // let the main video start up (so Jellyfin finishes its own init), then freeze it
    const hold = () => { if (!main.paused) main.pause(); };
    main.addEventListener('playing', hold);
    hold();

    let done = false;
    const cleanup = () => {
      if (done) return false;
      done = true;
      main.removeEventListener('playing', hold);
      clip.remove();
      document.documentElement.classList.remove('logo-intro-active');
      activeIntro = null;
      return true;
    };
    const finish = () => { if (cleanup() && main.isConnected) main.play().catch(() => {}); };
    activeIntro = { main, abort: () => { clip.pause(); cleanup(); } };

    clip.addEventListener('ended', finish);
    clip.addEventListener('error', finish);
    clip.play().catch(() => {
      clip.muted = true;                                // autoplay-with-sound blocked -> retry muted
      clip.play().catch(finish);
    });
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