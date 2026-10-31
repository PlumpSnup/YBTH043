// Extracts an 11-character YouTube video ID from a link (or a bare ID).
// Returns { id, start } or null. `start` is seconds from a t= / start= param.
(function (root) {
  var ID_RE = /^[A-Za-z0-9_-]{11}$/;

  function parseTime(value) {
    if (!value) return 0;
    if (/^\d+$/.test(value)) return parseInt(value, 10);
    var m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(value);
    if (!m) return 0;
    return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
  }

  function parseYouTube(input) {
    if (!input) return null;
    var text = String(input).trim();
    if (ID_RE.test(text)) return { id: text, start: 0 };

    if (!/^[a-z]+:\/\//i.test(text)) text = 'https://' + text;
    var url;
    try { url = new URL(text); } catch (e) { return null; }

    var host = url.hostname.toLowerCase().replace(/^(www\.|m\.|music\.)/, '');
    var parts = url.pathname.split('/').filter(Boolean);
    var id = null;

    if (host === 'youtu.be') {
      id = parts[0];
    } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (parts[0] === 'watch') {
        id = url.searchParams.get('v');
      } else if (['embed', 'shorts', 'live', 'v', 'e'].indexOf(parts[0]) !== -1) {
        id = parts[1];
      } else if (!parts.length || parts[0] === 'attribution_link') {
        id = url.searchParams.get('v');
        var u = url.searchParams.get('u');
        if (!id && u) {
          try { id = new URL(u, 'https://youtube.com').searchParams.get('v'); } catch (e) {}
        }
      }
    } else {
      return null;
    }

    if (!id || !ID_RE.test(id)) return null;
    var start = parseTime(url.searchParams.get('t') || url.searchParams.get('start'));
    return { id: id, start: start };
  }

  root.parseYouTube = parseYouTube;
  if (typeof module !== 'undefined') module.exports = { parseYouTube: parseYouTube };
})(typeof window !== 'undefined' ? window : globalThis);
