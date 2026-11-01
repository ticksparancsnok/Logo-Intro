# Jellyfin Logo Intro

A client-side script for the Jellyfin web UI (tested target: Jellyfin 12.x) that plays a short logo animation clip inside the player before a streaming session, similar to Netflix.

## Behavior

| Situation | Clip plays? |
|---|---|
| Start a new movie or episode | Yes, once |
| Resume a partially watched item | No |
| Next episode while staying in the player (autoplay or "next" button) | No |
| Leave the player, then start something new | Yes |

The clip is rendered inside the player, so the player controls stay available while it plays. Closing the player during the clip stops it.

Web client only. Native apps (Android TV, Swiftfin, etc.) are not affected.

## Requirements

- Jellyfin 12.x server with the web client
- A plugin that injects custom JavaScript into the web client (for example a "JavaScript Injector" plugin)
- Your logo clip as an MP4 (H.264 video, AAC audio) so every browser can play it

## Installation

### 1. Place the video

Name your clip `logo-intro.mp4` and put it in the web client root folder, next to `index.html`:

| Install type | Folder |
|---|---|
| Debian / Ubuntu package | `/usr/share/jellyfin/web/` |
| Docker | `/jellyfin/jellyfin-web/` (mount as a volume) |
| Windows | `C:\Program Files\Jellyfin\Server\jellyfin-web\` |

Check it by opening `https://YOUR-SERVER/web/logo-intro.mp4` in a browser. The clip should play.

**Docker note:** without a volume mount, the file is lost when the container is recreated or updated. Mount it, for example:

```yaml
volumes:
  - ./logo-intro.mp4:/jellyfin/jellyfin-web/logo-intro.mp4:ro
```

**Updates note:** package upgrades on bare-metal installs can replace the web folder. Re-copy the file if the clip stops playing after an update.

### 2. Install the JS injector

1. In Jellyfin, open **Dashboard > Plugins > Catalog**.
2. Install a JavaScript injector plugin.
3. Restart Jellyfin.

### 3. Add the script

1. Open **Dashboard > Plugins > (your JS injector plugin)**.
2. Create a new script entry and paste the full contents of `logo-intro.js`.
3. Enable it and save.
4. Hard-refresh the web client (Ctrl+F5), or clear the cache on mobile browsers.

## Configuration

Settings are at the top of `logo-intro.js`:

```js
const CFG = {
  clipUrl: 'logo-intro.mp4',                 // file name, relative to /web/
  videoSelector: 'video.htmlvideoplayer',    // Jellyfin's player element
  sessionGraceMs: 2500,                      // gap between episodes that still counts as the same session
  infoMaxAgeMs: 20000,
  debug: false,                              // true = log decisions to the browser console
};
```

- To use a different file name or subfolder, change `clipUrl`.
- If the clip should replay more readily after you close the player, lower `sessionGraceMs`.

## Troubleshooting

Set `debug: true`, reload, open the browser console (F12), and start a video. Look for lines starting with `[LogoIntro]`.

| Symptom | Fix |
|---|---|
| Nothing happens, no log lines | The script is not injected, or `videoSelector` is wrong. Try `'video'`. |
| Log says `same session` on a new movie | Wait longer than `sessionGraceMs` after closing the player, or lower it. |
| Plays on resume | The `PlaybackInfo` log line shows `ticks: null`, so the start position is not in the request. The script needs a `UserData` lookup instead. |
| Clip does not show, but log says `playing intro` | Check that `/web/logo-intro.mp4` opens directly in the browser. |
| Spinner shows over the clip | Inspect the spinner element and add its class to the CSS rule at the top of the script. |
| Clip hides the player controls | Remove `z-index:1` from the clip style in `playIntro`. |
| Clip does not fill the screen | Set `position: relative` on the video's parent element. |

## Known limitations

- Trailers and music videos also trigger the clip, since there is no item type filter.
- The main item's playback report starts when the clip begins, so "Now playing" shows it as started.
- The player's progress bar shows the main item paused at 0:00 during the clip.
- Pressing play in the player during the clip does nothing.