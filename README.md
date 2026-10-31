# Lesson Player

Paste a YouTube link and watch it in a clean, Khan Academy–style lesson player with custom controls, without YouTube's control bar, title bar or "Watch on YouTube" button.

The video streams from YouTube as a normal embed, using YouTube's privacy-enhanced `youtube-nocookie.com` mode. `yt.js` controls it directly over `postMessage`, so it doesn't need YouTube's `iframe_api` script, which ad blockers often block.

To stay within YouTube's terms, nothing is drawn on top of the embedded player. YouTube's own control bar is turned off with the documented `controls=0` option, and our controls sit in a toolbar *below* the video. YouTube's logo, start and end screens are left as they are.

## Features

- Accepts `youtube.com/watch?v=…`, `youtu.be/…`, Shorts, embed, live and mobile links, plus `t=` start times
- Custom controls: play/pause, ±10s, seek bar with buffer indicator, volume/mute, speed (0.5×–2×), fullscreen
- Keyboard shortcuts: `Space`/`K`, `J`/`L`, `←`/`→`, `M`, `F`
- Shareable URLs (`?v=VIDEO_ID`)
- "Recently watched" list, stored in the browser
- Friendly errors for private/removed videos and videos whose owner disabled embedding
- Light and dark mode, works on phones

## Run locally

No build step and no API keys. Serve the folder over HTTP (the YouTube player won't work from `file://`):

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Deploy

It's a static site. On Vercel, import the repo with framework preset **Other**, no build command, and output directory `.`. No environment variables are needed.

## Files

- `index.html`: page markup
- `styles.css`: styles
- `parse.js`: turns a YouTube link into a video ID and start time
- `yt.js`: talks to the embedded YouTube video (play, pause, seek, volume…)
- `app.js`: player logic and custom controls
