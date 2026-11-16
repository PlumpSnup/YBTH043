// YouTuber search: find a channel, list its videos, and play one in the player.
// Talks only to our own /api/youtube function, which holds the YouTube API key.
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    form: $('search-form'), input: $('search-input'),
    browse: $('browse'), status: $('browse-status'), empty: $('empty'),
    channelResults: $('channel-results'), channelList: $('channel-list'),
    videoResults: $('video-results'), videoList: $('video-list'),
    avatar: $('channel-avatar'), channelName: $('channel-name'), channelLink: $('channel-link'),
    back: $('back-to-channels'), loadMore: $('load-more')
  };

  var requestSeq = 0;
  var openChannel = null;      // { id, nextPage }
  var lastChannels = [];

  function api(params) {
    var seq = ++requestSeq;
    var url = '/api/youtube?' + new URLSearchParams(params).toString();
    return fetch(url, { headers: { accept: 'application/json' } })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (body) {
          if (!r.ok) {
            var err = new Error(body.message || 'Search failed. Please try again.');
            err.code = body.error;
            throw err;
          }
          return body;
        });
      })
      .then(function (body) {
        if (seq !== requestSeq) throw Object.assign(new Error('stale'), { stale: true });
        return body;
      }, function (err) {
        if (seq !== requestSeq) err.stale = true;
        if (!err.code && !err.stale) err.message = 'Couldn’t reach the search service. Check your connection and try again.';
        throw err;
      });
  }

  function show(el, on) { el.hidden = !on; }

  function setStatus(text, isError) {
    els.status.textContent = text || '';
    els.status.classList.toggle('is-error', !!isError);
    show(els.status, !!text);
  }

  function openBrowse() {
    show(els.browse, true);
    show(els.empty, false);
  }

  function formatDate(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function videoUrl(id) { return 'https://www.youtube.com/watch?v=' + id; }

  // ---------- Channels ----------

  function search(q) {
    openBrowse();
    show(els.videoResults, false);
    show(els.channelResults, false);
    setStatus('Searching…');
    api({ q: q }).then(function (data) {
      lastChannels = data.channels || [];
      if (!lastChannels.length) {
        setStatus('No channels found for “' + q + '”. Try a different spelling, or their @handle.');
        return;
      }
      setStatus('');
      if (lastChannels.length === 1) { loadChannel(lastChannels[0], true); return; }
      renderChannels();
    }).catch(function (err) {
      if (!err.stale) setStatus(err.message, true);
    });
  }

  function renderChannels() {
    els.channelList.textContent = '';
    lastChannels.forEach(function (c) {
      var li = document.createElement('li');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'channel-card';

      var img = document.createElement('img');
      img.src = c.thumbnail || '';
      img.alt = '';
      img.loading = 'lazy';

      var text = document.createElement('span');
      text.className = 'channel-text';
      var name = document.createElement('span');
      name.className = 'channel-title';
      name.textContent = c.title;
      var handle = document.createElement('span');
      handle.className = 'channel-handle';
      handle.textContent = c.handle || '';
      var desc = document.createElement('span');
      desc.className = 'channel-desc';
      desc.textContent = c.description || '';
      text.appendChild(name);
      text.appendChild(handle);
      text.appendChild(desc);

      btn.appendChild(img);
      btn.appendChild(text);
      btn.addEventListener('click', function () { loadChannel(c, false); });
      li.appendChild(btn);
      els.channelList.appendChild(li);
    });
    show(els.videoResults, false);
    show(els.channelResults, true);
  }

  // ---------- Videos ----------

  function loadChannel(c, onlyResult) {
    openChannel = { id: c.id, nextPage: null };
    els.videoList.textContent = '';
    els.channelName.textContent = c.title;
    els.avatar.src = c.thumbnail || '';
    els.channelLink.href = 'https://www.youtube.com/channel/' + encodeURIComponent(c.id);
    show(els.back, !onlyResult && lastChannels.length > 1);
    show(els.channelResults, false);
    show(els.videoResults, true);
    show(els.loadMore, false);
    setStatus('Loading videos…');
    fetchVideos();
  }

  function fetchVideos() {
    if (!openChannel) return;
    var params = { channel: openChannel.id };
    if (openChannel.nextPage) params.page = openChannel.nextPage;
    els.loadMore.disabled = true;
    api(params).then(function (data) {
      if (data.channel && data.channel.title) els.channelName.textContent = data.channel.title;
      appendVideos(data.videos || []);
      openChannel.nextPage = data.nextPage || null;
      show(els.loadMore, !!openChannel.nextPage);
      els.loadMore.disabled = false;
      setStatus(els.videoList.children.length ? '' : 'This channel has no public videos.');
    }).catch(function (err) {
      els.loadMore.disabled = false;
      if (!err.stale) setStatus(err.message, true);
    });
  }

  function appendVideos(videos) {
    var playingId = window.LessonPlayer && window.LessonPlayer.currentId();
    videos.forEach(function (v) {
      var li = document.createElement('li');
      li.className = 'video-card';
      li.dataset.id = v.id;
      if (v.id === playingId) li.classList.add('is-current');

      var play = document.createElement('button');
      play.type = 'button';
      play.className = 'video-play';
      play.setAttribute('aria-label', 'Play ' + v.title);

      var img = document.createElement('img');
      img.src = v.thumbnail || ('https://i.ytimg.com/vi/' + v.id + '/mqdefault.jpg');
      img.alt = '';
      img.loading = 'lazy';

      var title = document.createElement('span');
      title.className = 'video-title-text';
      title.textContent = v.title;

      var date = document.createElement('span');
      date.className = 'video-date';
      date.textContent = formatDate(v.published);

      play.appendChild(img);
      play.appendChild(title);
      play.appendChild(date);
      play.addEventListener('click', function () {
        if (window.LessonPlayer) {
          window.LessonPlayer.play(v.id, { title: v.title, author: els.channelName.textContent });
        }
        markCurrent(v.id);
      });

      var linkRow = document.createElement('div');
      linkRow.className = 'video-link-row';
      var link = document.createElement('a');
      link.href = videoUrl(v.id);
      link.target = '_blank';
      link.rel = 'noopener';
      link.className = 'video-link';
      link.textContent = 'youtu.be/' + v.id;
      var copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'link-btn';
      copy.textContent = 'Copy link';
      copy.addEventListener('click', function () { copyLink(v.id, copy); });
      linkRow.appendChild(link);
      linkRow.appendChild(copy);

      li.appendChild(play);
      li.appendChild(linkRow);
      els.videoList.appendChild(li);
    });
  }

  function markCurrent(id) {
    Array.prototype.forEach.call(els.videoList.children, function (li) {
      li.classList.toggle('is-current', li.dataset.id === id);
    });
  }

  function copyLink(id, btn) {
    var url = videoUrl(id);
    var done = function () {
      btn.textContent = 'Copied!';
      setTimeout(function () { btn.textContent = 'Copy link'; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, function () { window.prompt('Copy this link:', url); });
    } else {
      window.prompt('Copy this link:', url);
    }
  }

  // ---------- Events ----------

  els.form.addEventListener('submit', function (e) {
    e.preventDefault();
    var q = els.input.value.trim();
    if (!q) { els.input.focus(); return; }
    els.input.blur();
    search(q);
  });

  els.back.addEventListener('click', function () {
    openChannel = null;
    requestSeq++;
    setStatus('');
    renderChannels();
  });

  els.loadMore.addEventListener('click', fetchVideos);
})();
