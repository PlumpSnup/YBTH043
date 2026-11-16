// Vercel serverless function: looks up YouTube channels and their uploads with the
// official YouTube Data API v3. The API key stays on the server (YOUTUBE_API_KEY).
//
//   GET /api/youtube?q=Mark%20Rober        -> matching channels (search.list, 100 units)
//   GET /api/youtube?q=@MarkRober          -> that exact handle (channels.list, 1 unit)
//   GET /api/youtube?channel=UC...         -> channel info + latest uploads (2 units)
//   GET /api/youtube?channel=UC...&page=X  -> next page of uploads (2 units)
//
// Responses are cached by Vercel's CDN for a few hours so repeat lookups cost nothing.
// Docs: https://developers.google.com/youtube/v3/docs

'use strict';

const API = 'https://www.googleapis.com/youtube/v3/';
const CACHE_SECONDS = 6 * 60 * 60;            // well inside YouTube's 30-day storage limit
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const PAGE_TOKEN_RE = /^[A-Za-z0-9_-]{1,100}$/;
const HANDLE_RE = /^@[A-Za-z0-9._-]{3,30}$/;
const PAGE_SIZE = 24;

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function yt(path, params, key) {
  const url = new URL(path, API);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  url.searchParams.set('key', key);
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = body && body.error && body.error.errors && body.error.errors[0] &&
      body.error.errors[0].reason;
    if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
      throw new ApiError(429, 'quota', 'The daily YouTube search limit has been reached. Try again tomorrow.');
    }
    if (res.status === 400 || res.status === 403) {
      throw new ApiError(502, 'youtube_rejected', 'YouTube rejected the request. Check that the API key is valid and allowed to use the YouTube Data API v3.');
    }
    throw new ApiError(502, 'youtube_error', 'YouTube didn’t respond properly. Please try again.');
  }
  return body;
}

function bestThumb(thumbnails) {
  const t = thumbnails || {};
  const pick = t.medium || t.high || t.default || t.standard || t.maxres;
  return pick ? pick.url : '';
}

function channelSummary(item) {
  const s = item.snippet || {};
  return {
    id: typeof item.id === 'string' ? item.id : (item.id && item.id.channelId) || s.channelId,
    title: s.title || s.channelTitle || '',
    handle: s.customUrl || '',
    description: s.description || '',
    thumbnail: bestThumb(s.thumbnails)
  };
}

async function searchChannels(q, key) {
  if (HANDLE_RE.test(q)) {
    const data = await yt('channels', { part: 'snippet', forHandle: q }, key);
    return { channels: (data.items || []).map(channelSummary) };
  }
  const data = await yt('search', {
    part: 'snippet', type: 'channel', q, maxResults: 8, safeSearch: 'moderate'
  }, key);
  return { channels: (data.items || []).map(channelSummary).filter((c) => c.id) };
}

async function channelVideos(channelId, page, key) {
  const ch = await yt('channels', { part: 'snippet,contentDetails', id: channelId }, key);
  const item = ch.items && ch.items[0];
  if (!item) throw new ApiError(404, 'not_found', 'That channel wasn’t found.');
  const uploads = item.contentDetails && item.contentDetails.relatedPlaylists &&
    item.contentDetails.relatedPlaylists.uploads;
  if (!uploads) return { channel: channelSummary(item), videos: [], nextPage: null };

  const list = await yt('playlistItems', {
    part: 'snippet,contentDetails,status', playlistId: uploads, maxResults: PAGE_SIZE, pageToken: page
  }, key);

  const videos = (list.items || [])
    .filter((v) => v.status && v.status.privacyStatus === 'public')
    .map((v) => ({
      id: (v.contentDetails && v.contentDetails.videoId) ||
        (v.snippet && v.snippet.resourceId && v.snippet.resourceId.videoId),
      title: (v.snippet && v.snippet.title) || '',
      published: (v.contentDetails && v.contentDetails.videoPublishedAt) ||
        (v.snippet && v.snippet.publishedAt) || '',
      thumbnail: bestThumb(v.snippet && v.snippet.thumbnails)
    }))
    .filter((v) => v.id);

  return { channel: channelSummary(item), videos, nextPage: list.nextPageToken || null };
}

function send(res, status, body, cacheable) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cacheable
    ? `public, max-age=300, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=600`
    : 'no-store');
  res.end(JSON.stringify(body));
}

async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });

  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    return send(res, 503, {
      error: 'not_configured',
      message: 'YouTuber search isn’t set up yet: the site owner needs to add a YouTube API key.'
    });
  }

  const params = new URL(req.url, 'http://localhost').searchParams;
  const q = (params.get('q') || '').trim();
  const channel = (params.get('channel') || '').trim();
  const page = (params.get('page') || '').trim();

  try {
    if (channel) {
      if (!CHANNEL_ID_RE.test(channel)) return send(res, 400, { error: 'bad_channel', message: 'Invalid channel.' });
      if (page && !PAGE_TOKEN_RE.test(page)) return send(res, 400, { error: 'bad_page', message: 'Invalid page.' });
      return send(res, 200, await channelVideos(channel, page, key), true);
    }
    if (q) {
      if (q.length > 100) return send(res, 400, { error: 'bad_query', message: 'That search is too long.' });
      return send(res, 200, await searchChannels(q, key), true);
    }
    return send(res, 400, { error: 'missing_query', message: 'Type a YouTuber’s name to search.' });
  } catch (err) {
    if (err instanceof ApiError) return send(res, err.status, { error: err.code, message: err.message });
    return send(res, 500, { error: 'server_error', message: 'Something went wrong. Please try again.' });
  }
}

module.exports = handler;
module.exports._test = { searchChannels, channelVideos, HANDLE_RE, CHANNEL_ID_RE };
