export default async function verifyHandoff(page, options) {
  const results = [], errors = [];
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  const context = await page.context().browser().newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  });
  page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    window.handoff = { hold: false, callbacks: [], events: [] };
    const request = HTMLVideoElement.prototype.requestVideoFrameCallback;
    HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
      return request.call(this, (now, metadata) => {
        if (this.id === "video" && window.handoff.hold) {
          window.handoff.callbacks.push(() => callback(now, metadata));
        } else callback(now, metadata);
      });
    };
    for (const type of ["canplay", "playing", "seeked"])
      document.addEventListener(type, event => {
        if (event.target.id !== "video") return;
        window.handoff.events.push({ type, time: event.target.currentTime, paused: event.target.paused,
          ready: document.getElementById("player").dataset.videoReady,
          incomingHidden: document.getElementById("swipe-incoming").hidden });
      }, true);
  });
  const ready = () => page.waitForFunction(() => document.getElementById("player").dataset.videoReady === "true");
  const scene = () => page.evaluate(() => new URL(location.href).searchParams.get("scene"));
  const cdp = options.browser === "chrome" ? await context.newCDPSession(page) : null;
  if (!cdp) await page.addInitScript(() => { Element.prototype.setPointerCapture = function () {}; });
  const touch = async (type, y) => {
    if (cdp) await cdp.send("Input.dispatchTouchEvent", {
      type: { down: "touchStart", move: "touchMove", up: "touchEnd" }[type],
      touchPoints: type === "up" ? [] : [{ x: 195, y, id: 1 }],
    });
    else await page.locator("#surface").dispatchEvent("pointer" + type, {
      pointerType: "touch", pointerId: 1, isPrimary: true, clientX: 195, clientY: y,
      bubbles: true, cancelable: true,
    });
  };
  try {
    const response = await page.request.post(options.baseURL + "/graphql", {
      data: { query: "{findScenes{scenes{id files{path}}}}" },
    });
    const body = await response.json();
    check(response.ok() && !body.errors && body.data.findScenes.scenes.length === 2 &&
      body.data.findScenes.scenes.every(item => item.files[0].path.startsWith("/media/sintel")),
      "Expected two isolated Sintel scenes");
    for (const item of body.data.findScenes.scenes) {
      const saved = await page.request.post(options.baseURL + "/graphql", { data: {
        query: "mutation($id:ID!){sceneSaveActivity(id:$id,resume_time:12.7,playDuration:0)}",
        variables: { id: item.id },
      } });
      check(saved.ok() && !(await saved.json()).errors, "Could not set the fixture checkpoint");
    }
    await page.goto(options.baseURL + "/plugin/stash-tv/assets/index.html?autoplay=false&seed=1");
    await ready();
    const before = await scene();
    await touch("down", 450); await touch("move", 320);
    await page.waitForFunction(() => document.getElementById("swipe-incoming").width > 0);
    await page.evaluate(() => { window.handoff.hold = true; });
    await touch("up", 320);
    await page.waitForFunction(id => new URL(location.href).searchParams.get("scene") !== id, before);
    await page.waitForFunction(() => window.handoff.callbacks.length > 0);
    await page.waitForTimeout(250);
    const pending = await page.evaluate(() => ({
      ready: document.getElementById("player").dataset.videoReady,
      phase: document.getElementById("player").dataset.swipePhase,
      hidden: document.getElementById("swipe-incoming").hidden,
      width: document.getElementById("swipe-incoming").width,
      decoded: document.getElementById("video").readyState,
      paused: document.getElementById("video").paused,
      callbacks: window.handoff.callbacks.length,
    }));
    check(pending.ready === "false" && pending.phase === "loading" && !pending.hidden && pending.width > 0,
      "Incoming frame disappeared before the next video's presentation callback: " + JSON.stringify(pending));
    await page.screenshot({ path: options.reportDir + "/" + options.browser + "-handoff-retained.png" });
    await page.evaluate(() => {
      window.handoff.hold = false;
      for (const callback of window.handoff.callbacks.splice(0)) callback();
    });
    await ready();
    await page.waitForFunction(() => !document.getElementById("player").dataset.swipePhase);
    check(await page.locator("#swipe-incoming").isHidden(), "Presented video left the preview overlay visible");
    const time = await page.locator("#video").evaluate(video => video.currentTime);
    await page.waitForTimeout(500);
    check(await page.locator("#video").evaluate((video, time) => !video.paused && video.currentTime > time + 0.2, time),
      "Frame handoff interrupted playback");
    results.push({ name: "swipe preview remains visible until the incoming playing frame is presented", passed: true, pending });

    await touch("down", 320); await touch("move", 450);
    await page.waitForFunction(() => document.getElementById("swipe-incoming").width > 0);
    await page.evaluate(() => { window.handoff.hold = true; });
    await touch("up", 450);
    await page.waitForFunction(id => new URL(location.href).searchParams.get("scene") === id, before);
    await page.waitForFunction(() => window.handoff.callbacks.length > 0);
    await page.waitForTimeout(250);
    await page.locator("#toggle").click();
    await page.waitForFunction(() => document.getElementById("video").paused &&
      document.getElementById("player").dataset.videoReady === "true" &&
      !document.getElementById("player").dataset.swipePhase);
    await page.evaluate(() => { window.handoff.hold = false; window.handoff.callbacks.length = 0; });
    results.push({ name: "pausing during the frame handoff exposes the decoded paused position", passed: true });

    for (const denied of [false, true]) {
      const fallbackContext = await page.context().browser().newContext({
        viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      });
      let fallback;
      try {
        fallback = await fallbackContext.newPage();
        await fallback.bringToFront();
        fallback.on("pageerror", error => errors.push(error.message));
        await fallback.addInitScript(denied => {
          HTMLVideoElement.prototype.requestVideoFrameCallback = undefined;
          HTMLVideoElement.prototype.cancelVideoFrameCallback = undefined;
          const play = HTMLMediaElement.prototype.play;
          window.allowPlayback = false;
          HTMLMediaElement.prototype.play = function () {
            if (window.allowPlayback) return play.call(this);
            if (denied) return Promise.reject(new DOMException("Autoplay requires a gesture", "NotAllowedError"));
            return new Promise((resolve, reject) => {
              window.resumePlayback = () => play.call(this).then(resolve, reject);
            });
          };
        }, denied);
        await fallback.goto(options.baseURL + "/plugin/stash-tv/assets/index.html?autoplay=false&seed=1");
        await fallback.waitForFunction(() => document.getElementById("player").dataset.videoReady === "true");
        const current = await fallback.evaluate(() => new URL(location.href).searchParams.get("scene"));
        await fallback.keyboard.press("ArrowUp");
        await fallback.waitForFunction(id => new URL(location.href).searchParams.get("scene") !== id, current);
        if (denied) {
          await fallback.waitForFunction(() => document.getElementById("player").dataset.phase === "ready" &&
            document.getElementById("player").dataset.videoReady === "true" &&
            !document.getElementById("player").dataset.swipePhase && document.getElementById("video").paused);
          await fallback.evaluate(() => { window.allowPlayback = true; });
          await fallback.locator("#toggle").click();
        } else {
          await fallback.waitForFunction(() => window.resumePlayback && document.getElementById("video").readyState >= 2);
          await fallback.waitForTimeout(250);
          check(await fallback.evaluate(() => document.getElementById("player").dataset.videoReady === "false" &&
            document.getElementById("video").paused),
            "A browser without frame callbacks marked the loading video ready before autoplay started");
          await fallback.evaluate(() => { window.allowPlayback = true; window.resumePlayback(); });
        }
        await fallback.waitForFunction(() => document.getElementById("player").dataset.videoReady === "true" &&
          !document.getElementById("player").dataset.swipePhase && !document.getElementById("video").paused);
        results.push({ name: denied ? "blocked autoplay exposes a decoded paused frame and retries on user input" :
          "browsers without frame callbacks wait for autoplay to start before marking video ready", passed: true });
      } catch (error) {
        const state = await fallback.evaluate(() => ({ hidden: document.hidden,
          ready: document.getElementById("player")?.dataset.videoReady,
          phase: document.getElementById("player")?.dataset.phase,
          swipe: document.getElementById("player")?.dataset.swipePhase,
          paused: document.getElementById("video")?.paused,
          resumePlayback: !!window.resumePlayback }));
        throw new Error((denied ? "Blocked autoplay" : "No frame callback") + ": " + error.message + " " + JSON.stringify(state));
      } finally { await fallbackContext.close(); }
    }
    check(errors.length === 0, errors.join("; "));
    return { passed: true, browser: options.browser, results, errors };
  } catch (error) {
    await page.screenshot({ path: options.reportDir + "/" + options.browser + "-handoff-failure.png" });
    return { passed: false, browser: options.browser, error: error.message, results, errors,
      events: await page.evaluate(() => window.handoff?.events) };
  } finally { await context.close(); }
}
