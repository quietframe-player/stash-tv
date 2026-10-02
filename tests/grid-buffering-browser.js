export default async function verifyGridBuffering(page, options) {
  const results = [], errors = [];
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    window.bufferEvents = [];
    window.gridHandoff = { hold: false, callbacks: [] };
    const request = HTMLVideoElement.prototype.requestVideoFrameCallback;
    HTMLVideoElement.prototype.requestVideoFrameCallback = function(callback) {
      return request.call(this, (now, metadata) => {
        if (window.gridHandoff.hold) window.gridHandoff.callbacks.push(() => callback(now, metadata));
        else callback(now, metadata);
      });
    };
    document.addEventListener("stash-tv-buffer", event => window.bufferEvents.push({ ...event.detail, wall: performance.now() }), true);
    const choices = [3.5 / 16, 6.5 / 15, 9.5 / 14];
    Math.random = () => choices.shift() ?? 0.5;
  });
  const api = async (query, variables = {}) => {
    const response = await page.request.post(options.baseURL + "/graphql", { data: { query, variables } });
    const body = await response.json();
    check(response.ok() && !body.errors, JSON.stringify(body));
    return body.data;
  };
  const ready = count => page.waitForFunction(count => {
    const videos = [...document.querySelectorAll("#views video")];
    return videos.length === count && videos.every(video => video.readyState >= 2 && !video.seeking) &&
      document.getElementById("player").dataset.buffering === "false";
  }, count, { timeout: 20000 });
  const snapshot = () => page.evaluate(() => [...document.querySelectorAll("#views video")].map((video, index) =>
    index ? video.parentElement.dataset.scene : new URL(location.href).searchParams.get("scene")));
  const indexes = () => page.evaluate(async () => {
    const cache = await caches.open("stash-tv-media-v1");
    const keys = (await cache.keys()).filter(key => key.url.endsWith("/index"));
    return Promise.all(keys.map(async key => (await cache.match(key)).json()));
  });
  const reset = async ids => {
    await page.goto("about:blank");
    for (const id of ids) await api("mutation($id:ID!){sceneSaveActivity(id:$id,resume_time:20,playDuration:0)}", { id });
  };
  try {
    const { findScenes } = await api('{findScenes(filter:{sort:"random_17",direction:DESC,per_page:-1}){scenes{id files{path}}}}');
    const ids = findScenes.scenes.map(scene => scene.id);
    check(ids.length === 17 && findScenes.scenes.every(scene => scene.files[0].path.startsWith("/media/sintel")), "Expected seventeen isolated Sintel fixtures");
    for (const count of [2, 4]) {
      await reset(ids);
      await page.setViewportSize({ width: count === 4 ? 390 : 1200, height: count === 4 ? 844 : 800 });
      await page.goto(options.baseURL + "/plugin/stash-tv/assets/index.html?autoplay=false&debug=1&seed=17&scene=" + ids[0] + "&layout=" + count);
      await ready(count);
      const current = await snapshot();
      check(JSON.stringify(current) === JSON.stringify([ids[0], ids[4], ids[8], ids[12]].slice(0, count)), "Unexpected isolated grid: " + JSON.stringify(current));
      const group = direction => current.map(id => ids[(ids.indexOf(id) + direction + ids.length) % ids.length]);
      const next = group(1), second = group(2), previous = group(-1);
      const expected = [...next, ...second, ...previous];
      await page.waitForFunction(ids => ids.every(id => window.bufferEvents.some(event => event.state === "prepared" && event.id === id)), expected, { timeout: 10000 });
      const prepared = await page.evaluate(() => window.bufferEvents.filter(event => event.state === "prepared"));
      check(JSON.stringify(prepared.slice(0, expected.length).map(event => event.id)) === JSON.stringify(expected), "Grid did not prepare two groups ahead then previous: " + JSON.stringify(prepared));
      check(prepared.every(event => event.bytes <= 64 * 1024 * 1024 && event.cacheBytes <= event.cacheLimit &&
        event.cacheLimit > 64 * 1024 * 1024 && event.cacheLimit <= 1024 ** 3 && event.entries <= count * 4), "Grid buffering exceeded byte or entry limits");
      const retained = await indexes();
      check(retained.length === expected.length, "Grid evicted prepared neighbors: " + retained.length + "/" + expected.length);
      check(await page.locator("video").count() === count, "Buffering added hidden native video players");
      const events = await page.evaluate(() => window.bufferEvents);
      let active = 0, maximum = 0;
      for (const event of events) {
        if (event.state === "preparing") maximum = Math.max(maximum, ++active);
        else if (["prepared", "cancelled", "skipped"].includes(event.state)) active--;
      }
      check(maximum === 1 && active === 0, "Preparation was not serial: " + JSON.stringify(events));
      check(retained.every(item => item.ranges.every(range => range.end - range.start + 1 <= 2 * 1024 * 1024)), "Native cache chunks exceed 2 MiB");
      results.push({ name: count + " videos prepare two full groups ahead and one behind serially within 1 GiB", passed: true, current, prepared });

      await page.request.get(options.baseURL + "/_test/reset");
      await page.evaluate(() => { window.gridHandoff.hold = true; });
      await page.keyboard.press("ArrowUp");
      await page.waitForFunction(count => window.gridHandoff.callbacks.length >= count, count);
      const covers = await page.evaluate(() => [...document.querySelectorAll("#grid-cover, .extra-view canvas")].map(canvas =>
        ({ hidden: canvas.hidden, width: canvas.width, height: canvas.height })));
      check(covers.length === count && covers.every(cover => !cover.hidden && cover.width > 0), "Grid flashed black before decoded frames: " + JSON.stringify(covers));
      await page.screenshot({ path: options.reportDir + "/" + options.browser + "-grid-handoff-" + count + ".png" });
      await page.evaluate(() => {
        window.gridHandoff.hold = false;
        for (const callback of window.gridHandoff.callbacks.splice(0)) callback();
      });
      await ready(count);
      await page.waitForFunction(() => document.getElementById("grid-cover").hidden &&
        [...document.querySelectorAll(".extra-view canvas")].every(canvas => canvas.hidden));
      results.push({ name: count + " videos retain visible frames until native presentation completes", passed: true, covers });
      check(JSON.stringify(await snapshot()) === JSON.stringify(next), "Buffered Next changed only part of the grid");
      await page.locator("#toggle").click();
      await page.waitForFunction(() => [...document.querySelectorAll("#views video")].every(video => video.paused));
      const requests = await (await page.request.get(options.baseURL + "/_test/requests")).json();
      const playback = requests.filter(request => next.includes(request.id) && request.destination === "video");
      check(playback.every(request => !request.range?.startsWith("bytes=0-")), "Split playback redownloaded a prepared prefix: " + JSON.stringify(playback));
      check(await page.evaluate(() => [...document.querySelectorAll("#views video")].every(video => video.currentTime >= 20 && video.currentTime < 23)), "Buffered videos missed their own resume positions");
      await page.keyboard.press("ArrowDown");
      await ready(count);
      check(JSON.stringify(await snapshot()) === JSON.stringify(current), "Previous did not restore the buffered grid");
      results.push({ name: count + " videos reuse prepared ranges for Next and restore the complete previous grid", passed: true, playback });
      await page.screenshot({ path: options.reportDir + "/" + options.browser + "-grid-buffering-" + count + ".png" });
    }
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const budget = await page.evaluate(async () => {
      const urls = Array.from({length: 16}, (_, index) => location.origin + "/scene/" + (index + 1) + "/stream?cache_budget=" + index);
      const request = message => new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = event => {
          channel.port1.close();
          if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.result);
        };
        navigator.serviceWorker.controller.postMessage(message, [channel.port2, ...(message.prepared?.ranges.map(range => range.data) || [])]);
      });
      await request({type: "retain", urls: []});
      const stored = [];
      for (const index of [4, 3, 2, 1, 0]) {
        const bytes = 32 * 1024 * 1024;
        stored.push(await request({type: "store", urls, prepared: {
          url: urls[index], bytes, total: bytes, mime: "video/mp4", modified: "", signature: String(index), seconds: 0,
          ranges: [{start: 0, end: bytes - 1, data: new ArrayBuffer(bytes)}],
        }}));
      }
      const cache = await caches.open("stash-tv-media-v1");
      const indexes = await Promise.all((await cache.keys()).filter(key => key.url.endsWith("/index")).map(async key => (await cache.match(key)).json()));
      const retained = await request({type: "retain", urls: urls.slice(0,4)});
      return {stored, retained, largestChunk: Math.max(...indexes.flatMap(item => item.ranges.map(range => range.end - range.start + 1)))};
    });
    check(budget.stored.every(value => value.stored && value.bytes <= value.limit && value.limit <= 1024 ** 3) && budget.stored.at(-1).bytes === 160 * 1024 * 1024,
      "Browser cache did not use the increased capacity: " + JSON.stringify(budget));
    check(budget.largestChunk === 2 * 1024 * 1024 && budget.retained.bytes === 128 * 1024 * 1024 &&
      budget.retained.retained.map(item => item.signature).sort().join() === "0,1,2,3", "Retired video ranges were not pruned: " + JSON.stringify(budget));
    results.push({name: "browser retains 160 MiB in bounded chunks and prunes retired videos", passed: true, budget});
    const replacement = await page.evaluate(async () => {
      const url = location.origin + "/scene/1/stream?cache_replacement=1";
      const request = prepared => new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = event => {
          channel.port1.close();
          if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.result);
        };
        navigator.serviceWorker.controller.postMessage({type: "store", urls: [url], prepared},
          [channel.port2, ...prepared.ranges.map(range => range.data)]);
      });
      const prepared = length => ({url, bytes: length, total: 32, mime: "video/mp4", modified: "",
        signature: "replacement", seconds: length,
        ranges: [{start: 0, end: length - 1, data: Uint8Array.from({length}, (_, i) => i).buffer}]});
      const cache = await caches.open("stash-tv-media-v1");
      await request(prepared(16));
      const index = (await cache.keys()).find(key => key.url.endsWith("/index"));
      const old = await (await cache.match(index)).json();
      await request(prepared(8));
      const part = old.revision ? old.revision + "/0" : "0";
      const response = await cache.match(new URL(part, new URL("./_media/" + old.id + "/", navigator.serviceWorker.controller.scriptURL)));
      const latest = await (await cache.match(index)).json();
      return {oldBytes: response ? (await response.arrayBuffer()).byteLength : null, latestBytes: latest.bytes};
    });
    check(replacement.oldBytes === null || replacement.oldBytes === 16,
      "A reader holding the old index received shorter replacement bytes: " + JSON.stringify(replacement));
    check(replacement.latestBytes === 8, "Replacement was not stored");
    results.push({name: "replacing a checkpoint cannot mix new range bytes with an in-flight old index", passed: true});
    check(errors.length === 0, "Page errors: " + errors.join("; "));
    return { passed: true, browser: options.browser, results, errors };
  } catch (error) {
    await page.screenshot({ path: options.reportDir + "/" + options.browser + "-grid-buffering-failure.png" });
    return { passed: false, browser: options.browser, results, error: error.message, errors,
      events: await page.evaluate(() => window.bufferEvents || []), cache: await indexes().catch(() => []) };
  }
}
