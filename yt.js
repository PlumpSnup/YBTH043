// Loads YouTube's official IFrame Player API and builds embed URLs.
// Only documented features are used:
//   - privacy-enhanced embeds from youtube-nocookie.com
//   - creating the <iframe> ourselves with enablejsapi=1 and attaching YT.Player to it
//   - documented player parameters (controls, rel, start, autoplay, origin, …)
// If the API script can't load (for example an ad blocker blocks it), the app falls
// back to a plain embed with YouTube's own controls instead of using any workaround.
// Docs: https://developers.google.com/youtube/iframe_api_reference
(function (root) {
  'use strict';

  var EMBED_ORIGIN = 'https://www.youtube-nocookie.com';
  var API_SRC = 'https://www.youtube.com/iframe_api';
  var state = 'idle';     // idle | loading | ready | failed
  var waiters = [];

  function finish(ok) {
    if (state !== 'loading') return;
    state = ok ? 'ready' : 'failed';
    waiters.splice(0).forEach(function (fn) { fn(ok); });
  }

  // Calls back with true when YT.Player is available, false if it couldn't load.
  function loadApi(callback, timeoutMs) {
    if (state === 'ready' || state === 'failed') { callback(state === 'ready'); return; }
    waiters.push(callback);
    if (state === 'loading') return;
    state = 'loading';

    var previous = root.onYouTubeIframeAPIReady;
    root.onYouTubeIframeAPIReady = function () {
      if (typeof previous === 'function') previous();
      finish(true);
    };
    var s = document.createElement('script');
    s.src = API_SRC;
    s.async = true;
    s.onerror = function () { finish(false); };
    document.head.appendChild(s);
    setTimeout(function () { finish(false); }, timeoutMs || 8000);
  }

  function embedUrl(videoId, params) {
    var q = new URLSearchParams();
    Object.keys(params || {}).forEach(function (k) {
      if (params[k] !== undefined && params[k] !== null) q.set(k, String(params[k]));
    });
    return EMBED_ORIGIN + '/embed/' + encodeURIComponent(videoId) + '?' + q.toString();
  }

  // Replaces the element with id `targetId` by a YouTube embed iframe (or reuses it).
  function frame(targetId, src) {
    var el = document.getElementById(targetId);
    if (el && el.tagName === 'IFRAME') { el.src = src; return el; }
    var iframe = document.createElement('iframe');
    iframe.id = targetId;
    iframe.title = 'YouTube video player';
    iframe.src = src;
    iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
    iframe.setAttribute('allowfullscreen', '');
    // YouTube requires embeds to identify the site via the Referer header.
    iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    el.parentNode.replaceChild(iframe, el);
    return iframe;
  }

  root.LessonYT = {
    loadApi: loadApi,
    embedUrl: embedUrl,
    frame: frame,
    PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 }
  };
})(window);
