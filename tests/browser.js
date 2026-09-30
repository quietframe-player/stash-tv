export default async function verifyPlayer(page, options) {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const results = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const api = async (query, variables = {}) => {
    const response = await page.request.post(options.baseURL + "/graphql", {
      data: { query, variables },
    });
    const body = await response.json();
    assert(response.ok() && !body.errors, JSON.stringify(body));
    return body.data;
  };
  const data = await api("{findScenes{scenes{id files{path duration} paths{vtt}}}}");
  const scene = data.findScenes.scenes[0];
  assert(
    data.findScenes.scenes.length === 1 && scene.files[0].path === "/media/sintel.mp4",
    "Expected the isolated Sintel library",
  );
  const oldMarkers = await api('query($id:ID!){findScene(id:$id){scene_markers{id}}}', { id: scene.id });
  for (const marker of oldMarkers.findScene.scene_markers)
    await api('mutation($id:ID!){sceneMarkerDestroy(id:$id)}', { id: marker.id });
  const vtt = await page.request.get(scene.paths.vtt);
  assert(vtt.ok() && (await vtt.text()).includes("WEBVTT"), "Stash did not generate the fixture sprite VTT");
  await api("mutation($id:ID!){sceneSaveActivity(id:$id,resume_time:0,playDuration:0)}", {
    id: scene.id,
  });
  await page.addInitScript(() => {
    window.tvMediaEvents = [];
    document.addEventListener("DOMContentLoaded", () => {
      const video = document.getElementById("video");
      if (!video) return;
      for (const event of ["playing", "pause", "seeking", "seeked", "waiting", "ended", "durationchange", "error"]) {
        video.addEventListener(event, () => {
          window.tvMediaEvents.push({
            event,
            time: video.currentTime,
            duration: video.duration,
            wall: performance.now(),
            paused: video.paused,
            source: video.currentSrc,
          });
        });
      }
    });
  });
  const sample = () =>
    page.evaluate(() => {
      const video = document.getElementById("video");
      const offset = Number(new URL(video.currentSrc).searchParams.get("start")) || 0;
      return {
        time: video.currentTime + offset,
        paused: video.paused,
        ended: video.ended,
        duration: video.duration,
        readyState: video.readyState,
        networkState: video.networkState,
        buffered: Array.from({ length: video.buffered.length }, (_, i) => [video.buffered.start(i), video.buffered.end(i)]),
        source: video.currentSrc,
        error: video.error?.message,
        phase: document.getElementById("player").dataset.phase,
        buffering: document.getElementById("player").dataset.buffering,
      };
    });
  const ready = async () => {
    await page.waitForFunction(
      () =>
        ["ready", "playing", "paused", "error"].includes(
          document.getElementById("player").dataset.phase,
        ) && !document.getElementById("video").seeking,
      null,
      { timeout: 20000 },
    );
    const value = await sample();
    assert(value.phase !== "error" && !value.error, JSON.stringify(value));
  };
  const point = async (seconds) => {
    await page.mouse.move(200, 100);
    const box = await page.locator("#seek").boundingBox();
    const duration = Number(await page.locator("#seek").getAttribute("max"));
    return { x: box.x + 6 + ((box.width - 12) * seconds) / duration, y: box.y + box.height / 2 };
  };
  const seek = async (seconds) => {
    const p = await point(seconds);
    await page.mouse.click(p.x, p.y);
    await page.mouse.move(200, 100);
    await page.waitForTimeout(250);
    await ready();
    const actual = await sample();
    assert(
      Math.abs(actual.time - seconds) < 1.5,
      "Seek missed target: " + JSON.stringify({ seconds, actual }),
    );
  };
  const continues = async (name, milliseconds = 6000) => {
    const before = await sample();
    await page.waitForTimeout(milliseconds);
    const after = await sample();
    assert(
      !after.paused &&
        !after.ended &&
        !after.error &&
        after.time > before.time + milliseconds / 1000 - 1.5,
      name + " stopped: " + JSON.stringify({ before, after }),
    );
    results.push({ name, from: before.time, to: after.time, source: after.source });
  };
  try {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(options.baseURL + "/scenes/" + scene.id);
    const closeNotes = page.getByRole("button", { name: "Close", exact: true });
    await closeNotes.click({ timeout: 5000 }).catch(() => {});
    const launcher = page.getByRole("link", { name: "Open Stash TV" });
    await launcher.waitFor();
    const launchURL = await launcher.evaluate(element => ({ pathname: new URL(element.href).pathname, scene: new URL(element.href).searchParams.get("scene") }));
    assert(launchURL.pathname === "/plugin/stash-tv/assets/index.html" && launchURL.scene === scene.id,
      "Launcher does not preserve the selected scene");
    results.push({ name: "Stash navigation launcher preserves selected scene", passed: true });
    await page.goto(options.baseURL + "/plugin/stash-tv/assets/index.html?autoplay=false&scene=" + scene.id + "&seed=1");
    await ready();
    assert(await page.locator('#volume-panel').isHidden(), 'Desktop volume should start collapsed');
    await page.locator('#mute').click();
    assert(await page.locator('#volume-panel').isVisible(), 'Desktop volume button did not open controls');
    await page.locator('#volume').focus();
    await page.keyboard.press('ArrowLeft');
    assert(await page.evaluate(() => document.querySelector('#video').volume < 1), 'Desktop volume adjustment failed');
    await page.keyboard.press('Escape');
    assert(await page.locator('#volume-panel').isHidden(), 'Escape did not close volume controls');
    results.push({name:'desktop volume button and keyboard adjustment',passed:true});
    assert(await page.locator("#delete").isHidden(), "Deletion must be disabled by default");
    results.push({ name: "permanent deletion disabled by default", passed: true });
    assert(await page.locator('#seek-markers').isHidden(), 'Unmarked scene shows marker controls');
    const tag = await api('mutation($input:TagCreateInput!){tagCreate(input:$input){id}}', {
      input: { name: 'Marker fixture ' + options.browser },
    });
    const markerIds = [];
    for (const marker of [
      { title: '<b>Chapter cue</b>', seconds: 6 },
      { title: 'Dialogue', seconds: 14, end_seconds: 24 },
      { title: 'Close-up', seconds: 20, end_seconds: 30 },
    ]) {
      const added = await api('mutation($input:SceneMarkerCreateInput!){sceneMarkerCreate(input:$input){id}}', {
        input: { ...marker, scene_id: scene.id, primary_tag_id: tag.tagCreate.id },
      });
      markerIds.push(added.sceneMarkerCreate.id);
    }
    await page.reload();
    await ready();
    assert(await page.locator('.marker-tick').count() === 3, 'Real Stash markers missing');
    assert(await page.locator('.marker-range').count() === 2, 'Start-only marker became a range');
    const markerButton = (index) => page.locator('[data-marker-id="' + markerIds[index] + '"]');
    const hoverTime = async (seconds, expected) => {
      const p = await point(seconds);
      await page.mouse.move(p.x, p.y);
      await page.waitForFunction(text => document.getElementById('preview-marker').textContent === text, expected);
    };
    await hoverTime(22, 'Dialogue · Close-up');
    assert((await sample()).paused && (await sample()).time < 1, 'Preview hover changed playback');
    await hoverTime(8, '');
    assert(await page.locator('#preview-marker').isHidden(), 'Point marker implied a duration');
    await markerButton(0).hover();
    await page.waitForFunction(() => document.getElementById('preview-marker').textContent === '<b>Chapter cue</b>');
    assert(await page.locator('#preview-marker b').count() === 0, 'Marker title was parsed as HTML');
    await markerButton(0).click();
    await ready();
    await page.waitForTimeout(2000);
    assert((await sample()).paused && Math.abs((await sample()).time - 6) < 0.5, 'Point marker click lost paused state');
    await markerButton(1).focus();
    await page.keyboard.press('Enter');
    await ready();
    assert((await sample()).paused && Math.abs((await sample()).time - 14) < 0.5, 'Focused marker did not seek');
    assert(!await page.evaluate(() => !!document.fullscreenElement), 'Marker Enter entered fullscreen');
    await page.locator('#surface').click({ position: { x: 300, y: 200 } });
    await markerButton(2).click();
    await ready();
    await continues('marker click preserves playing state', 6000);
    await page.locator('#surface').click({ position: { x: 300, y: 200 } });
    await seek(16);
    await hoverTime(22, 'Dialogue · Close-up');
    await page.screenshot({ path: options.reportDir + '/' + options.browser + '-markers.png' });
    results.push({ name: 'real marker ranges, overlaps, point labels, safe text and keyboard activation', passed: true });
    for (const width of [640, 1920, 1280]) {
      await page.setViewportSize({ width, height: 720 });
      await page.waitForTimeout(100);
      const rail = await page.locator('#seek').boundingBox();
      const tick = await markerButton(1).boundingBox();
      const expected = rail.x + 6 + (rail.width - 12) * 14 / scene.files[0].duration;
      assert(Math.abs(tick.x + tick.width / 2 - expected) < 1, 'Marker drifted on resize');
    }
    results.push({ name: 'marker alignment across viewport sizes', passed: true });

    await page.route(scene.paths.vtt, route => route.abort());
    await page.reload();
    await ready();
    await hoverTime(18, 'Dialogue');
    await page.waitForTimeout(300);
    assert(await page.locator('#seek-preview').isVisible() && await page.locator('#preview-frame').isHidden(),
      'Missing sprites hid marker labels');
    await page.unroute(scene.paths.vtt);
    await page.reload();
    await ready();
    results.push({ name: 'marker labels without sprite images', passed: true });
    await seek(0);
    await page.locator("#surface").click({ position: { x: 300, y: 200 } });
    await continues("unmuted original playback", 8000);
    const volume = () =>
      page.evaluate(() => ({
        actual: document.getElementById("video").volume,
        muted: document.getElementById("video").muted,
        slider: Number(document.getElementById("volume").value),
        label: document.getElementById("mute").getAttribute("aria-label"),
      }));
    await page.mouse.move(200, 100);
    const volumeBox = await page.locator("#volume").boundingBox();
    await page.mouse.click(volumeBox.x + volumeBox.width / 2, volumeBox.y + volumeBox.height / 2);
    const initialVolume = await volume();
    assert(
      Math.abs(initialVolume.actual - 0.5) < 0.06 && !initialVolume.muted,
      "Volume slider did not change audio",
    );
    await page.locator("#mute").click();
    await page.waitForFunction(() => document.getElementById("volume").value === "0");
    assert(
      (await volume()).muted && (await volume()).label === "Unmute",
      "Mute UI disagrees with audio",
    );
    await page.locator("#mute").click();
    await page.waitForFunction(
      () => document.getElementById("mute").getAttribute("aria-label") === "Mute",
    );
    assert(
      (await volume()).actual === initialVolume.actual && !(await volume()).muted,
      "Unmute lost prior volume",
    );
    results.push({ name: "volume slider and mute restore", passed: true });
    await page.keyboard.press("s");
    await page.waitForFunction(
      () =>
        Number(document.getElementById("volume").value) ===
        Math.round(document.getElementById("video").volume * 100),
    );
    assert(
      Math.abs((await volume()).actual - initialVolume.actual + 0.05) < 0.001,
      "S did not lower volume",
    );
    await page.keyboard.press("w");
    await page.waitForFunction(
      () =>
        Number(document.getElementById("volume").value) ===
        Math.round(document.getElementById("video").volume * 100),
    );
    assert(
      Math.abs((await volume()).actual - initialVolume.actual) < 0.001,
      "W did not restore volume",
    );
    results.push({ name: "volume shortcuts update slider", passed: true });
    await page.locator("#volume").focus();
    const beforeVolumeKeys = await sample();
    await page.keyboard.press("Home");
    await page.waitForFunction(() => document.getElementById("video").muted);
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => !document.getElementById("video").muted);
    const afterVolumeKeys = await sample();
    assert(Math.abs((await volume()).actual - 0.05) < 0.001, "Volume arrow failed to unmute at 5%");
    assert(
      Math.abs(afterVolumeKeys.time - beforeVolumeKeys.time) < 2 && !afterVolumeKeys.paused,
      "Volume keys sought or paused video",
    );
    await page.locator("#mute").focus();
    await page.keyboard.press("Space");
    await page.waitForFunction(() => document.getElementById("video").muted);
    assert(!(await sample()).paused, "Mute button Space paused video");
    await page.keyboard.press("Space");
    await page.waitForFunction(() => !document.getElementById("video").muted);
    await page.locator("#volume").focus();
    await page.keyboard.press("End");
    await page.waitForFunction(() => document.getElementById("video").volume === 1);
    await page.locator("#surface").focus();
    results.push({ name: "volume keyboard focus preserves playback", passed: true });

    for (const [key, delta] of [
      ["d", 10],
      ["a", -10],
      ["ArrowRight", 10],
      ["ArrowLeft", -10],
    ]) {
      await seek(20);
      const before = await sample();
      await page.keyboard.press(key);
      await page.waitForTimeout(350);
      await ready();
      const after = await sample();
      assert(Math.abs(after.time - before.time - delta) < 1.5, key + " has wrong seek delta");
      await continues(key + " after preview hides");
    }
    for (let digit = 0; digit <= 9; digit++) {
      await page.keyboard.press(String(digit));
      await page.waitForTimeout(250);
      await ready();
      const actual = await sample();
      const expected = (scene.files[0].duration * digit) / 10;
      assert(
        Math.abs(actual.time - expected) < 1.5 && !actual.paused,
        "Number key missed percentage: " + JSON.stringify({ digit, expected, actual }),
      );
    }
    results.push({ name: "all number keys seek to percentage while playing", passed: true });
    await seek(15);
    await page.keyboard.down("d");
    await page.keyboard.down("d");
    await page.keyboard.up("d");
    await page.waitForTimeout(350);
    assert(Math.abs((await sample()).time - 35) < 1.5, "Held key lost seek steps");
    await continues("held key", 4000);
    await seek(10);
    const from = await point(10);
    const to = await point(25);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 10 });
    await page.waitForTimeout(1500);
    assert((await sample()).time < 15, "Dragging sought before release");
    await page.mouse.up();
    await page.mouse.move(200, 100);
    await continues("drag release", 6000);
    await page.keyboard.press("Enter");
    assert(
      await page.evaluate(() => !!document.fullscreenElement || !!document.webkitFullscreenElement),
      "Enter did not enter fullscreen",
    );
    await seek(15);
    await continues("fullscreen seeking", 8000);
    await page.evaluate(() => document.exitFullscreen());
    await page.locator("#surface").click({ position: { x: 300, y: 200 } });
    await seek(20);
    await page.keyboard.press("a");
    await page.waitForTimeout(2000);
    assert((await sample()).paused, "Paused seeking resumed playback");
    results.push({ name: "paused seeking", passed: true });
    await page.keyboard.press("5");
    await ready();
    assert(
      (await sample()).paused &&
        Math.abs((await sample()).time - scene.files[0].duration / 2) < 0.5,
      "Percentage seek resumed paused playback",
    );
    results.push({ name: "percentage seek preserves pause", passed: true });

    for (const label of ["MP4 Low (240p)", "WEBM Low (240p)"]) {
      const available = await page
        .locator("#source")
        .evaluate(
          (select, text) => [...select.options].some((option) => option.textContent === text),
          label,
        );
      assert(available, "Missing Stash transcode option: " + label);
      await seek(10);
      await page.locator("#source").selectOption({ label }, { force: true });
      await ready();
      if ((await sample()).paused)
        await page.locator("#surface").click({ position: { x: 300, y: 200 } });
      await continues(label + " selection and playback", 4000);
      await page.mouse.move(200, 100);
      await markerButton(1).click();
      await ready();
      assert(Math.abs((await sample()).time - 14) < 1.5, 'Converted marker seek lost absolute timestamp');
      await continues(label + ' marker seek', 4000);
      await page.locator('#surface').click({ position: { x: 300, y: 200 } });
      await markerButton(2).click();
      await ready();
      await page.waitForTimeout(2000);
      assert((await sample()).paused && Math.abs((await sample()).time - 20) < 0.5,
        'Converted marker seek resumed paused playback');
      await page.locator('#surface').click({ position: { x: 300, y: 200 } });
      for (const key of ["d", "a"]) {
        await seek(20);
        await page.keyboard.press(key);
        await page.waitForTimeout(500);
        await ready();
        await continues(label + " " + key, 4000);
      }
      await seek(15);
      for (const key of ["d", "a", "ArrowRight", "ArrowLeft"]) {
        await page.keyboard.press(key);
        await page.waitForTimeout(250);
      }
      await ready();
      await continues(label + " overlapping seeks", 6000);
      await page.keyboard.press("5");
      await ready();
      assert(
        Math.abs((await sample()).time - scene.files[0].duration / 2) < 1.5,
        "Converted percentage seek missed target",
      );
      await continues(label + " percentage seek", 3000);

      const end = await point(scene.files[0].duration);
      await page.mouse.click(end.x, end.y);
      await page.waitForTimeout(3000);
      const atEnd = await sample();
      assert(
        atEnd.time >= scene.files[0].duration - 0.3 &&
          !atEnd.error &&
          atEnd.phase !== "error" &&
          atEnd.phase !== "loading",
        "End seek requested an empty transcode: " + JSON.stringify(atEnd),
      );
      results.push({ name: label + " end boundary", passed: true, actual: atEnd });
      await seek(10);
      await ready();
    }
    assert(errors.length === 0, "Browser errors: " + JSON.stringify(errors));
    for (const id of markerIds)
      await api('mutation($id:ID!){sceneMarkerDestroy(id:$id)}', { id });
    await page.reload();
    await ready();
    assert(await page.locator('#seek-markers').isHidden() && await page.locator('.marker-tick').count() === 0,
      'Removed markers remain on the timeline');
    results.push({ name: 'removed markers disappear after reload', passed: true });
    await page.screenshot({ path: options.reportDir + "/" + options.browser + ".png" });
    return {
      passed: true,
      browser: options.browser,
      results,
      events: await page.evaluate(() => window.tvMediaEvents),
    };
  } catch (error) {
    await page.screenshot({ path: options.reportDir + "/" + options.browser + "-failure.png" });
    return {
      passed: false,
      browser: options.browser,
      error: error.message,
      results,
      events: await page.evaluate(() => window.tvMediaEvents),
      errors,
    };
  }
}
