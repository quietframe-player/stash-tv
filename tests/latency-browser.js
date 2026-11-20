export default async function verifyLatency(page, options) {
  const results = [], errors = [], latencies = [];
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  page.on("pageerror", error => errors.push(error.message));
  const api = async query => {
    const response = await page.request.post(options.baseURL + "/graphql", { data: { query } });
    const body = await response.json();
    check(response.ok() && !body.errors, JSON.stringify(body));
    return body.data;
  };
  const ready = () => page.waitForFunction(() => {
    const video = document.getElementById("video");
    return video.readyState >= 2 && !video.seeking && document.getElementById("player").dataset.videoReady === "true";
  });
  const absoluteTime = () => page.locator("#video").evaluate(video =>
    video.currentTime + (Number(new URL(video.currentSrc).searchParams.get("start")) || 0));
  const seek = async seconds => {
    const began = Date.now();
    await page.locator("#seek").evaluate((range, seconds) => {
      range.value = String(seconds); range.dispatchEvent(new Event("change", { bubbles: true }));
    }, seconds);
    await ready();
    const time = await absoluteTime();
    check(Math.abs(time - seconds) < 0.15, "Seek did not preserve its absolute position: " + JSON.stringify({ seconds, time }));
    return Date.now() - began;
  };
  try {
    const { findScenes } = await api('{findScenes{scenes{id files{path}}}}');
    check(findScenes.scenes.length === 2, "Expected two isolated Sintel fixtures");
    const id = findScenes.scenes.find(scene => scene.files[0].path === "/media/sintel.mp4").id;
    const matroska = findScenes.scenes.find(scene => scene.files[0].path === "/media/sintel.mkv").id;
    await page.goto(options.baseURL + "/plugin/stash-tv/assets/index.html?autoplay=false&scene=" + id);
    await ready();
    for (const fromBeginning of [false, true]) {
      const startupContext = await page.context().browser().newContext({ serviceWorkers: "block" });
      let releaseQueue;
      const queueGate = new Promise(resolve => { releaseQueue = resolve; });
      const position = fromBeginning ? 0 : 12.3;
      try {
        const startup = await startupContext.newPage();
        await startup.addInitScript(() => {
          window.startupLoads = 0;
          document.addEventListener("loadedmetadata", event => {
            if (event.target.id === "video") window.startupLoads++;
          }, true);
        });
        await startup.route("**/graphql", async route => {
          const query = route.request().postDataJSON().query;
          if (!query.includes("query TVQueue") && !query.includes("query TVScene")) return route.continue();
          const response = await route.fetch();
          const body = await response.json();
          if (body.data?.findScene?.id === id) body.data.findScene.resume_time = 12.3;
          if (body.data?.configuration) (body.data.configuration.ui ??= {}).alwaysStartFromBeginning = fromBeginning;
          if (body.data?.findScenes) {
            body.data.findScenes.scenes = [{ id }, { id: matroska }];
            await queueGate;
            if (fromBeginning) return route.fulfill({ status: 503, body: "Queue unavailable" });
          }
          await route.fulfill({ response, json: body });
        });
        await startup.goto(options.baseURL + "/plugin/stash-tv/assets/index.html?autoplay=false&scene=" + id);
        await startup.waitForFunction(expected => {
          const video = document.getElementById("video");
          return document.getElementById("player").dataset.videoReady === "true" &&
            video.readyState >= 2 && video.paused && Math.abs(video.currentTime - expected) < 0.15;
        }, position, { timeout: 5000 }).catch(async error => {
          const state = await startup.evaluate(() => {
            const player = document.getElementById("player");
            const video = document.getElementById("video");
            return { ready: player.dataset.videoReady, phase: player.dataset.phase,
              time: video.currentTime, paused: video.paused, source: video.currentSrc,
              status: document.getElementById("status").textContent };
          });
          throw new Error("Explicit scene did not decode at " + position + " before queue release: " + error.message + " " + JSON.stringify(state));
        });
        const disabled = await startup.evaluate(() => ["next", "previous", "random", "layout-two", "delete"]
          .every(name => document.getElementById(name).disabled));
        check(disabled, "Queue controls became active before the library order arrived");
        releaseQueue();
        if (fromBeginning) {
          await startup.waitForFunction(() => document.getElementById("notice").textContent.startsWith("Queue could not load"));
          check(await startup.evaluate(() => window.startupLoads === 1 && document.getElementById("next").disabled &&
            document.getElementById("player").dataset.videoReady === "true"), "Queue failure interrupted the current video");
          results.push({ name: "start-from-beginning settings apply before the queue and queue failure preserves playback", passed: true });
        } else {
          await startup.waitForFunction(() => !document.getElementById("next").disabled);
          check(await startup.evaluate(expected => window.startupLoads === 1 &&
            Math.abs(document.getElementById("video").currentTime - expected) < 0.15, position), "Queue hydration restarted the current video");
          await startup.locator("#more").click();
          await startup.locator("#next").click();
          await startup.waitForFunction(expected => new URL(location.href).searchParams.get("scene") === expected &&
            document.getElementById("player").dataset.videoReady === "true", matroska);
          results.push({ name: "explicit scene decodes the saved frame before the library order without restarting at hydration", passed: true });
        }
      } finally {
        releaseQueue();
        await startupContext.close();
      }
    }
    await seek(8);
    await page.request.get(options.baseURL + "/_test/delay/" + id);
    const began = Date.now();
    await page.locator("#source").selectOption({ label: "MP4 Low (240p)" }, { force: true });
    await ready();
    const restartMs = Date.now() - began;
    const hasWindow = () => page.locator("#video").evaluate(video => {
      return [video.buffered, video.seekable].every(ranges => {
        for (let i = 0; i < ranges.length; i++) if (ranges.start(i) <= 1 && ranges.end(i) > 7) return true;
        return false;
      });
    });
    if (!await hasWindow()) {
      await page.locator("#surface").click();
      await page.waitForTimeout(1200);
      await page.locator("#surface").click();
    }
    const reusable = await hasWindow();
    const source = await page.locator("#video").evaluate(video => video.currentSrc);
    await page.request.get(options.baseURL + "/_test/reset");
    for (const seconds of [11, 14, 10, 13]) latencies.push(await seek(seconds));
    check(await page.locator("#video").evaluate(video => video.paused), "Converted seeking lost pause state");
    const requests = await (await page.request.get(options.baseURL + "/_test/requests")).json();
    if (reusable) {
      check(await page.locator("#video").evaluate((video, source) => video.currentSrc === source, source), "Seekable buffered source was restarted");
      check(requests.length === 0, "Buffered seeks restarted backend work: " + JSON.stringify(requests));
    } else check(requests.length >= 4, "Unseekable converted media did not restart at each exact target");
    results.push({ name: reusable ? "four buffered converted seeks reuse one source and preserve absolute timestamps" : "unseekable converted media retains exact restart behavior", passed: true, restartMs, latencies, reusable });
    const backwardRestartMs = await seek(2);
    check(await page.locator("#video").evaluate(video => Number(new URL(video.currentSrc).searchParams.get("start")) === 2 && video.paused), "Seeking before the stream offset did not restart at the exact target");
    results.push({ name: "seeking before the retained stream restarts at the target", passed: true, backwardRestartMs });
    if (reusable) await page.waitForFunction(() => document.getElementById("video").buffered.length && document.getElementById("video").buffered.end(0) > 7);
    await page.locator("#surface").click();
    await seek(6);
    const before = await absoluteTime();
    await page.waitForTimeout(1200);
    check(await page.locator("#video").evaluate(video => !video.paused) && await absoluteTime() > before + 0.7, "Playing seek stalled or paused after returning");
    await page.locator("#surface").click();
    results.push({ name: "converted seeking preserves ongoing playback", passed: true });

    await page.request.get(options.baseURL + "/_test/delay/off");
    await page.request.get(options.baseURL + "/_test/reset");
    const coldBegan = Date.now();
    await page.goto(options.baseURL + "/plugin/stash-tv/assets/index.html?autoplay=false&scene=" + matroska);
    await ready();
    const coldMs = Date.now() - coldBegan;
    const rawRequests = (await (await page.request.get(options.baseURL + "/_test/requests")).json())
      .filter(request => request.id === matroska);
    const unsupportedMatroska = options.browser === "webkit" &&
      !await page.locator("#video").evaluate(video => video.canPlayType("video/x-matroska"));
    if (unsupportedMatroska) {
      check(await page.locator("#video").evaluate(video => /\/stream\.(mp4|webm|m3u8)$/.test(new URL(video.currentSrc).pathname)), "WebKit did not select a compatible stream");
      const direct = rawRequests.filter(request => request.path.endsWith("/stream"));
      check(direct.length <= 1 && direct.every(request => request.range === "bytes=0-15" && request.bytes === 16),
        "Unsupported Matroska was downloaded beyond its container header: " + JSON.stringify(direct));
      check(!rawRequests.some(request => request.path.endsWith(".mkv")), "WebKit retried another raw Matroska stream");
    } else {
      check(await page.locator("#source option").first().textContent() === "Original / direct", "Native container selection changed outside WebKit");
      check(!rawRequests.some(request => request.range === "bytes=0-15"), "Container probing ran outside WebKit");
    }
    results.push({ name: "raw Matroska compatibility selection avoids whole-file WebKit probing", passed: true, coldMs, rawRequests });
    for (const seconds of [23.4, 48, 4.2]) await seek(seconds);
    check(await page.locator("#video").evaluate(video => video.paused), "Compatible stream seeking lost pause state");
    results.push({ name: "compatible playback seeks forward and backward to exact scene times", passed: true });

    if (unsupportedMatroska) {
      const context = await page.context().browser().newContext({ serviceWorkers: "block" });
      try {
        const stored = await context.newPage();
        await stored.route("**/graphql", async route => {
          const response = await route.fetch();
          const body = await response.json();
          if (body.data?.findScene?.id === matroska)
            body.data.findScene.paths.stream = options.baseURL + "/scene/" + matroska + "/stream";
          await route.fulfill({ response, json: body });
        });
        await page.request.get(options.baseURL + "/_test/reset");
        await stored.goto(options.baseURL + "/plugin/stash-tv/assets/index.html?autoplay=false&scene=" + matroska);
        await stored.waitForFunction(() => document.getElementById("player").dataset.videoReady === "true");
        const direct = (await (await page.request.get(options.baseURL + "/_test/requests")).json())
          .filter(request => request.id === matroska && request.path.endsWith("/stream"));
        check(direct.length === 1 && direct[0].range === "bytes=0-15" && direct[0].bytes === 16,
          "Raw direct endpoint was not bounded to its container header: " + JSON.stringify(direct));
        check(await stored.locator("#video").evaluate(video => /\/stream\.(mp4|webm|m3u8)$/.test(new URL(video.currentSrc).pathname)), "Raw direct Matroska did not fall back to a compatible stream");
        results.push({ name: "raw direct Matroska is classified using only sixteen bytes", passed: true });
        await stored.route("**/scene/" + matroska + "/stream?**", async route => {
          const url = route.request().url();
          const response = await route.fetch({ url: options.baseURL + "/scene/" + id + "/stream" + url.slice(url.indexOf("?")) });
          await route.fulfill({ response });
        });
        await stored.goto(options.baseURL + "/plugin/stash-tv/assets/index.html?autoplay=false&scene=" + matroska);
        await stored.waitForFunction(() => document.getElementById("player").dataset.videoReady === "true");
        check(await stored.locator("#video").evaluate(video => new URL(video.currentSrc).pathname.endsWith("/stream")), "Stored MP4 was incorrectly classified from its original file metadata");
        check(await stored.locator("#source option").first().textContent() === "Original / direct", "Stored MP4 lost the original source choice");
        results.push({ name: "stored MP4 remains native when original file metadata says Matroska", passed: true });
      } finally { await context.close(); }
    }
    const pausedContext = await page.context().browser().newContext({ serviceWorkers: "block" });
    try {
      const paused = await pausedContext.newPage();
      await paused.addInitScript(() => {
        const request = HTMLVideoElement.prototype.requestVideoFrameCallback;
        if (request) HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
          return request.call(this, (now, frame) => { if (!this.paused) callback(now, frame); });
        };
      });
      await paused.goto(options.baseURL + "/plugin/stash-tv/assets/index.html?autoplay=false&scene=" + id);
      await paused.waitForFunction(() => document.getElementById("player").dataset.videoReady === "true");
      await paused.locator("#seek").evaluate(range => { range.value = "12.3"; range.dispatchEvent(new Event("change", { bubbles: true })); });
      await paused.waitForFunction(() => {
        const video = document.getElementById("video");
        return video.paused && !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - 12.3) < 0.15;
      });
      check(await paused.locator("#player").getAttribute("data-video-ready") === "true", "Paused playback waited for an unavailable presentation callback");
      results.push({ name: "paused decoded playback remains ready without presentation callbacks", passed: true });
      const immediate = await paused.locator("#surface").evaluate(surface => {
        surface.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
        return document.getElementById("video").currentTime;
      });
      check(Math.abs(immediate - 22.3) < 0.15, "A single keyboard seek waited for the key-repeat timer");
      await paused.waitForFunction(() => {
        const video = document.getElementById("video");
        return video.paused && !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - 22.3) < 0.15;
      });
      results.push({ name: "single keyboard seeks start immediately at the exact requested position", passed: true });
    } finally { await pausedContext.close(); }
    check(errors.length === 0, errors.join("; "));
    return { passed: true, browser: options.browser, results, errors };
  } catch (error) {
    await page.screenshot({ path: options.reportDir + "/" + options.browser + "-latency-failure.png" });
    return { passed: false, browser: options.browser, results, error: error.message, errors, latencies,
      video: await page.locator("#video").evaluate(video => ({ source: video.currentSrc, time: video.currentTime,
        duration: video.duration, ready: video.readyState, paused: video.paused, error: video.error?.code,
        buffered: Array.from({ length: video.buffered.length }, (_, i) => [video.buffered.start(i), video.buffered.end(i)]),
        seekable: Array.from({ length: video.seekable.length }, (_, i) => [video.seekable.start(i), video.seekable.end(i)]) })),
      requests: await (await page.request.get(options.baseURL + "/_test/requests")).json() };
  }
}
