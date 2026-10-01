export default async function verifyMultiview(page, options) {
  const results = [], errors = [], modules = [];
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (request.url().includes("/multiview.js")) modules.push(request.url()); });
  await page.setViewportSize({ width: 1200, height: 800 });
  const api = async (query, variables = {}) => {
    const response = await page.request.post(options.baseURL + "/graphql", { data: { query, variables } });
    const body = await response.json();
    check(response.ok() && !body.errors, JSON.stringify(body));
    return body.data;
  };
  const click = async selector => {
    if (["#layout-two", "#layout-four", "#fullscreen", ".multiview-toggle"].includes(selector))
      await page.waitForFunction(() => (document.getElementById("player").dataset.layout || "1") === "1" || document.querySelector(".multiview-menu-toggle"));
    await page.mouse.move(10, 10);
    if (["#layout-two", "#layout-four", "#fullscreen", ".multiview-toggle"].includes(selector) &&
        await page.locator(".multiview-menu-toggle").count() &&
        await page.locator(".multiview-menu").evaluate(panel => panel.hidden)) {
      await page.locator(".multiview-menu-toggle").click();
    }
    await page.locator(selector).click();
  };
  const tile = index => page.locator("#views > .view").nth(index);
  const tileClick = async (index, action) => {
    await tile(index).locator(".tile-surface").hover({ position: { x: 20, y: 20 } });
    const target = tile(index).locator(".tile-" + action);
    if (["previous", "next", "random"].includes(action) && !await target.isVisible())
      await tile(index).locator(".tile-more").click();
    await target.click();
  };
  const ready = count => page.waitForFunction(count => {
    const videos = [...document.querySelectorAll("#views video")];
    return videos.length === count && videos.every(video => !video.paused && !video.seeking &&
      video.readyState >= 2 && video.videoWidth > 0) &&
      [...document.querySelectorAll(".extra-view")].every(view => view.dataset.decoded === "true");
  }, count);
  const sample = () => page.evaluate(() => [...document.querySelectorAll("#views video")].map((video, index) => ({
    id: index ? video.parentElement.dataset.scene : new URL(location.href).searchParams.get("scene"),
    time: video.currentTime, paused: video.paused, muted: video.muted,
    seeking: video.seeking, frames: video.getVideoPlaybackQuality?.().totalVideoFrames || 0,
    ready: video.readyState, error: video.error?.code || null,
    source: video.currentSrc.startsWith("blob:") ? "buffered" : "network",
    phase: video.parentElement.dataset.tilePhase,
  })));
  const progressing = async count => {
    await ready(count);
    const before = await sample();
    try {
      await page.waitForFunction(before => {
        const videos = [...document.querySelectorAll("#views video")];
        return videos.length === before.length && videos.every((video, index) => {
          const id = index ? video.parentElement.dataset.scene : new URL(location.href).searchParams.get("scene");
          return id === before[index].id && !video.paused && !video.seeking && video.currentTime > before[index].time + 0.25;
        });
      }, before, {timeout:5000});
    } catch {
      throw new Error("Videos did not advance within five seconds: " + JSON.stringify({before,after:await sample()}));
    }
    const after = await sample();
    check(after.length === count && after.every((video, index) => video.id === before[index].id && video.time > before[index].time + 0.25),
      "Videos did not advance together: " + JSON.stringify({ before, after }));
    check(new Set(after.map(video => video.id)).size === count, "Duplicate multiview scene");
    check(after.slice(1).every(video => video.muted), "Extra soundtracks were not muted");
    return after;
  };
  const layout = async count => {
    const value = await page.evaluate(() => {
      const root = document.getElementById("views");
      const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
      return { root: rect(root), gap: getComputedStyle(root).gap,
        views: [...root.children].map(view => ({ ...rect(view), border: getComputedStyle(view).borderWidth,
          fit: getComputedStyle(view.querySelector("video")).objectFit })),
        icons: [...document.querySelectorAll(".tile-controls .icon, .multiview-toolbar .icon")].filter(node => node.getClientRects().length).map(node => {
          const style = getComputedStyle(node); return {width: parseFloat(style.width), height: parseFloat(style.height)};
        }),
        footers: [...root.querySelectorAll(".tile-controls")].filter(node => node.getClientRects().length).length,
        iconCounts: [...document.querySelectorAll(".tile-nav button")].filter(node => node.getClientRects().length).map(button => [...button.querySelectorAll(".icon")].filter(icon => getComputedStyle(icon).display !== "none").length) };
    });
    const area = value.views.reduce((total, view) => total + view.width * view.height, 0);
    check(value.views.length === count && Math.abs(area - value.root.width * value.root.height) < 1 && value.gap === "0px",
      "Grid has gaps: " + JSON.stringify(value));
    check(value.views.every(view => view.border === "0px" && view.fit === "cover"), "Tiles have borders or letterboxing");
    check(value.footers === 1 && value.iconCounts.length === 4, "More than one tile control strip is visible");
    check(value.icons.every(icon => icon.width === 24 && icon.height === 24) && value.iconCounts.every(count => count === 1),
      "Icon sizes or states changed: " + JSON.stringify({icons:value.icons,counts:value.iconCounts}));
    return value;
  };
  try {
    const { findScenes } = await api('{findScenes(filter:{sort:"random_17",direction:DESC,per_page:-1}){scenes{id files{path}}}}');
    check(findScenes.scenes.length === 5 && findScenes.scenes.every(scene => scene.files[0].path.startsWith("/media/sintel")), "Expected five isolated Sintel fixtures");
    const ids = findScenes.scenes.map(scene => scene.id);
    for (const id of ids) await api("mutation($id:ID!){sceneSaveActivity(id:$id,resume_time:3,playDuration:0)}", { id });
    await page.goto(options.baseURL + "/plugin/stash-tv/assets/index.html?autoplay=false&scene=" + ids[0] + "&seed=17");
    await page.waitForFunction(() => document.getElementById("player").dataset.videoReady === "true");
    check(modules.length === 0 && (await sample()).length === 1, "Single playback loaded multiview resources");
    results.push({ name: "single playback does not load extra videos or the multiview module", passed: true });

    await click("#layout-two");
    const two = await progressing(2);
    const landscape = await layout(2);
    check(landscape.views[0].right === landscape.views[1].x && landscape.views[0].y === landscape.views[1].y, "Two landscape videos are not edge-to-edge");
    check((await page.locator("#layout-two").getAttribute("aria-pressed")) === "true", "Two-view toggle not selected");
    results.push({ name: "two distinct scenes resume and play simultaneously in a seamless landscape split", passed: true, videos: two });

    await click("#layout-four");
    const four = await progressing(4);
    const grid = await layout(4);
    check(four[0].id === two[0].id && four[1].id === two[1].id, "Expanding the layout restarted existing tiles");
    check(grid.views[0].right === grid.views[1].x && grid.views[0].bottom === grid.views[2].y && grid.views[2].right === grid.views[3].x, "Four videos are not in a seamless 2x2 grid");
    await page.screenshot({ path: options.reportDir + "/" + options.browser + "-multiview-four.png" });
    results.push({ name: "four distinct scenes decode and advance together without restarting the first two", passed: true, videos: four });

    await tile(2).locator(".tile-surface").hover({position:{x:20,y:20}});
    const selected = await page.evaluate(() => [...document.querySelectorAll("#views > .view")].map(node => ({
      selected: node.dataset.selected, visible: getComputedStyle(node.querySelector(".tile-controls")).display !== "none",
    })));
    check(selected.every((view, index) => view.selected === String(index === 2) && view.visible === (index === 2)),
      "Hovering a video left duplicated overlays: " + JSON.stringify(selected));
    check((await sample()).every((video, index) => video.muted === four[index].muted), "Hovering changed the audio source");
    await page.waitForFunction(() => document.getElementById("player").dataset.gridControls === "false" &&
      document.querySelector('.view[data-selected="true"]').dataset.controls === "false");
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".multiview-toolbar")).opacity === "0" &&
      getComputedStyle(document.querySelector('.view[data-selected="true"] .tile-controls')).opacity === "0");
    results.push({ name: "only the hovered video shows four main controls and all overlays hide while idle without switching audio", passed: true });

    await tile(1).locator(".tile-surface").hover({position:{x:20,y:20}});
    await tile(1).locator(".tile-more").click();
    check(await tile(1).locator(".tile-more-panel").isVisible(), "Navigation menu did not open");
    await tile(1).locator(".tile-audio").click();
    check(!await tile(1).locator(".tile-more-panel").isVisible() && await tile(1).locator(".tile-volume-panel").isVisible(),
      "More and volume panels overlap");
    await tile(1).locator(".tile-audio").click();
    await tileClick(0, "audio");
    await tileClick(0, "audio");
    await click(".multiview-menu-toggle");
    await page.waitForTimeout(2500);
    check(await page.locator(".multiview-menu").isVisible() && await page.locator(".multiview-toolbar").evaluate(node => getComputedStyle(node).opacity === "1"),
      "Open grid menu disappeared while reading its controls");
    await page.keyboard.press("Escape");
    check(!await page.locator(".multiview-menu").isVisible(), "Escape did not dismiss the grid menu");
    results.push({ name: "navigation, volume and grid options are disclosed on demand and open menus remain usable", passed: true });

    await click(".multiview-toggle");
    await page.waitForFunction(() => [...document.querySelectorAll("#views video")].every(video => video.paused));
    const paused = await sample();
    await page.waitForTimeout(400);
    const still = await sample();
    check(still.every((video, index) => Math.abs(video.time - paused[index].time) < 0.1), "Shared pause left a tile playing");
    await page.locator("#primary-view .tile-seek").evaluate(range => { range.value = "15"; range.dispatchEvent(new Event("change", { bubbles: true })); });
    await page.waitForFunction(() => !document.getElementById("video").seeking && Math.abs(document.getElementById("video").currentTime - 15) < 0.2);
    check((await sample()).every(video => video.paused), "Seeking the primary resumed an auxiliary tile");
    await click(".multiview-toggle");
    await progressing(4);
    results.push({ name: "explicit group pause and resume affect every tile; independent seeking does not resume paused tiles", passed: true });

    await tileClick(0, "random");
    const shuffled = await progressing(4);
    check(shuffled[0].id !== four[0].id, "Random did not change the primary scene");
    results.push({ name: "primary Random changes only its own tile and preserves distinct scene IDs", passed: true, videos: shuffled });

    await tileClick(0, "previous");
    const previous = await progressing(4);
    check(previous[0].id === four[0].id, "Previous did not return through shuffled history");
    await tileClick(0, "next");
    const navigated = await progressing(4);
    check(navigated[0].id === shuffled[0].id, "Next did not return to the shuffled primary scene");
    results.push({ name: "primary navigation preserves shuffled history and replaces colliding auxiliary scenes", passed: true });

    for (let index = 0; index < 4; index++) {
      const before = await sample();
      await tileClick(index, "toggle");
      await page.waitForTimeout(350);
      const after = await sample();
      check(after[index].paused && after.every((video, other) => other === index || !video.paused && video.time > before[other].time),
        "Tile pause affected a different video: " + JSON.stringify({ index, before, after }));
      await tileClick(index, "toggle");
      await progressing(4);
    }
    results.push({ name: "each of the four play/pause buttons affects only its own real video", passed: true });

    await click(".multiview-toggle");
    await page.waitForFunction(() => [...document.querySelectorAll("#views video")].every(video => video.paused));
    for (let index = 0; index < 4; index++) {
      for (const percent of [0.3, 0.6, 0.15]) {
        const before = await sample();
        const range = tile(index).locator(".tile-seek");
        await tile(index).locator(".tile-surface").hover({ position: { x: 20, y: 20 } });
        const box = await range.boundingBox();
        await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * percent, box.y + box.height / 2, { steps: 6 });
        await page.mouse.up();
        const target = await range.evaluate((input, percent) => Number(input.max) * percent, percent);
        await page.waitForFunction(({ index, target }) => {
          const video = document.querySelectorAll("#views video")[index];
          return !video.seeking && Math.abs(video.currentTime - target) < 0.5;
        }, { index, target });
        const after = await sample();
        check(after.every((video, other) => video.paused && (other === index || Math.abs(video.time - before[other].time) < 0.1)),
          "Dragging one seek bar changed another video or resumed playback");
      }
    }
    results.push({ name: "three consecutive real pointer drags on each timeline seek independently and preserve pause", passed: true });
    const keyboardBefore = await sample();
    await tile(2).locator(".tile-surface").focus();
    await page.keyboard.press("d");
    await page.waitForFunction(time => Math.abs(document.querySelectorAll("#views video")[2].currentTime - time - 10) < 0.5, keyboardBefore[2].time);
    await page.keyboard.press("a");
    await page.waitForFunction(time => Math.abs(document.querySelectorAll("#views video")[2].currentTime - time) < 0.5, keyboardBefore[2].time);
    const keyboardAfter = await sample();
    check(keyboardAfter.every((video, index) => video.paused && Math.abs(video.time - keyboardBefore[index].time) < 0.5), "Keyboard seeking affected another tile");
    await page.keyboard.press("Space");
    await page.waitForTimeout(200);
    check((await sample()).every((video, index) => video.paused === (index !== 2)), "Keyboard pause/play did not target focused tile");
    await page.keyboard.press("Space");
    results.push({ name: "keyboard seek and pause/play follow the focused tile without leaking to the primary", passed: true });

    await tileClick(2, "audio");
    await tile(2).locator(".tile-volume").evaluate(input => { input.value = "0.4"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    const audio = await page.evaluate(() => [...document.querySelectorAll("#views video")].map(video => ({ muted: video.muted, volume: video.volume })));
    check(audio[2].muted === false && Math.abs(audio[2].volume - 0.4) < 0.01 && audio.every((v, i) => i === 2 || v.muted), "Audio selection did not follow the third tile");
    await tileClick(2, "audio");
    await tileClick(0, "audio");
    await tileClick(0, "audio");
    results.push({ name: "tile volume buttons select one audio source and adjust that video's volume", passed: true });

    await tileClick(3, "fullscreen");
    const full = await page.evaluate(() => (document.fullscreenElement || document.webkitFullscreenElement)?.classList.contains("extra-view"));
    if (full) {
      await tileClick(3, "fullscreen");
      await page.waitForFunction(() => !document.fullscreenElement && !document.webkitFullscreenElement);
      check((await sample()).length === 4, "Exiting tile fullscreen lost the grid");
      results.push({ name: "a selected auxiliary video enters and exits real fullscreen without losing the grid", passed: true });
    } else {
      await tile(3).locator("video").evaluate(video => { video.webkitEnterFullscreen = () => { video.dataset.nativeFullscreenRequested = "true"; }; });
      await tileClick(3, "fullscreen");
      check(await tile(3).locator("video").getAttribute("data-native-fullscreen-requested") === "true", "Native fullscreen fallback targeted the wrong video");
      results.push({ name: "native-only fullscreen fallback calls the selected video's WebKit API", passed: true });
    }
    await click(".multiview-toggle");
    await progressing(4);
    const beforeRandom = await sample();
    await tileClick(1, "random");
    await progressing(4);
    const afterRandom = await sample();
    check(afterRandom[1].id !== beforeRandom[1].id && afterRandom.every((video, index) => index === 1 || video.id === beforeRandom[index].id), "Random changed another tile");
    await tileClick(1, "previous");
    await progressing(4);
    check((await sample())[1].id === beforeRandom[1].id, "Auxiliary Previous lost its own random history");
    await tileClick(1, "next");
    await progressing(4);
    check((await sample())[1].id === afterRandom[1].id, "Auxiliary Next lost its own random history");
    results.push({ name: "auxiliary Random, Previous and Next have independent playback history", passed: true });

    const ending = (await sample())[1].id;
    await page.locator(".extra-view video").first().evaluate(video => { video.currentTime = Math.max(0, video.duration - 0.1); });
    await page.waitForFunction(id => document.querySelector(".extra-view").dataset.scene !== id, ending);
    await progressing(4);
    results.push({ name: "an ended auxiliary feed replaces itself with another distinct random scene", passed: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await layout(4);
    await page.setViewportSize({width:320,height:844});
    await tile(3).locator(".tile-surface").hover({position:{x:20,y:20}});
    const narrow = await page.evaluate(() => [...document.querySelectorAll('.view[data-selected="true"] .tile-nav button')].map(button => {
      const b = button.getBoundingClientRect(), r = button.closest(".view").getBoundingClientRect();
      return {inside:b.x >= r.x && b.right <= r.right && b.y >= r.y && b.bottom <= r.bottom,width:b.width,height:b.height};
    }));
    check(narrow.length === 4 && narrow.every(button => button.inside && button.width === 44 && button.height === 44),
      "Selected controls overflow a narrow four-video portrait grid");
    await click("#layout-two");
    await progressing(2);
    const portrait = await layout(2);
    check(portrait.views[0].bottom === portrait.views[1].y && portrait.views[0].x === portrait.views[1].x, "Two portrait videos do not stack seamlessly");
    for (const width of [320, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      const controls = await page.evaluate(() => [...document.querySelectorAll(".tile-controls .tile-nav > button,.multiview-toolbar > button")].filter(node => node.getClientRects().length).map(node => {
        const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
      }));
      check(controls.every(rect => rect.x >= 0 && rect.right <= width && rect.bottom <= 844), "Portrait toolbar overflow");
      check(controls.every((rect, index) => controls.every((other, j) => index === j || rect.right <= other.x || other.right <= rect.x || rect.bottom <= other.y || other.bottom <= rect.y)), "Portrait controls overlap");
    }
    await page.screenshot({ path: options.reportDir + "/" + options.browser + "-multiview-portrait.png" });
    results.push({ name: "portrait grid and toolbar fit 320, 390 and 430 pixel screens with unchanged icons", passed: true });

    await page.evaluate(() => { window.retired = [...document.querySelectorAll(".extra-view video")]; });
    const retired = (await sample())[1];
    await tileClick(1, "audio");
    check((await sample())[0].muted && !(await sample())[1].muted, "Audio did not select the departing feed");
    await click("#layout-two");
    await page.waitForFunction(() => document.querySelectorAll("#views video").length === 1 && window.retired.every(video => video.paused && !video.getAttribute("src") && video.readyState === 0));
    check((await page.locator("#layout-two").getAttribute("aria-pressed")) === "false", "Active layout did not toggle back to single");
    check(!(await sample())[0].muted, "Removing the selected audio feed left single playback silent");
    results.push({ name: "returning to single unloads auxiliary decoders and streams", passed: true });
    let saved;
    for (let attempt = 0; attempt < 10; attempt++) {
      saved = await api("query($id:ID!){findScene(id:$id){resume_time play_count}}", { id: retired.id });
      if (saved.findScene.play_count > 0 && Math.abs(saved.findScene.resume_time - retired.time) < 1) break;
      await page.waitForTimeout(250);
    }
    check(saved.findScene.play_count > 0 && Math.abs(saved.findScene.resume_time - retired.time) < 1,
      "Auxiliary playback progress did not reach Stash: " + JSON.stringify({ retired, saved }));
    results.push({ name: "auxiliary playback count and saved position persist through the real Stash API", passed: true });

    await page.route("**/graphql", async route => {
      if (route.request().postData()?.includes("TVScene")) await page.waitForTimeout(250);
      await route.continue();
    });
    await page.reload();
    await page.waitForFunction(() => document.getElementById("player").dataset.videoReady === "true");
    await click("#layout-four");
    await click("#layout-two");
    await click("#layout-two");
    await page.waitForTimeout(600);
    check((await sample()).length === 1 && (await page.locator("#player").getAttribute("data-layout")) === "1", "Late metadata resurrected disposed tiles");
    results.push({ name: "rapid four/two/single switching cancels obsolete tile loads", passed: true });

    await page.unroute("**/graphql");
    await click("#layout-four");
    await progressing(4);
    await click("#layout-four");
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.locator("#seek").evaluate(range => { range.value = "10"; range.dispatchEvent(new Event("change", { bubbles: true })); });
    await page.waitForFunction(() => Math.abs(document.getElementById("video").currentTime - 10) < 0.5 && !document.getElementById("video").paused);
    results.push({ name: "single playback and seeking still work after repeated multiview use", passed: true });

    await page.locator("#layout-four").focus();
    await page.keyboard.press("Space");
    await progressing(4);
    await click(".multiview-menu-toggle");
    await page.locator("#layout-four").focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll("#views video").length === 1);
    results.push({ name: "layout buttons respond to keyboard activation", passed: true });

    await page.goto("about:blank");
    for (const id of ids) await api("mutation($id:ID!){sceneSaveActivity(id:$id,resume_time:3,playDuration:0)}", {id});
    const mobile = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const desktop = page;
    try {
      page = await mobile.newPage();
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(options.baseURL + "/plugin/stash-tv/assets/index.html?autoplay=false&scene=" + ids[0] + "&seed=17");
      await page.waitForFunction(() => document.getElementById("player").dataset.videoReady === "true");
      await page.locator("#layout-four").tap();
      await progressing(4);
      await layout(4);
      for (let index = 0; index < 4; index++) {
        const view = page.locator("#views > .view").nth(index);
        await view.locator(".tile-surface").tap();
        const paused = await sample();
        check(paused[index].paused && paused.every((video, other) => other === index || !video.paused), "Touch surface paused another tile");
        for (const percent of [0.25, 0.65]) {
          const box = await view.locator(".tile-seek").boundingBox();
          await page.touchscreen.tap(box.x + box.width * percent, box.y + box.height / 2);
          const target = await view.locator(".tile-seek").evaluate((input, percent) => Number(input.max) * percent, percent);
          await page.waitForFunction(({index,target}) => Math.abs(document.querySelectorAll("#views video")[index].currentTime - target) < 0.5, {index,target});
          check((await sample())[index].paused, "Touch seeking resumed a paused tile");
        }
        await view.locator(".tile-toggle").tap();
        await progressing(4);
      }
      const bounds = await page.evaluate(() => [...document.querySelectorAll(".tile-nav button")].filter(button => button.getClientRects().length).map(button => {
        const b = button.getBoundingClientRect(), r = button.closest(".view").getBoundingClientRect();
        return { inside: b.x >= r.x && b.right <= r.right && b.y >= r.y && b.bottom <= r.bottom,
          icons: [...button.querySelectorAll(".icon")].filter(icon => getComputedStyle(icon).display !== "none").map(icon => parseFloat(getComputedStyle(icon).width)) };
      }));
      check(bounds.length === 4 && bounds.every(b => b.inside && b.icons.length === 1 && b.icons[0] === 24), "Portrait tile buttons or icons overlap their video");
      await page.screenshot({ path: options.reportDir + "/" + options.browser + "-multiview-mobile-controls.png" });
      results.push({ name: "portrait touch surfaces, repeated seeking and playback controls work independently on all four videos", passed: true });
      await page.locator(".multiview-menu-toggle").tap();
      await page.locator("#layout-four").tap();
      await page.waitForFunction(() => document.querySelectorAll("#views video").length === 1);
      results.push({ name: "touch buttons start and exit four simultaneous videos in a portrait mobile browser", passed: true });
    } catch (error) {
      throw new Error("Mobile multiview: " + error.message + "; " + JSON.stringify({videos:await sample(),player:await page.locator("#player").evaluate(node => ({...node.dataset}))}));
    } finally { page = desktop; await mobile.close(); }
    for (const id of ids) await api("mutation($id:ID!){sceneSaveActivity(id:$id,resume_time:3,playDuration:0)}", {id});
    const native = await page.context().browser().newContext({viewport:{width:1200,height:800},serviceWorkers:"block"});
    try {
      page = await native.newPage();
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(options.baseURL + "/plugin/stash-tv/assets/index.html?autoplay=false&scene=" + ids[0] + "&seed=17");
      await page.waitForFunction(() => document.getElementById("player").dataset.videoReady === "true");
      await click("#layout-four");
      await ready(4);
      await click(".multiview-toggle");
      await page.waitForFunction(() => [...document.querySelectorAll("#views video")].every(video => video.paused));
      let failures = 0;
      await page.route("**/scene/*/stream*", route => {
        failures++;
        return route.fulfill({ status: 503, body: "Temporary fixture stream failure" });
      });
      await page.locator("#views > .view").nth(1).locator("video").evaluate(video => video.load());
      await page.waitForFunction(() => document.querySelectorAll("#views > .view")[1].dataset.tilePhase === "error");
      check(failures > 0, "The stream fault did not reach the network");
      await page.unroute("**/scene/*/stream*");
      await tileClick(1, "toggle");
      await page.waitForFunction(() => {
        const videos = [...document.querySelectorAll("#views video")];
        return videos[1].readyState >= 2 && !videos[1].paused && !videos[1].seeking &&
          videos.every((video, index) => index === 1 || video.paused);
      });
      results.push({ name: "a failed real native stream retries from its own playback button without resuming the other videos", passed: true });
    } finally { page = desktop; await native.close(); }
    check(errors.length === 0, errors.join("; "));
    return { passed: true, browser: options.browser, results, errors };
  } catch (error) {
    await page.screenshot({ path: options.reportDir + "/" + options.browser + "-multiview-failure.png" });
    return { passed: false, browser: options.browser, error: error.message, results, errors, videos: await sample() };
  }
}
