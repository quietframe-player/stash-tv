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
    await page.mouse.move(10, 10);
    await page.locator(selector).click();
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
  })));
  const progressing = async count => {
    await ready(count);
    const before = await sample();
    await page.waitForTimeout(700);
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
        icons: [...document.querySelectorAll("nav .icon")].filter(node => node.getClientRects().length).map(node => node.getBoundingClientRect().width) };
    });
    const area = value.views.reduce((total, view) => total + view.width * view.height, 0);
    check(value.views.length === count && Math.abs(area - value.root.width * value.root.height) < 1 && value.gap === "0px",
      "Grid has gaps: " + JSON.stringify(value));
    check(value.views.every(view => view.border === "0px" && view.fit === "cover"), "Tiles have borders or letterboxing");
    check(value.icons.every(width => width === 24), "Icon sizes changed");
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

    await click("#toggle");
    await page.waitForFunction(() => [...document.querySelectorAll("#views video")].every(video => video.paused));
    const paused = await sample();
    await page.waitForTimeout(400);
    const still = await sample();
    check(still.every((video, index) => Math.abs(video.time - paused[index].time) < 0.1), "Shared pause left a tile playing");
    await page.locator("#seek").evaluate(range => { range.value = "15"; range.dispatchEvent(new Event("change", { bubbles: true })); });
    await page.waitForFunction(() => !document.getElementById("video").seeking && Math.abs(document.getElementById("video").currentTime - 15) < 0.2);
    check((await sample()).every(video => video.paused), "Seeking the primary resumed an auxiliary tile");
    await click("#surface");
    await progressing(4);
    results.push({ name: "shared pause and surface resume affect every tile; seeking stays on the primary video", passed: true });

    await click("#random");
    const shuffled = await progressing(4);
    check(shuffled[0].id !== four[0].id, "Random did not change the primary scene");
    results.push({ name: "Random refreshes the grid with distinct scene IDs", passed: true, videos: shuffled });

    await click("#previous");
    const previous = await progressing(4);
    check(previous[0].id === four[0].id, "Previous did not return through shuffled history");
    await click("#next");
    const navigated = await progressing(4);
    check(navigated[0].id === shuffled[0].id, "Next did not return to the shuffled primary scene");
    results.push({ name: "primary navigation preserves shuffled history and replaces colliding auxiliary scenes", passed: true });

    const ending = (await sample())[1].id;
    await page.locator(".extra-view video").first().evaluate(video => { video.currentTime = Math.max(0, video.duration - 0.1); });
    await page.waitForFunction(id => document.querySelector(".extra-view").dataset.scene !== id, ending);
    await progressing(4);
    results.push({ name: "an ended auxiliary feed replaces itself with another distinct random scene", passed: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await layout(4);
    await click("#layout-two");
    await progressing(2);
    const portrait = await layout(2);
    check(portrait.views[0].bottom === portrait.views[1].y && portrait.views[0].x === portrait.views[1].x, "Two portrait videos do not stack seamlessly");
    for (const width of [320, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      const controls = await page.evaluate(() => [...document.querySelectorAll("nav > button,nav > .volume-controls")].filter(node => node.getClientRects().length).map(node => {
        const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
      }));
      check(controls.every(rect => rect.x >= 0 && rect.right <= width && rect.bottom <= 844), "Portrait toolbar overflow");
      check(controls.every((rect, index) => controls.every((other, j) => index === j || rect.right <= other.x || other.right <= rect.x || rect.bottom <= other.y || other.bottom <= rect.y)), "Portrait controls overlap");
    }
    await page.screenshot({ path: options.reportDir + "/" + options.browser + "-multiview-portrait.png" });
    results.push({ name: "portrait grid and toolbar fit 320, 390 and 430 pixel screens with unchanged icons", passed: true });

    await page.evaluate(() => { window.retired = [...document.querySelectorAll(".extra-view video")]; });
    const retired = (await sample())[1];
    await click("#layout-two");
    await page.waitForFunction(() => document.querySelectorAll("#views video").length === 1 && window.retired.every(video => video.paused && !video.getAttribute("src") && video.readyState === 0));
    check((await page.locator("#layout-two").getAttribute("aria-pressed")) === "false", "Active layout did not toggle back to single");
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
    await page.locator("#layout-four").focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll("#views video").length === 1);
    results.push({ name: "layout buttons respond to keyboard activation", passed: true });

    const mobile = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const desktop = page;
    try {
      page = await mobile.newPage();
      await page.goto(options.baseURL + "/plugin/stash-tv/assets/index.html?autoplay=false&scene=" + ids[0] + "&seed=17");
      await page.waitForFunction(() => document.getElementById("player").dataset.videoReady === "true");
      await page.locator("#layout-four").tap();
      await progressing(4);
      await layout(4);
      await page.locator("#layout-four").tap();
      await page.waitForFunction(() => document.querySelectorAll("#views video").length === 1);
      results.push({ name: "touch buttons start and exit four simultaneous videos in a portrait mobile browser", passed: true });
    } finally { page = desktop; await mobile.close(); }
    check(errors.length === 0, errors.join("; "));
    return { passed: true, browser: options.browser, results, errors };
  } catch (error) {
    await page.screenshot({ path: options.reportDir + "/" + options.browser + "-multiview-failure.png" });
    return { passed: false, browser: options.browser, error: error.message, results, errors, videos: await sample() };
  }
}
