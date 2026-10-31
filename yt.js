// Minimal YouTube embed controller that talks to a plain youtube.com/embed iframe
// over postMessage. It does the same job as YouTube's iframe_api script, but
// without loading that script, which ad blockers often block even though they
// allow plain embeds. It exposes the subset of the YT.Player interface app.js uses.
(function (root) {
  'use strict';

  // YouTube's official privacy-enhanced embed domain (no cookies until playback).
  var ORIGIN = 'https://www.youtube-nocookie.com';
  var ORIGIN_RE = /^https:\/\/www\.youtube(-nocookie)?\.com$/;
  var STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
  var nextId = 1;

  function buildSrc(videoId, vars) {
    var params = new URLSearchParams();
    Object.keys(vars || {}).forEach(function (k) {
      if (vars[k] !== undefined && vars[k] !== null) params.set(k, String(vars[k]));
    });
    params.set('enablejsapi', '1');
    return ORIGIN + '/embed/' + encodeURIComponent(videoId) + '?' + params.toString();
  }

  function Player(targetId, opts) {
    var self = this;
    var events = opts.events || {};
    var id = nextId++;
    var info = {
      playerState: STATE.UNSTARTED, currentTime: 0, duration: 0, videoLoadedFraction: 0,
      volume: 100, muted: false, playbackRate: 1, videoData: {}
    };
    var lastState = null;
    var ready = false;
    var heard = false;
    var listenTimer = null;
    var lastInfoAt = 0;

    var iframe = document.createElement('iframe');
    iframe.id = targetId;
    iframe.title = 'Video';
    iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
    iframe.setAttribute('allowfullscreen', '');
    iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    iframe.src = buildSrc(opts.videoId, opts.playerVars);
    var placeholder = document.getElementById(targetId);
    placeholder.parentNode.replaceChild(iframe, placeholder);

    function post(obj) {
      if (!iframe.contentWindow) return;
      obj.id = id;
      obj.channel = 'widget';
      iframe.contentWindow.postMessage(JSON.stringify(obj), ORIGIN);
    }
    function command(func, args) { post({ event: 'command', func: func, args: args || [] }); }

    // Keep announcing ourselves until the embedded player answers.
    function startListening() {
      heard = false;
      clearInterval(listenTimer);
      post({ event: 'listening' });
      listenTimer = setInterval(function () {
        if (heard) { clearInterval(listenTimer); return; }
        post({ event: 'listening' });
      }, 250);
    }
    iframe.addEventListener('load', startListening);

    function setState(s) {
      if (typeof s !== 'number' || s === lastState) return;
      lastState = s;
      info.playerState = s;
      if (events.onStateChange) events.onStateChange({ data: s, target: self });
    }

    window.addEventListener('message', function (e) {
      if (e.source !== iframe.contentWindow || !ORIGIN_RE.test(e.origin)) return;
      var msg = e.data;
      if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch (err) { return; } }
      if (!msg || typeof msg !== 'object') return;

      if (!heard) {
        heard = true;
        clearInterval(listenTimer);
        ['onReady', 'onStateChange', 'onError'].forEach(function (name) {
          command('addEventListener', [name]);
        });
      }

      switch (msg.event) {
        case 'initialDelivery':
        case 'infoDelivery':
          if (msg.info && typeof msg.info === 'object') {
            for (var k in msg.info) {
              if (Object.prototype.hasOwnProperty.call(msg.info, k)) info[k] = msg.info[k];
            }
            if ('currentTime' in msg.info) lastInfoAt = Date.now();
            if (ready && 'playerState' in msg.info) setState(msg.info.playerState);
          }
          break;
        case 'onReady':
          if (!ready) {
            ready = true;
            if (events.onReady) events.onReady({ target: self });
          }
          break;
        case 'onStateChange':
          setState(msg.info && typeof msg.info === 'object' ? msg.info.playerState : msg.info);
          break;
        case 'onError':
          if (events.onError) events.onError({ data: msg.info, target: self });
          break;
      }
    });

    function resetFor(o) {
      lastState = null;
      info.currentTime = (o && o.startSeconds) || 0;
      info.duration = 0;
      info.videoLoadedFraction = 0;
      info.videoData = {};
      lastInfoAt = 0;
    }

    this.iframe = iframe;
    this.hasResponded = function () { return heard; };

    this.getPlayerState = function () { return info.playerState; };
    this.getDuration = function () { return info.duration || 0; };
    this.getVideoLoadedFraction = function () { return info.videoLoadedFraction || 0; };
    this.getVideoData = function () { return info.videoData || {}; };
    this.isMuted = function () { return !!info.muted; };
    // Estimate time between updates so the progress bar moves smoothly.
    this.getCurrentTime = function () {
      var t = info.currentTime || 0;
      if (info.playerState === STATE.PLAYING && lastInfoAt) {
        t += ((Date.now() - lastInfoAt) / 1000) * (info.playbackRate || 1);
      }
      return info.duration ? Math.min(t, info.duration) : t;
    };

    this.playVideo = function () { command('playVideo'); };
    this.pauseVideo = function () { command('pauseVideo'); };
    this.seekTo = function (s, allowAhead) {
      info.currentTime = s;
      lastInfoAt = Date.now();
      command('seekTo', [s, allowAhead !== false]);
    };
    this.setVolume = function (v) { info.volume = v; command('setVolume', [v]); };
    this.mute = function () { info.muted = true; command('mute'); };
    this.unMute = function () { info.muted = false; command('unMute'); };
    this.setPlaybackRate = function (r) { info.playbackRate = r; command('setPlaybackRate', [r]); };
    this.loadVideoById = function (o) { resetFor(o); command('loadVideoById', [o]); };
    this.cueVideoById = function (o) { resetFor(o); command('cueVideoById', [o]); };

    // Last resort: show YouTube's own controls so the video still plays.
    this.useNativeControls = function (videoId, vars) {
      var v = {};
      Object.keys(vars || {}).forEach(function (k) { v[k] = vars[k]; });
      v.controls = 1;
      v.fs = 1;
      v.disablekb = 0;
      iframe.src = buildSrc(videoId, v);
    };
  }

  root.LessonYT = { PlayerState: STATE, Player: Player };
})(window);
