# Lesson Player

Paste a YouTube link and watch it in a clean, Khan Academy–style lesson player with custom controls, without YouTube's control bar, title bar or "Watch on YouTube" button.

Videos play in YouTube's embedded player, in privacy-enhanced mode (`youtube-nocookie.com`), and are controlled with YouTube's official [IFrame Player API](https://developers.google.com/youtube/iframe_api_reference).

### Staying within YouTube's terms

- **Documented APIs only.** Playback is controlled through the official IFrame Player API. If that API script can't load (for example, an ad blocker blocks it), the app shows a plain embed with YouTube's own controls instead of using any workaround.
- **Nothing on top of the player.** YouTube's control bar is turned off with the documented `controls=0` option, and our controls sit in a toolbar below the video. YouTube's logo, links, start and end screens are left untouched.
- **Minimum player size** of 200×200 px.
- **Terms and privacy.** `legal.html` links to the YouTube Terms of Service and the Google Privacy Policy, says that users agree to be bound by YouTube's terms, and explains what data is stored. A notice next to the Play button links to both.
- **Stored data.** "Recently watched" keeps video IDs and titles in the browser only, deletes them after 30 days, and has a Clear history button.
- **YouTube Data API** for search, called from the server so the key stays secret. Channel and video information is shown as YouTube returns it and cached for at most 6 hours.
- **No downloading or re-hosting** of videos.

## Features

- Accepts `youtube.com/watch?v=…`, `youtu.be/…`, Shorts, embed, live and mobile links, plus `t=` start times
- Custom controls: play/pause, ±10s, seek bar with buffer indicator, volume/mute, speed (0.5×–2×), fullscreen
- Keyboard shortcuts: `Space`/`K`, `J`/`L`, `←`/`→`, `M`, `F`
- **YouTuber search:** search for a channel by name or `@handle`, browse its latest videos, and click one to play it here (or copy its link)
- Shareable URLs (`?v=VIDEO_ID`)
- "Recently watched" list, stored in the browser for up to 30 days, with a Clear history button
- Friendly errors for private/removed videos and videos whose owner disabled embedding
- Light and dark mode, works on phones

## Run locally

No build step. Serve the folder over HTTP (the YouTube player won't work from `file://`):

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Deploy

It's a static site plus one Vercel serverless function (`api/youtube.js`). On Vercel, import the repo with framework preset **Other**, no build command, and output directory `.`.

### Environment variable

| Name | Needed for | How to get it |
|---|---|---|
| `YOUTUBE_API_KEY` | YouTuber search | Google Cloud Console → create a project → enable **YouTube Data API v3** → Credentials → Create API key (restrict it to YouTube Data API v3) |

Without the key, everything works except search, which shows a "not set up yet" message.

**Daily quota:** 10,000 free units/day. A name search costs 100 units, a `@handle` lookup or a page of 24 videos costs 1–2. Results are cached on Vercel's CDN for 6 hours, so repeat lookups are free.

## Files

- `index.html`: page markup
- `styles.css`: styles
- `parse.js`: turns a YouTube link into a video ID and start time
- `yt.js`: loads YouTube's official IFrame Player API and builds embed URLs
- `app.js`: player logic and custom controls
- `browse.js`: YouTuber search, channel list and video grid
- `api/youtube.js`: serverless function that calls the YouTube Data API with the secret key
- `legal.html`: Terms of Use and Privacy Policy
