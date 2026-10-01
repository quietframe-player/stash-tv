export default async function verifyBuffering(page, options) {
  const results = [], hits = [], errors = [];
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => { if (response.headers()["x-stash-tv-cache"]) hits.push(response.url()); });
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.addInitScript(() => {
    window.bufferEvents = [];
    document.addEventListener("stash-tv-buffer", event => window.bufferEvents.push({ ...event.detail, wall: performance.now() }), true);
  });
  const api = async (query, variables = {}) => {
    const response = await page.request.post(options.baseURL + "/graphql", { data: { query, variables } });
    const body = await response.json();
    check(response.ok() && !body.errors, JSON.stringify(body));
    return body.data;
  };
  const ready = () => page.waitForFunction(() => document.querySelector("#player").dataset.videoReady === "true" && !document.querySelector("#video").seeking);
  const scene = () => page.evaluate(() => new URL(location.href).searchParams.get("scene"));
  const cache = () => page.evaluate(async () => {
    const cache = await caches.open("stash-tv-media-v1");
    const keys = (await cache.keys()).filter(request => request.url.endsWith("/index"));
    const responses = await Promise.all(keys.map(key => cache.match(key)));
    return Promise.all(responses.filter(Boolean).map(response => response.json()));
  });
  const seek = async seconds => {
    await page.locator("#seek").evaluate((range, seconds) => { range.value = String(seconds); range.dispatchEvent(new Event("change", { bubbles: true })); }, seconds);
    await ready();
  };
  const wheel = async delta => { await page.mouse.move(500, 300); await page.mouse.wheel(0, delta); };
  try {
    const { findScenes } = await api('{findScenes(filter:{sort:"random_17",direction:DESC,per_page:-1}){scenes{id files{path}}}}');
    const ids = findScenes.scenes.map(scene => scene.id);
    check(ids.length === 5 && findScenes.scenes.every(scene => scene.files[0].path.startsWith("/media/sintel")), "Expected five isolated Sintel fixtures");
    for (const id of ids) await api("mutation($id:ID!){sceneSaveActivity(id:$id,resume_time:20,playDuration:0)}", { id });
    await page.goto(options.baseURL + "/plugin/stash-tv/assets/index.html?autoplay=false&debug=1&seed=17&scene=" + ids[1]);
    await ready();
    await page.waitForFunction(ids => ids.every(id => window.bufferEvents.some(event => event.state === "prepared" && event.id === id)), [ids[2], ids[3], ids[0]]);
    const prepared = await page.evaluate(() => window.bufferEvents.filter(event => event.state === "prepared"));
    check(prepared.slice(0, 3).map(event => event.id).join() === [ids[2], ids[3], ids[0]].join(), "Preparation order was not two next, then previous: " + JSON.stringify(prepared));
    check(prepared.every(event => event.bytes <= 16 * 1024 * 1024 && event.cacheBytes <= 64 * 1024 * 1024 && event.entries <= 4), "Preparation exceeded cache limits");
    check(prepared.every(event => Math.abs(event.frameTime - 20) < 0.05), "Prepared frame did not match the native 20-second checkpoint: " + JSON.stringify(prepared));
    const indexes = await cache();
    check(indexes.length === 3 && indexes.every(index => index.ranges.length >= 2), "Missing prepared media ranges");
    check(JSON.stringify(indexes).indexOf("http:") === -1 && JSON.stringify(indexes).indexOf("apikey") === -1, "Cache persisted a credential-bearing stream URL");
    results.push({ name: "two next and one previous prepared serially with exact resume frames and bounded bytes", passed: true, prepared });

    await wheel(50);
    await page.waitForFunction(() => document.querySelector("#player").dataset.swipePhase === "dragging");
    const drag = await page.evaluate(() => ({
      scene: new URL(location.href).searchParams.get("scene"),
      offset: new DOMMatrix(getComputedStyle(document.querySelector("#video")).transform).m42,
      incoming: document.querySelector("#swipe-incoming").width,
    }));
    check(drag.scene === ids[1] && drag.offset === -50, "Trackpad did not move the current video before navigation: " + JSON.stringify(drag));
    await page.waitForFunction(() => document.querySelector("#swipe-incoming").width > 0);
    const frame = await page.locator("#swipe-incoming").evaluate(canvas => ({ data: canvas.toDataURL(), width: canvas.width, height: canvas.height }));
    await page.screenshot({ path: options.reportDir + "/" + options.browser + "-buffered-trackpad.png" });
    await page.request.get(options.baseURL + "/_test/reset");
    await wheel(90);
    for (let i = 0; i < 4; i++) { await wheel(20); await page.waitForTimeout(20); }
    await ready();
    await page.locator("#toggle").click();
    await page.waitForTimeout(300);
    check(await scene() === ids[2], "Trackpad momentum skipped more than one scene");
    const requests = await (await page.request.get(options.baseURL + "/_test/requests")).json();
    const playback = requests.filter(request => request.id === ids[2]);
    check(playback.every(request => !request.range?.startsWith("bytes=0-")), "Playback redownloaded the prepared prefix: " + JSON.stringify(playback));
    check(await page.locator("#video").evaluate(video => video.currentTime >= 20 && video.currentTime < 22), "Playback did not start at the prepared checkpoint");
    const mismatch = await page.evaluate(async frame => {
      const image = new Image(); image.src = frame.data; await image.decode();
      const expected = document.createElement("canvas"), actual = document.createElement("canvas");
      expected.width = actual.width = frame.width; expected.height = actual.height = frame.height;
      const left = expected.getContext("2d"), right = actual.getContext("2d");
      left.drawImage(image, 0, 0); right.drawImage(document.querySelector("#video"), 0, 0, frame.width, frame.height);
      const a = left.getImageData(0, 0, frame.width, frame.height).data, b = right.getImageData(0, 0, frame.width, frame.height).data;
      let delta = 0; for (let i = 0; i < a.length; i += 4) delta += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      return delta / (a.length / 4 * 3);
    }, frame);
    check(mismatch < 18, "Prepared frame jumped to an unrelated decoded view: pixel difference " + mismatch);
    results.push({ name: "native playback reuses prepared ranges and trackpad momentum advances only one scene", passed: true, playback, cacheHits: hits.length, framePixelDifference: mismatch });

    for (const seconds of [7.3, 31.8, 12.7, 39]) {
      await seek(seconds);
      check(await page.locator("#video").evaluate((video, seconds) => video.paused && Math.abs(video.currentTime - seconds) < 0.12, seconds), "Buffered playback broke paused native seeking at " + seconds);
    }
    const saved = await page.locator("#video").evaluate(video => video.currentTime);
    await page.locator("#previous").click(); await ready();
    await page.locator("#toggle").click();
    await page.locator("#next").click(); await ready();
    await page.locator("#toggle").click();
    check(Math.abs(await page.locator("#video").evaluate(video => video.currentTime) - saved) < 1, "Returning to a paused seek used an old checkpoint");
    results.push({ name: "repeated paused seeks and returning to an updated checkpoint keep native behavior", passed: true });

    await page.request.get(options.baseURL + "/_test/delay/" + ids[2]);
    const duration = await page.locator("#video").evaluate(video => video.duration);
    await seek(duration - 0.2);
    await page.locator("#toggle").click();
    await page.waitForFunction(id => new URL(location.href).searchParams.get("scene") !== id, ids[2]);
    await ready();
    await wheel(-50);
    await page.waitForFunction(() => document.querySelector("#player").dataset.swipePhase === "dragging");
    check(await page.locator("#swipe-incoming").evaluate(canvas => canvas.width === 0), "Ended scene retained its last frame as the zero-second restart preview");
    await wheel(-90); await ready();
    check(await scene() === ids[2] && await page.locator("#video").evaluate(video => video.currentTime < 2), "Ended scene resumed its old position instead of restarting");
    await page.locator("#toggle").click();
    await page.request.get(options.baseURL + "/_test/delay/off");
    await page.waitForTimeout(220);
    results.push({ name: "ended videos restart at zero without displaying their final frame as a loading preview", passed: true });

    await wheel(40); await wheel(-30);
    await page.waitForFunction(() => !document.querySelector("#player").dataset.swipePhase, null, { timeout: 2000 });
    check(await scene() === ids[2] && await page.locator("#video").evaluate(video => new DOMMatrix(getComputedStyle(video).transform).m42 === 0), "Short reversed wheel did not return to current video");
    const rail = await page.locator("#seek").boundingBox();
    await page.mouse.move(rail.x + rail.width / 2, rail.y + rail.height / 2); await page.mouse.wheel(0, 400);
    check(await scene() === ids[2], "Wheel over seek bar changed scenes");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await wheel(-140); await ready();
    check(await scene() === ids[1], "Reduced Motion wheel failed to navigate previous");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    results.push({ name: "trackpad reversal, control isolation, and Reduce Motion preserve gesture behavior", passed: true });

    await page.waitForFunction(() => document.querySelector("#player").dataset.cacheEntries >= "3");
    const retained = await cache();
    check(retained.length <= 4 && retained.reduce((sum, item) => sum + item.bytes, 0) <= 64 * 1024 * 1024, "Cache became unbounded after navigation");
    check(await page.locator("video").count() === 1, "Buffering added hidden native video elements");
    check(errors.length === 0, "Page errors: " + errors.join("; "));
    results.push({ name: "navigation retains a bounded cache and one native video element", passed: true });

    await page.request.get(options.baseURL + "/_test/delay/" + ids[2]);
    await page.goto(options.baseURL + "/plugin/stash-tv/assets/index.html?autoplay=false&seed=17&scene=" + ids[1]);
    await ready();
    await page.waitForFunction(id => window.bufferEvents.some(event => event.state === "preparing" && event.id === id), ids[2]);
    await seek(8);
    await page.waitForFunction(id => window.bufferEvents.some(event => event.state === "cancelled" && event.id === id), ids[2]);
    check(await page.locator("#video").evaluate(video => video.paused && Math.abs(video.currentTime - 8) < 0.12), "Current seek waited for background preparation");
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const background = await page.evaluate(() => window.bufferEvents.filter(event => event.state === "prepared").length);
    await page.waitForTimeout(250);
    check(await page.evaluate(() => window.bufferEvents.filter(event => event.state === "prepared").length) === background, "Hidden-page lifecycle continued preparation");
    await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event("visibilitychange")); });
    await page.locator("#next").click(); await page.locator("#next").click(); await page.locator("#next").click();
    await ready();
    check(await scene() === ids[4], "Rapid navigation did not select the last requested scene");
    await page.request.get(options.baseURL + "/_test/delay/off");
    await page.waitForTimeout(2200);
    check(await scene() === ids[4] && errors.length === 0, "Cancelled preparation replaced the current scene");
    check((await cache()).length <= 2, "Obsolete queue entries survived the new neighborhood");
    results.push({ name: "current seeking, hidden-page lifecycle, and rapid navigation cancel background work", passed: true });

    const compatibility = [];
    for (const filename of ["sintel-40.mp4", "sintel-43.mp4", "sintel-46.mp4"]) {
      const target = findScenes.scenes.find(item => item.files[0].path.endsWith("/" + filename)).id;
      const index = ids.indexOf(target);
      const neighbor = ids[index === 0 ? 1 : index - 1];
      await page.goto("about:blank");
      await api("mutation($id:ID!){sceneSaveActivity(id:$id,resume_time:20,playDuration:0)}", { id: target });
      await page.goto(options.baseURL + "/plugin/stash-tv/assets/index.html?autoplay=false&seed=17&scene=" + neighbor);
      await ready();
      await page.waitForFunction(id => window.bufferEvents.some(event => event.state === "prepared" && event.id === id), target);
      const prepared = await page.evaluate(id => window.bufferEvents.find(event => event.state === "prepared" && event.id === id), target);
      check(Math.abs(prepared.seconds - 20) < 0.05 && Math.abs(prepared.frameTime - 20) < 0.05,
        "MP4 timing or header handling changed the resume frame: " + JSON.stringify({ filename, prepared }));
      check(prepared.bytes <= 16 * 1024 * 1024, "Large headers exceeded the item budget");
      compatibility.push({ filename, ...prepared });
    }
    results.push({ name: "large front indexes, leading empty edits, and leading padding with a tail index buffer at the native checkpoint", passed: true, compatibility });

    const fallbackContext = await page.context().browser().newContext({ serviceWorkers: "block" });
    const fallback = await fallbackContext.newPage();
    await fallback.goto(options.baseURL + "/plugin/stash-tv/assets/index.html?autoplay=false&seed=17&scene=" + ids[1]);
    await fallback.waitForFunction(() => document.querySelector("#player").dataset.videoReady === "true");
    await fallback.locator("#seek").evaluate(range => { range.value = "14"; range.dispatchEvent(new Event("change", { bubbles: true })); });
    await fallback.waitForFunction(() => !document.querySelector("#video").seeking && Math.abs(document.querySelector("#video").currentTime - 14) < 0.15);
    check(await fallback.locator("#video").evaluate(video => video.paused), "Unavailable buffering changed pause behavior");
    await fallbackContext.close();
    results.push({ name: "native playback and paused seeking work when service workers are unavailable", passed: true });
    return { passed: true, browser: options.browser, results, errors };
  } catch (error) {
    await page.screenshot({ path: options.reportDir + "/" + options.browser + "-buffering-failure.png" });
    return { passed: false, browser: options.browser, error: error.message, results, errors,
      events: await page.evaluate(() => window.bufferEvents || []), cache: await cache().catch(() => []) };
  }
}
