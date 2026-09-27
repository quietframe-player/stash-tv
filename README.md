# Stash TV

A lightweight player for [Stash](https://stashapp.cc/), built for TV remotes and desktop browsers.
It keeps one video element loaded as you move through a shuffled queue. The player has compact
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

Click the video to pause or play. Double-click it to toggle fullscreen.
Controls hide during playback. Move the pointer or press Up/Down to show them.
Autoplay and fullscreen still follow your browser's user-gesture rules.

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
| R / LG Green | Random video |
| Delete | Permanently delete, when enabled |

Preview images use Stash's generated sprites. They are interval samples, marked `≈`,
not frame-accurate predictions. After seeking, the preview can show the decoded frame.
Generate sprites in Stash if previews are missing. No second video decoder runs for previews.

The player prefers the original stream and can fall back to compatible Stash streams.
Codec support depends on the browser and device. If a WebM transcode reports a
premature end, the player recovers through an available MP4 stream at the same resolution. When playback fails, a quality selector appears.
Resume positions follow Stash's **Always start from beginning** preference.

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
