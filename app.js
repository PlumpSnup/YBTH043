(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var els = {
    form: $('link-form'), input: $('link-input'), formError: $('form-error'),
    stage: $('stage'), empty: $('empty'), shell: $('player-shell'),
    clickLayer: $('click-layer'), poster: $('poster'), posterImg: $('poster-img'),
    bigPlay: $('big-play'), spinner: $('spinner'),
    playerError: $('player-error'), playerErrorText: $('player-error-text'),
    controls: $('controls'), seek: $('seek'), seekProgress: $('seek-progress'),
    seekBuffer: $('seek-buffer'), btnPlay: $('btn-play'), btnBack: $('btn-back'),
    btnFwd: $('btn-fwd'), btnMute: $('btn-mute'), volume: $('volume'),
    time: $('time'), speed: $('speed'), btnFull: $('btn-full'),
    title: $('video-title'), author: $('video-author'),
    recentWrap: $('recent-wrap'), recent: $('recent')
  };

  var RECENT_KEY = 'lesson-player:recent';
  var RECENT_MAX = 8;

  var player = null;
  var apiReady = false;
  var pendingLoad = null;
  var current = null;          // { id, start }
  var started = false;         // has the current video been played at least once
  var seeking = false;
  var hideTimer = null;
  var tickTimer = null;
  var playerReady = false;
  var autoplay = false;        // start playing as soon as the player is ready
  var watchdog = null;         // detects a player that never finishes loading
  var createdWithId = null;    // video the player was first created with

  // ---------- YouTube IFrame API ----------

  function loadApi() {
    var s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    s.onerror = function () {
      showPlayerError('Could not load the video player. Check your connection and try again.');
    };
    document.head.appendChild(s);
  }

  window.onYouTubeIframeAPIReady = function () {
    apiReady = true;
    if (pendingLoad) {
      var p = pendingLoad;
      pendingLoad = null;
      loadVideo(p);
    }
  };

  function createPlayer(video) {
    createdWithId = video.id;
    player = new YT.Player('yt-target', {
      videoId: video.id,
      playerVars: {
        controls: 0,          // hide YouTube's control bar — we draw our own
        disablekb: 1,         // we handle the keyboard
        fs: 0,                // hide YouTube's fullscreen button
        rel: 0,               // related videos only from the same channel
        iv_load_policy: 3,    // hide annotations
        playsinline: 1,
        cc_load_policy: 0,
        start: video.start || 0,
        origin: location.origin
      },
      events: {
        onReady: onPlayerReady,
        onStateChange: onStateChange,
        onError: onPlayerError
      }
    });
  }

  function onPlayerReady() {
    playerReady = true;
    clearTimeout(watchdog);
    applyVolume();
    player.setPlaybackRate(parseFloat(els.speed.value));
    startTick();
    // Another link may have been pasted while the player was starting up
    if (current && current.id !== createdWithId) {
      autoplay = false;
      player.loadVideoById({ videoId: current.id, startSeconds: current.start || 0 });
      return;
    }
    refreshMeta();
    if (els.title.textContent === 'Loading…') els.title.textContent = 'YouTube video';
    if (autoplay) { autoplay = false; player.playVideo(); }
  }

  function onStateChange(e) {
    var S = YT.PlayerState;
    switch (e.data) {
      case S.PLAYING:
        started = true;
        els.poster.hidden = true;
        els.spinner.hidden = true;
        els.shell.classList.add('is-playing');
        els.shell.classList.remove('is-ended');
        refreshMeta();
        scheduleHide();
        break;
      case S.PAUSED:
        els.shell.classList.remove('is-playing');
        showControls();
        break;
      case S.BUFFERING:
        if (started) els.spinner.hidden = false;
        break;
      case S.ENDED:
        els.shell.classList.remove('is-playing');
        els.shell.classList.add('is-ended');
        // Cover YouTube's end screen with our own replay poster
        els.poster.hidden = false;
        els.spinner.hidden = true;
        showControls();
        break;
      case S.CUED:
        els.spinner.hidden = true;
        refreshMeta();
        break;
    }
    updateTime();
  }

  function onPlayerError(e) {
    var msg;
    switch (e.data) {
      case 2: msg = 'That link doesn’t look like a valid video.'; break;
      case 5: msg = 'This video can’t be played in your browser.'; break;
      case 100: msg = 'This video was removed or is private.'; break;
      case 101:
      case 150:
      case 153:
        msg = 'The owner of this video doesn’t allow it to be played in other apps.'; break;
      default: msg = 'Something went wrong playing this video.';
    }
    showPlayerError(msg);
  }

  // ---------- Loading a video ----------

  function loadVideo(video) {
    current = video;
    started = false;
    hidePlayerError();
    els.stage.hidden = false;
    els.empty.hidden = true;
    els.shell.classList.remove('is-playing', 'is-ended');
    els.poster.hidden = false;
    els.posterImg.src = 'https://i.ytimg.com/vi/' + video.id + '/hqdefault.jpg';
    els.title.textContent = 'Loading…';
    els.author.textContent = '';
    els.seekProgress.style.width = '0%';
    els.seekBuffer.style.width = '0%';
    els.seek.value = 0;
    els.time.textContent = '0:00 / 0:00';
    updateUrl(video);
    fetchTitle(video.id);

    if (!playerReady) {
      autoplay = true;
      clearTimeout(watchdog);
      watchdog = setTimeout(function () {
        if (!playerReady) {
          showPlayerError('The YouTube player didn’t load. If you use an ad blocker or privacy ' +
            'extension, allow youtube.com on this site and reload the page.');
        }
      }, 15000);
    }

    if (!apiReady) { pendingLoad = video; return; }

    if (!player) {
      createPlayer(video);
    } else if (playerReady) {
      // Pasting a link is a click, so start playing right away
      player.loadVideoById({ videoId: video.id, startSeconds: video.start || 0 });
    }
  }

  // Title lookup before playback starts (no API key needed). YouTube's own oEmbed
  // endpoint doesn't allow browser requests from other sites, so use noembed.com,
  // which proxies it with CORS enabled.
  function fetchTitle(id) {
    if (!window.fetch) return;
    var u = 'https://noembed.com/embed?url=' +
      encodeURIComponent('https://www.youtube.com/watch?v=' + id);
    fetch(u).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d || !d.title || !current || current.id !== id || !els.playerError.hidden) return;
      var t = els.title.textContent;
      if (t === 'Loading…' || t === 'YouTube video') {
        els.title.textContent = d.title;
        els.author.textContent = d.author_name || '';
        document.title = d.title + ' · Lesson Player';
      }
    }).catch(function () {});
  }

  function refreshMeta() {
    if (!player || !player.getVideoData) return;
    var data = player.getVideoData() || {};
    if (data.video_id && data.video_id !== current.id) return; // stale data from previous video
    if (data.title) {
      els.title.textContent = data.title;
      document.title = data.title + ' · Lesson Player';
      els.author.textContent = data.author || '';
      saveRecent({ id: current.id, title: data.title, author: data.author || '' });
    }
  }

  // ---------- Controls ----------

  function isReady() { return player && typeof player.getPlayerState === 'function'; }

  function togglePlay() {
    if (!isReady()) return;
    var state = player.getPlayerState();
    if (state === YT.PlayerState.PLAYING || (state === YT.PlayerState.BUFFERING && started)) {
      player.pauseVideo();
    } else {
      if (state === YT.PlayerState.ENDED) player.seekTo(0, true);
      if (!started) els.spinner.hidden = false;
      player.playVideo();
    }
  }

  function seekBy(delta) {
    if (!isReady()) return;
    var dur = player.getDuration() || 0;
    var t = Math.max(0, Math.min(dur, player.getCurrentTime() + delta));
    player.seekTo(t, true);
    updateTime();
    showControls();
  }

  function applyVolume() {
    if (!isReady()) return;
    var v = parseInt(els.volume.value, 10);
    player.setVolume(v);
    if (v === 0) player.mute(); else player.unMute();
    els.shell.classList.toggle('is-muted', v === 0 || player.isMuted());
  }

  function toggleMute() {
    if (!isReady()) return;
    if (player.isMuted() || parseInt(els.volume.value, 10) === 0) {
      if (parseInt(els.volume.value, 10) === 0) els.volume.value = 50;
      player.unMute();
      player.setVolume(parseInt(els.volume.value, 10));
      els.shell.classList.remove('is-muted');
    } else {
      player.mute();
      els.shell.classList.add('is-muted');
    }
    showControls();
  }

  function toggleFullscreen() {
    var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else {
      var req = els.shell.requestFullscreen || els.shell.webkitRequestFullscreen;
      if (req) req.call(els.shell);
    }
  }

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    var ss = s < 10 ? '0' + s : '' + s;
    if (h) return h + ':' + (m < 10 ? '0' + m : m) + ':' + ss;
    return m + ':' + ss;
  }

  function updateTime() {
    if (!isReady()) return;
    var dur = player.getDuration() || 0;
    var cur = player.getCurrentTime() || 0;
    var loaded = player.getVideoLoadedFraction ? player.getVideoLoadedFraction() : 0;
    els.time.textContent = fmt(cur) + ' / ' + fmt(dur);
    els.seekBuffer.style.width = (loaded * 100) + '%';
    if (!seeking && dur > 0) {
      var frac = cur / dur;
      els.seek.value = Math.round(frac * 1000);
      els.seekProgress.style.width = (frac * 100) + '%';
    }
  }

  function startTick() {
    clearInterval(tickTimer);
    tickTimer = setInterval(updateTime, 250);
  }

  // Auto-hide controls while playing
  function showControls() {
    els.shell.classList.add('controls-visible');
    scheduleHide();
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
      if (els.shell.classList.contains('is-playing') && !seeking) {
        els.shell.classList.remove('controls-visible');
      }
    }, 2500);
  }

  function showPlayerError(msg) {
    els.playerErrorText.textContent = msg;
    els.playerError.hidden = false;
    els.poster.hidden = true;
    els.spinner.hidden = true;
    els.title.textContent = 'Video unavailable';
  }

  function hidePlayerError() { els.playerError.hidden = true; }

  // ---------- URL + recent list ----------

  function updateUrl(video) {
    var url = new URL(location.href);
    url.searchParams.set('v', video.id);
    if (video.start) url.searchParams.set('t', String(video.start));
    else url.searchParams.delete('t');
    history.replaceState(null, '', url);
  }

  function readRecent() {
    try {
      var list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }

  function saveRecent(item) {
    var list = readRecent().filter(function (x) { return x && x.id !== item.id; });
    list.unshift(item);
    list = list.slice(0, RECENT_MAX);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch (e) {}
    renderRecent();
  }

  function renderRecent() {
    var list = readRecent();
    els.recent.textContent = '';
    els.recentWrap.hidden = list.length === 0;
    list.forEach(function (item) {
      var li = document.createElement('li');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'recent-item';
      if (current && current.id === item.id) btn.classList.add('is-current');

      var img = document.createElement('img');
      img.src = 'https://i.ytimg.com/vi/' + item.id + '/mqdefault.jpg';
      img.alt = '';
      img.loading = 'lazy';

      var text = document.createElement('span');
      text.className = 'recent-text';
      var t = document.createElement('span');
      t.className = 'recent-title';
      t.textContent = item.title || item.id;
      var a = document.createElement('span');
      a.className = 'recent-author';
      a.textContent = item.author || '';
      text.appendChild(t);
      text.appendChild(a);

      btn.appendChild(img);
      btn.appendChild(text);
      btn.addEventListener('click', function () {
        loadVideo({ id: item.id, start: 0 });
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
      li.appendChild(btn);
      els.recent.appendChild(li);
    });
  }

  // ---------- Events ----------

  els.form.addEventListener('submit', function (e) {
    e.preventDefault();
    var video = window.parseYouTube(els.input.value);
    if (!video) {
      els.formError.textContent = 'That doesn’t look like a YouTube link. Try something like https://youtu.be/VIDEO_ID';
      els.formError.hidden = false;
      return;
    }
    els.formError.hidden = true;
    els.input.value = '';
    els.input.blur();
    loadVideo(video);
  });

  els.input.addEventListener('input', function () { els.formError.hidden = true; });

  els.bigPlay.addEventListener('click', function (e) { e.stopPropagation(); togglePlay(); });
  els.poster.addEventListener('click', togglePlay);
  els.clickLayer.addEventListener('click', togglePlay);
  els.clickLayer.addEventListener('dblclick', toggleFullscreen);
  els.btnPlay.addEventListener('click', togglePlay);
  els.btnBack.addEventListener('click', function () { seekBy(-10); });
  els.btnFwd.addEventListener('click', function () { seekBy(10); });
  els.btnMute.addEventListener('click', toggleMute);
  els.btnFull.addEventListener('click', toggleFullscreen);
  els.volume.addEventListener('input', applyVolume);
  els.speed.addEventListener('change', function () {
    if (isReady()) player.setPlaybackRate(parseFloat(els.speed.value));
  });

  els.seek.addEventListener('input', function () {
    seeking = true;
    var frac = els.seek.value / 1000;
    els.seekProgress.style.width = (frac * 100) + '%';
    if (isReady()) {
      var dur = player.getDuration() || 0;
      els.time.textContent = fmt(frac * dur) + ' / ' + fmt(dur);
    }
  });
  els.seek.addEventListener('change', function () {
    if (isReady()) {
      var dur = player.getDuration() || 0;
      player.seekTo((els.seek.value / 1000) * dur, true);
    }
    seeking = false;
    showControls();
  });

  els.shell.addEventListener('mousemove', showControls);
  els.shell.addEventListener('touchstart', showControls, { passive: true });
  els.shell.addEventListener('mouseleave', function () {
    if (els.shell.classList.contains('is-playing')) els.shell.classList.remove('controls-visible');
  });

  document.addEventListener('keydown', function (e) {
    if (els.stage.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' && e.target.type !== 'range' || tag === 'textarea' || tag === 'select') return;
    switch (e.key) {
      case ' ':
      case 'k': case 'K':
        if (tag === 'button' && e.key === ' ') return; // let buttons handle Space
        e.preventDefault(); togglePlay(); showControls(); break;
      case 'j': case 'J': seekBy(-10); break;
      case 'l': case 'L': seekBy(10); break;
      case 'ArrowLeft': if (tag !== 'input') { e.preventDefault(); seekBy(-5); } break;
      case 'ArrowRight': if (tag !== 'input') { e.preventDefault(); seekBy(5); } break;
      case 'm': case 'M': toggleMute(); break;
      case 'f': case 'F': toggleFullscreen(); break;
    }
  });

  function onFsChange() {
    els.shell.classList.toggle('is-fullscreen',
      !!(document.fullscreenElement || document.webkitFullscreenElement));
  }
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);

  // ---------- Boot ----------

  renderRecent();
  loadApi();

  var params = new URLSearchParams(location.search);
  if (params.get('v')) {
    var initial = window.parseYouTube('https://youtube.com/watch?' + params.toString());
    if (initial) loadVideo(initial);
  }
})();
