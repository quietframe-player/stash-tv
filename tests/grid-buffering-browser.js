export default async function verifyGridBuffering(page, options) {
  const results = [], errors = [];
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    window.bufferEvents = [];
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
      check(prepared.every(event => event.bytes <= 16 * 1024 * 1024 && event.cacheBytes <= 64 * 1024 * 1024 && event.entries <= count * 4), "Grid buffering exceeded byte or entry limits");
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
      results.push({ name: count + " videos prepare two full groups ahead and one behind serially within 64 MiB", passed: true, current, prepared });

      await page.request.get(options.baseURL + "/_test/reset");
      await page.keyboard.press("ArrowUp");
      await ready(count);
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
    check(errors.length === 0, "Page errors: " + errors.join("; "));
    return { passed: true, browser: options.browser, results, errors };
  } catch (error) {
    await page.screenshot({ path: options.reportDir + "/" + options.browser + "-grid-buffering-failure.png" });
    return { passed: false, browser: options.browser, results, error: error.message, errors,
      events: await page.evaluate(() => window.bufferEvents || []), cache: await indexes().catch(() => []) };
  }
}
