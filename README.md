# Stash TV

A lightweight player for [Stash](https://stashapp.cc/), built for TV remotes, phones, and desktop browsers.
It keeps one video element loaded in single view as you move through a shuffled queue. The player has compact
icon controls, a seek bar, frame previews, volume controls, and saved playback positions.
No separate service, Node runtime, or frontend build is needed to use it.

## Install

Requires **Stash v0.31.1 or later**. Version 0.31.1 is tested.

1. Open **Settings → Plugins → Available Plugins → Add Source**.
2. Use the name `Stash TV` and this source URL:

   ```text
   https://quietframe-player.github.io/stash-tv/index.yml
   ```

3. Refresh the available plugins and install **Stash TV**.
4. Reload Stash. Click the TV icon in its top navigation.

On a scene page, the TV icon opens that scene. Elsewhere it opens a shuffled queue.
You can bookmark the standalone player at `/plugin/stash-tv/assets/index.html` on your Stash server.
Login to Stash first when authentication is enabled. The player uses the same origin and session.

To update, open **Settings → Plugins → Installed Plugins**, check for updates, then reload the player.
To uninstall, remove **Stash TV** from that page. This removes the plugin, not your library.

## Playback

Click the video to pause or play. Double-click it to enter fullscreen.
Click the speaker button to open volume adjustment and mute controls.
Controls hide during playback. Move the pointer or tap the video to show them.
Autoplay and fullscreen still follow your browser's user-gesture rules.

The split-screen and grid buttons play **two or four distinct random videos** together.
Click the selected layout button again to return to a single video. Two videos sit beside
each other in landscape and stack in portrait. Four videos fill a 2×2 grid. Tiles have
no gaps or borders and crop their edges to fill the available space.

Hover, tap, or focus a video to reveal its controls; the other videos stay clear.
The selected tile has a seek bar and four icons: play/pause, volume, fullscreen, and More.
Previous, Random, and Next are inside More, and each feed keeps its own navigation history.
Tap a video to pause only that tile. Choose its volume button to hear its audio; the other tiles mute.
One grid menu pauses or resumes all videos and changes the layout. Controls fade away during playback. When an extra
video ends, its tile picks another random scene. All tiles save their playback positions in Stash.
Keyboard shortcuts apply to the focused tile. Permanent deletion is available in single view.

Extra streams load only while multiview is selected and unload when you return to single
view. Neighbor preparation pauses during multiview to give the playing videos bandwidth.
Simultaneous playback depends on your device's video decoders and the available network
and Stash streaming capacity.
Use a tile's fullscreen button to expand that video and return to the grid when you exit. On iPhone, the tile uses native video fullscreen when page fullscreen is unavailable. The grid menu's fullscreen button expands the whole grid on supported browsers.

| Key | Action |
| --- | --- |
| Space / LG Yellow | Pause or play |
| Enter / LG OK | Enter fullscreen |
| Left / Right, A / D | Seek backward / forward 10 seconds |
| Shift+A / Shift+D | Seek backward / forward 60 seconds |
| 0–9 | Jump to 0%–90% of the video |
| W / S | Volume up / down by 5% |
| F / LG Blue | Next video |
| Shift+F / LG Red | Previous video |
| Up / Down | Next / previous video with a vertical transition |
| R / LG Green | Random video |
| Delete | Permanently delete, when enabled |

Preview images use Stash's generated sprites. They are interval samples, marked `≈`,
not frame-accurate predictions. After seeking, the preview can show the decoded frame.
Generate sprites in Stash if seek previews are missing.

The player prefers the original stream and can fall back to compatible Stash streams.
Codec support depends on the browser and device. If a WebM transcode reports a
premature end, the player recovers through an available MP4 stream at the same resolution. When playback fails, a quality selector appears.
Resume positions follow Stash's **Always start from beginning** preference.

## Touch controls

On phones, tap the video to pause or play. Double-tap the left or right side to seek
backward or forward 10 seconds. Press and hold during playback for 2× speed; release
to restore the previous speed. Swipe up for the next video or down for the previous one.
Gestures stay on the video area, separate from the seek bar and playback controls.

Double taps show a directional ripple and the number of seconds skipped. Each extra
tap on the same side adds another 10 seconds. Hold-to-2× activates after 200 ms and
changes speed on the current stream. Drag the seek bar in either direction, then
release to seek; cancellation keeps the current playback position.

During a vertical swipe, the current and incoming views follow your finger.
Release completes the slide immediately while the next video loads. Desktop vertical
trackpad scrolling moves the same views directly. Crossing the navigation threshold
advances one video; the remaining momentum stays in that gesture. Short or reversed
drags return to the current video. Scrolling over controls does not change videos.

The player prepares two videos ahead and one behind, in that order. For original MP4
streams, it reads the index and buffers up to five seconds around the saved position,
starting at the preceding keyframe. Preparation is serial, cancels obsolete work,
and yields while the current video loads or seeks. Hidden pages stop preparation.
A local service worker feeds the prepared ranges to the existing native video element.
The cache holds at most four items, 16 MiB each and 64 MiB total, expires after ten
minutes, and is cleared when the page closes. Stored cache keys hash the stream URL;
the cache index does not persist its authorization parameters.
MP4 headers can span range requests or follow a large padding box. Their read budget
is 8 MiB within the same 16 MiB item limit. A leading empty edit uses the movie's
timing scale when aligning the checkpoint frame.

A worker briefly decodes the exact checkpoint frame when WebCodecs supports the codec,
then releases its decoder. Returning to a watched scene can reuse its last decoded
frame at that same checkpoint. This frame stays visible until playback is ready at
the saved position. If an exact frame is unavailable, the loading view stays blank.
Other containers, oversized indexes, unsupported codecs, and browsers without service
workers keep normal playback. Preparation never starts neighboring transcodes or
changes video quality. Buffering requires HTTPS or localhost. Single view uses one
native video element and at most four cached stills.
Neighbor metadata loads concurrently with the current video. Media preparation still
yields to playback and seeking. Converted streams reuse their buffered, seekable
window instead of restarting conversion for every jump. A position outside that
window starts a new stream at the exact requested time.

On WebKit, an unsupported Matroska source is detected with a bounded sixteen-byte
header request. A stored MP4 keeps native playback. Raw Matroska uses Stash's
highest available compatible stream, preferring supported VP9/Opus WebM for fast
startup, then native HLS. Original sources stay the default in other browsers. Cold
conversion speed still depends on the Stash server's CPU and streaming settings.
Intentionally paused playback becomes ready once the browser has decoded the target
position; it does not wait for a presentation callback that a paused stream may never emit.
During autoplay, a swipe retains its incoming frame until the new video presents
the requested position. Browsers without frame callbacks wait for playback to
start, and blocked autoplay exposes the decoded paused frame for the next gesture.
With Reduce Motion enabled, dragging still follows your finger and release uses
a short fade instead of a slide.

Portrait mode gives the seek bar a full row and keeps icons at their regular size.
Volume stays behind its speaker button on desktop and mobile.
On touch devices, the zoom button toggles between fitting the whole video and
filling the screen by cropping its edges. The choice stays active between videos.
In Fill mode, drag left or right to move the cropped video with your finger.
Panning stops at the image edges. Each new video starts centered, and switching
back to Fit restores the whole frame. Vertical swipes still change videos.
Fullscreen uses the browser API when available and the native video player on iPhones
that only support video fullscreen. Native iPhone fullscreen uses Apple's controls;
custom gestures remain available in the inline player.

## Scene markers

Existing Stash scene markers appear as ticks above the seek bar. Markers with an end time
also show a thin range. Hover or focus a tick to see its label; click it, or press Space/Enter
while it is focused, to jump to its start. Seeking preserves whether the video is playing or paused.

Frame previews show the labels of all marker ranges at the selected time. Start-only markers
label that timestamp without implying an end time. Labels still work when sprites are missing.
Videos without markers keep the normal seek bar. Add or edit markers in Stash; the player reads
their titles and primary tags, and does not analyze or automatically label videos.

## Optional permanent deletion

Deletion is disabled by default. Enable **Settings → Plugins → Stash TV → Enable permanent deletion**
to show the delete button and enable the Delete shortcut. Reload the player after changing the setting.

**Deletion is immediate, with no confirmation or undo.** It removes the scene, original video files,
and generated assets. It refuses deletion when Stash's trash path is configured. This plugin never
changes that global setting. Only enable this feature on a trusted device.

## Develop and test

The runtime is plain HTML, CSS, and JavaScript. `launcher.js` adds the navigation link through
Stash's PluginApi. Assets are served by Stash itself. No analytics or third-party runtime requests
are included.

```sh
bun test
python3 scripts/build.py
python3 scripts/integration.py --apply
python3 scripts/integration.py --apply --suite plugin
python3 scripts/integration.py --apply --suite mobile
```

The builder uses Python's standard library. It creates `dist/stash-tv.zip` and `dist/index.yml` with
a SHA-256 checksum. Keep the version in `package.json` and `plugins/stash-tv/stash-tv.yml` in sync.
GitHub Actions publishes this directory to GitHub Pages after the checks pass on `main`.

The integration test requires Docker, Python 3, Node/npm, and Playwright's Chromium and WebKit.
It downloads the public Sintel trailer, starts an isolated Stash v0.31.1, installs the **built ZIP
through Stash's package manager**, and exercises playback and seeking in both browsers.
The plugin suite also checks the launcher, login protection, deletion settings, and permanent
removal of the disposable fixture and its file. Reports go into `.tmp/`. Its container and package server are removed at the end.
Use `--browser chrome` or `--browser webkit` to test one engine.

For a running Stash instance, preview registration and installation with:

```sh
python3 scripts/install.py --url http://localhost:9999
python3 scripts/install.py --url http://localhost:9999 --apply
```

Set `STASH_API_KEY` in the environment if your server requires it. `--enable-delete` explicitly enables
permanent deletion. The installer preserves existing plugin sources and does not touch media files.

Reverse proxies must forward the plugin asset route and GraphQL/media requests to Stash on the same
origin. Stash's configured base path is supported by the launcher and player. Test your target browser
before relying on an older TV firmware.

## License

MIT. Icons in the player are [Lucide](https://lucide.dev/) under the ISC license, included in
[`LUCIDE-LICENSE.txt`](plugins/stash-tv/web/LUCIDE-LICENSE.txt). The launcher uses Stash's bundled TV icon.

The lazy MP4 parser is [MP4Box.js 2.4.1](https://github.com/gpac/mp4box.js), distributed
under [BSD-3-Clause](plugins/stash-tv/web/MP4BOX-LICENSE.txt). Its pinned artifact can
be rebuilt with Bun 1.4.0 using `python3 scripts/vendor_mp4box.py --apply`; ordinary
plugin builds use the committed artifact and need no package installation.
