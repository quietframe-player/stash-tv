export function makeQueue(scenes, requestedId) {
  const ids = Array.from(
    new Set(
      scenes.map(function (scene) {
        return String(scene.id);
      }),
    ),
  ).filter(function (id) {
    return /^[1-9][0-9]*$/.test(id);
  });
  if (!ids.length) throw new Error("Your Stash library has no scenes.");
  return { ids: ids, index: Math.max(0, ids.indexOf(String(requestedId))) };
}

export function advanceQueue(queue, direction) {
  const index = queue.index + direction;
  if (index < 0 || index >= queue.ids.length) return null;
  return { ids: queue.ids, index: index };
}

export function removeCurrentScene(queue) {
  const current = queue.ids[queue.index];
  const before = queue.ids.slice(0, queue.index).filter((id) => id !== current);
  const after = queue.ids.slice(queue.index + 1).filter((id) => id !== current);
  const ids = before.concat(after);
  return ids.length ? { ids: ids, index: Math.min(before.length, ids.length - 1) } : null;
}

export function previewCues(text, base, origin) {
  const timestamp = function (value) {
    return value.split(":").reduce((seconds, part) => seconds * 60 + Number(part), 0);
  };
  const cues = [];
  for (const block of text.replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = block.trim().split("\n");
    const index = lines.findIndex((line) => line.includes(" --> "));
    if (index < 0 || !lines[index + 1]) continue;
    const timing = lines[index].match(
      /^((?:\d+:)?\d{2}:\d{2}\.\d{3}) --> ((?:\d+:)?\d{2}:\d{2}\.\d{3})(?:\s|$)/,
    );
    const frame = lines[index + 1].trim().match(/^(.+)#xywh=(\d+),(\d+),(\d+),(\d+)$/);
    if (!timing || !frame) continue;
    const start = timestamp(timing[1]);
    const end = timestamp(timing[2]);
    const [x, y, width, height] = frame.slice(2).map(Number);
    if (
      ![start, end, x, y, width, height].every(Number.isFinite) ||
      end <= start ||
      !width ||
      !height
    )
      continue;
    try {
      const url = new URL(frame[1], base);
      if (url.origin !== origin || !["http:", "https:"].includes(url.protocol)) continue;
      cues.push({ start, end, x, y, width, height, url: url.href });
    } catch {}
  }
  return cues.sort((a, b) => a.start - b.start);
}

export function previewAt(cues, seconds) {
  return (
    cues.find(
      (cue, index) => seconds >= cue.start && (seconds < cue.end || index === cues.length - 1),
    ) || null
  );
}

export function seekPosition(clientX, left, width, duration) {
  const fraction = Math.max(0, Math.min(1, (clientX - left - 6) / Math.max(1, width - 12)));
  return Math.round(fraction * duration * 10) / 10;
}

export function sceneMarkers(markers, duration) {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  return (markers || []).filter(function (marker) {
    return Number.isFinite(marker.seconds) && marker.seconds >= 0 && marker.seconds < duration;
  }).map(function (marker) {
    const end = Number.isFinite(marker.end_seconds) && marker.end_seconds > marker.seconds
      ? Math.min(marker.end_seconds, duration) : null;
    return {
      id: String(marker.id),
      start: marker.seconds,
      end: end,
      label: (marker.title || "").trim() || (marker.primary_tag || {}).name || "Marker",
    };
  }).sort((a, b) => a.start - b.start);
}

export function markerLabelsAt(markers, seconds) {
  return Array.from(new Set(markers.filter(function (marker) {
    return marker.end === null
      ? Math.abs(seconds - marker.start) < 0.05
      : seconds >= marker.start && seconds < marker.end;
  }).map(marker => marker.label)));
}

export function randomQueue(queue, random) {
  const current = queue.ids[queue.index];
  const choices = Array.from(new Set(queue.ids)).filter(function (id) {
    return id !== current;
  });
  if (!choices.length) return null;
  const selected = choices[Math.floor(random * choices.length)];
  const remaining = queue.ids.slice(queue.index + 1).filter(function (id) {
    return id !== selected;
  });
  return {
    ids: queue.ids.slice(0, queue.index + 1).concat([selected], remaining),
    index: queue.index + 1,
  };
}

export function remoteAction(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  for (let digit = 0; digit <= 9; digit++) {
    const legacy = !event.key || event.key === "Unidentified";
    if (
      event.key === String(digit) ||
      (legacy && !event.shiftKey && [48 + digit, 96 + digit].includes(event.keyCode))
    )
      return { type: "seek-percent", percent: digit * 10 };
  }
  const letters = {
    w: "volume-up",
    s: "volume-down",
    d: event.shiftKey ? "forward-minute" : "forward",
    a: event.shiftKey ? "backward-minute" : "backward",
    f: event.shiftKey ? "previous" : "next",
    r: "random",
  };
  const letter = letters[(event.key || "").toLowerCase()];
  if (letter) return letter;
  const keys = {
    ColorF0Red: "previous",
    ColorF1Green: "random",
    ColorF2Yellow: "toggle",
    ColorF3Blue: "next",
    ArrowLeft: "backward",
    ArrowRight: "forward",
    Enter: "fullscreen",
    " ": "toggle",
    ArrowUp: "controls",
    ArrowDown: "controls",
    Delete: "delete",
  };
  const codes = {
    403: "previous",
    404: "random",
    405: "toggle",
    406: "next",
    37: "backward",
    39: "forward",
    13: "fullscreen",
    32: "toggle",
    38: "controls",
    40: "controls",
    46: "delete",
  };
  return keys[event.key] || codes[event.keyCode] || null;
}

export function streamChoices(scene, origin, basePath = "/") {
  const prefix = basePath + "scene/" + encodeURIComponent(scene.id) + "/stream";
  const seen = new Set();
  const candidates = [
    { url: scene.paths.stream, label: "Original / direct", mime_type: "" },
  ].concat(scene.sceneStreams || []);
  return candidates
    .filter(function (entry) {
      return !!entry.url;
    })
    .map(function (entry) {
      const url = new URL(entry.url, origin);
      if (
        url.origin !== origin ||
        url.username ||
        url.password ||
        ![prefix, prefix + ".mp4", prefix + ".m3u8", prefix + ".webm", prefix + ".mkv"].includes(
          url.pathname,
        )
      )
        return null;
      if (seen.has(url.href)) return null;
      seen.add(url.href);
      return {
        url: url.href,
        label: entry.label || "Compatible stream",
        mime: entry.mime_type || "",
        offset: url.pathname !== prefix && !url.pathname.endsWith(".m3u8"),
      };
    })
    .filter(Boolean);
}

export function truncatedWebmFallback(sources, index, offset, sceneDuration, mediaDuration) {
  const source = sources[index];
  if (!source || !Number.isFinite(mediaDuration) || mediaDuration <= 0 ||
      sceneDuration - offset - mediaDuration <= 1) return -1;
  const current = new URL(source.url);
  if (!current.pathname.endsWith(".webm")) return -1;
  return sources.findIndex((candidate) => {
    const url = new URL(candidate.url);
    return url.pathname.endsWith(".mp4") &&
      url.searchParams.get("resolution") === current.searchParams.get("resolution");
  });
}

export function sourceAt(source, seconds) {
  const url = new URL(source.url);
  if (source.offset) url.searchParams.set("start", String(Math.max(0, seconds)));
  return url.href;
}

export function timeLabel(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  return (
    (minutes >= 60
      ? Math.floor(minutes / 60) + ":" + String(minutes % 60).padStart(2, "0")
      : String(minutes)) +
    ":" +
    String(total % 60).padStart(2, "0")
  );
}

async function boot() {
  const byId = function (id) {
    return document.getElementById(id);
  };
  const player = byId("player");
  const video = byId("video");
  const params = new URLSearchParams(location.search);
  const basePath = location.pathname.split("/plugin/stash-tv/assets/")[0] + "/";
  const baseURL = new URL(basePath, location.origin);
  const debug = params.get("debug") === "1";
  const cache = new Map();
  const scrub = {
    exactTime: null,
    status: "idle",
    cues: [],
    image: null,
    controller: null,
    time: null,
    dragging: false,
    frame: 0,
    hideTimer: 0,
  };
  const state = {
    queue: null,
    scene: null,
    markers: [],
    sources: [],
    sourceIndex: 0,
    sourceURL: "",
    offset: 0,
    resume: 0,
    generation: 0,
    phase: "loading",
    buffering: true,
    wantsPlay: params.get("autoplay") !== "false",
    playedAt: 0,
    counted: false,
    reported: false,
    startedAt: performance.now(),
    fromBeginning: false,
    enableDelete: false,
    seed: 0,
    hideTimer: 0,
    sourceTimer: 0,
    timelineFrame: 0,
    seekTarget: null,
    seekTimer: 0,
  };
  let activity = Promise.resolve();

  async function api(query, variables, keepalive, timeout) {
    const controller = new AbortController();
    const timer = setTimeout(function () {
      controller.abort();
    }, timeout || 15000);
    try {
      const response = await fetch(new URL("graphql", baseURL), {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ query: query, variables: variables || {} }),
        keepalive: !!keepalive,
      });
      if (response.status === 401) {
        const login = new URL("login", baseURL);
        login.searchParams.set("returnURL", location.pathname + location.search);
        location.replace(login.href);
        throw new Error("Sign in to Stash to continue.");
      }
      if (!response.ok) throw new Error("Stash request failed (" + response.status + ").");
      const body = await response.json();
      if (body.errors && body.errors.length)
        throw new Error(
          body.errors
            .map(function (error) {
              return error.message;
            })
            .join("; "),
        );
      if (!body.data) throw new Error("Stash returned no data.");
      return body.data;
    } finally {
      clearTimeout(timer);
    }
  }

  function mark(event) {
    if (!debug) return;
    const values = new URLSearchParams({
      tv_event: event,
      scene: state.scene ? state.scene.id : "0",
      elapsed_ms: String(Math.round(performance.now() - state.startedAt)),
      width: String(video.videoWidth),
      height: String(video.videoHeight),
      fullscreen: fullscreen() ? "1" : "0",
      position_s: String(Math.round(currentTime() * 10) / 10),
      paused: video.paused ? "1" : "0",
    });
    console.info("Stash TV", event, Object.fromEntries(values));
  }

  function phase(value, message) {
    state.phase = value;
    player.dataset.phase = value;
    byId("quality-controls").hidden = value !== "error";
    byId("status").hidden = !["error", "delete-unknown", "empty"].includes(value);
    if (message) byId("status").textContent = message;
    const label = value === "error" ? "Retry" : value === "playing" ? "Pause" : "Play";
    byId("toggle").setAttribute("aria-label", label);
    byId("toggle").title = label;
    byId("surface").setAttribute("aria-label", label + " video");
    const blocked = ["deleting", "delete-unknown", "empty"].includes(value);
    ["surface", "toggle", "random", "seek", "source"].forEach(function (id) {
      byId(id).disabled = blocked;
    });
    byId("delete").disabled = !state.enableDelete || blocked || !state.scene;
    byId("previous").disabled = blocked || !state.queue || state.queue.index === 0;
    byId("next").disabled =
      blocked || !state.queue || state.queue.index === state.queue.ids.length - 1;
    player.setAttribute("aria-busy", String(value === "deleting"));
    setBuffering(value === "loading" || (value === "paused" && video.seeking));
  }

  function setBuffering(value) {
    state.buffering = value;
    player.dataset.buffering = String(value);
    byId("toggle").setAttribute("aria-busy", String(value));
    showControls();
  }

  function showControls() {
    player.classList.remove("idle");
    clearTimeout(state.hideTimer);
    scheduleTimeline();
    if (state.phase === "playing" && !state.buffering && !scrub.dragging && scrub.time === null)
      state.hideTimer = setTimeout(function () {
        player.classList.add("idle");
        byId("surface").focus();
      }, 3000);
  }

  function updateVolume() {
    const silent = video.muted || video.volume === 0;
    const value = silent ? 0 : Math.round(video.volume * 100);
    const label = silent ? "Unmute" : "Mute";
    byId("volume").value = String(value);
    byId("volume").style.setProperty("--progress", value + "%");
    byId("volume").setAttribute("aria-valuetext", value + "%");
    byId("mute").setAttribute("aria-pressed", String(silent));
    byId("mute").setAttribute("aria-label", label);
    byId("mute").title = label;
    showControls();
  }

  function fullscreen() {
    return document.fullscreenElement || document.webkitFullscreenElement;
  }

  function updateFullscreen() {
    player.dataset.fullscreen = fullscreen() ? "true" : "false";
    const label = fullscreen() ? "Exit fullscreen" : "Fullscreen";
    byId("fullscreen").setAttribute("aria-label", label);
    byId("fullscreen").title = label;
    mark("fullscreen");
    renderPreview();
  }

  function enterFullscreen() {
    if (fullscreen()) return;
    const request = player.requestFullscreen || player.webkitRequestFullscreen;
    if (!request) return;
    const result = request.call(player);
    if (result && result.catch)
      result.catch(function () {
        byId("notice").textContent = "Press Fullscreen to enter fullscreen.";
      });
  }

  function currentTime() {
    return Math.max(0, (Number(video.currentTime) || 0) + state.offset);
  }

  function saveProgress(keepalive) {
    if (!state.scene || !state.counted) return;
    const generation = state.generation;
    const warning = "Resume position could not be saved.";
    const now = performance.now();
    const duration = state.playedAt ? Math.max(0, (now - state.playedAt) / 1000) : 0;
    state.playedAt = video.paused ? 0 : now;
    const variables = {
      id: state.scene.id,
      resume: video.ended ? 0 : currentTime(),
      duration: duration,
    };
    state.scene.resume_time = variables.resume;
    activity = activity
      .catch(function () {})
      .then(function () {
        return api(
          "mutation TVActivity($id:ID!,$resume:Float!,$duration:Float!){sceneSaveActivity(id:$id,resume_time:$resume,playDuration:$duration)}",
          variables,
          keepalive,
          45000,
        );
      })
      .then(function (data) {
        if (!data.sceneSaveActivity) throw new Error("Stash did not save playback activity.");
        if (generation === state.generation && byId("notice").textContent === warning)
          byId("notice").textContent = "";
      })
      .catch(function (error) {
        console.warn("Stash TV activity save failed", variables.id, error.message);
        if (generation === state.generation) byId("notice").textContent = warning;
      });
  }

  function paintSeek() {
    const seek = byId("seek");
    const percent = Math.max(0, Math.min(100, (Number(seek.value) / Number(seek.max)) * 100));
    seek.style.setProperty("--progress", percent + "%");
  }

  function positionMarkers() {
    const range = byId("seek");
    const layer = byId("seek-markers");
    layer.style.left = range.offsetLeft + 6 + "px";
    layer.style.width = Math.max(0, range.clientWidth - 12) + "px";
  }

  function renderMarkers() {
    const layer = byId("seek-markers");
    layer.textContent = "";
    layer.hidden = !state.markers.length;
    const duration = Number(byId("seek").max);
    state.markers.forEach(function (marker) {
      if (marker.end !== null) {
        const segment = document.createElement("span");
        segment.className = "marker-range";
        segment.style.left = marker.start / duration * 100 + "%";
        segment.style.width = (marker.end - marker.start) / duration * 100 + "%";
        layer.appendChild(segment);
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "marker-tick";
      button.dataset.markerId = marker.id;
      button.style.left = marker.start / duration * 100 + "%";
      button.setAttribute("aria-label", marker.label + " · " + timeLabel(marker.start));
      button.onpointerenter = button.onfocus = function () { showPreview(marker.start); };
      button.onpointerleave = button.onblur = function () { hidePreview(); };
      button.onclick = function () { seek(marker.start); };
      layer.appendChild(button);
    });
    positionMarkers();
  }

  function scheduleTimeline() {
    if (state.timelineFrame) return;
    state.timelineFrame = requestAnimationFrame(function update() {
      state.timelineFrame = 0;
      const seconds =
        state.seekTarget !== null
          ? state.seekTarget
          : scrub.dragging
            ? Number(byId("seek").value)
            : currentTime();
      const label = timeLabel(seconds);
      if (byId("elapsed").textContent !== label) byId("elapsed").textContent = label;
      if (!scrub.dragging) byId("seek").value = String(seconds);
      paintSeek();
      if (
        state.phase === "playing" &&
        !video.paused &&
        !state.buffering &&
        !scrub.dragging &&
        state.seekTarget === null &&
        !player.classList.contains("idle")
      )
        state.timelineFrame = requestAnimationFrame(update);
    });
  }

  function hidePreview() {
    clearTimeout(scrub.hideTimer);
    scrub.time = null;
    scrub.exactTime = null;
    byId("preview-exact").hidden = true;
    byId("seek-preview").hidden = true;
    showControls();
  }

  function resetPreview() {
    clearTimeout(state.seekTimer);
    state.seekTarget = null;
    if (scrub.controller) scrub.controller.abort();
    if (scrub.image) scrub.image.src = "";
    cancelAnimationFrame(scrub.frame);
    scrub.frame = 0;
    scrub.dragging = false;
    scrub.cues = [];
    scrub.image = null;
    scrub.status = "idle";
    hidePreview();
  }

  function capturePreview() {
    if (
      scrub.time === null ||
      video.seeking ||
      video.readyState < 2 ||
      video.currentSrc !== state.sourceURL ||
      Math.abs(currentTime() - scrub.time) > 0.05
    )
      return;
    const canvas = byId("preview-exact");
    canvas.width = 560;
    canvas.height = Math.round((560 * video.videoHeight) / video.videoWidth);
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    scrub.exactTime = scrub.time;
    renderPreview();
  }

  async function loadPreview() {
    scrub.status = "loading";
    const generation = state.generation;
    const controller = new AbortController();
    scrub.controller = controller;
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      if (!state.scene.paths.vtt) throw new Error("No preview");
      const url = new URL(state.scene.paths.vtt, location.origin);
      if (url.origin !== location.origin) throw new Error("External preview");
      const response = await fetch(url.href, {
        signal: controller.signal,
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error("No preview");
      const cues = previewCues(await response.text(), url.href, location.origin);
      if (generation !== state.generation) return;
      if (!cues.length) throw new Error("No preview frames");
      const image = new Image();
      scrub.image = image;
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
        controller.signal.addEventListener("abort", reject, { once: true });
        image.src = cues[0].url;
      });
      if (generation !== state.generation) return;
      scrub.cues = cues.filter(
        (cue) =>
          cue.url === cues[0].url &&
          cue.x + cue.width <= image.naturalWidth &&
          cue.y + cue.height <= image.naturalHeight,
      );
      scrub.status = scrub.cues.length ? "ready" : "missing";
      renderPreview();
    } catch {
      if (generation === state.generation) {
        scrub.status = "missing";
        renderPreview();
      }
    } finally {
      clearTimeout(timer);
    }
  }

  function renderPreview() {
    if (scrub.frame) return;
    scrub.frame = requestAnimationFrame(function () {
      scrub.frame = 0;
      const cue = scrub.time === null ? null : previewAt(scrub.cues, scrub.time);
      const box = byId("seek-preview");
      const exact = scrub.time !== null && scrub.exactTime === scrub.time;
      const labels = scrub.time === null ? [] : markerLabelsAt(state.markers, scrub.time);
      const label = byId("preview-marker");
      label.textContent = labels.join(" · ");
      label.hidden = !labels.length;
      const hasFrame = exact || (scrub.status === "ready" && !!cue);
      byId("preview-frame").hidden = !hasFrame;
      if (!hasFrame && !labels.length) {
        box.hidden = true;
        return;
      }
      const canvas = byId("preview-exact");
      const frameWidth = exact ? canvas.width : hasFrame ? cue.width : 280;
      const frameHeight = exact ? canvas.height : hasFrame ? cue.height : 158;
      const range = byId("seek");
      const timeline = range.parentElement;
      const desiredWidth = Math.max(220, Math.min(560, 152 + player.clientWidth * 0.1));
      const maxHeight = Math.min(
        Math.max(150, Math.min(320, 110 + player.clientHeight * 0.1)),
        Math.max(1, timeline.getBoundingClientRect().top - 56),
      );
      const width = Math.min(
        desiredWidth,
        timeline.clientWidth,
        (maxHeight * frameWidth) / frameHeight,
      );
      const scale = width / frameWidth;
      const center =
        range.offsetLeft + 6 + ((range.clientWidth - 12) * scrub.time) / Number(range.max);
      box.style.width = width + "px";
      box.style.transform =
        "translate3d(" +
        Math.max(0, Math.min(center - width / 2, timeline.clientWidth - width)) +
        "px,0,0)";
      byId("preview-frame").style.height = frameHeight * scale + "px";
      const image = byId("preview-image");
      image.hidden = exact;
      canvas.hidden = !exact;
      if (hasFrame && !exact) {
        if (image.src !== cue.url) image.src = cue.url;
        image.style.width = scrub.image.naturalWidth * scale + "px";
        image.style.transform = "translate3d(" + -cue.x * scale + "px," + -cue.y * scale + "px,0)";
      }
      byId("preview-time").textContent = exact || !hasFrame
        ? timeLabel(scrub.time)
        : "≈ " + timeLabel(cue.start);
      box.hidden = false;
    });
  }

  function showPreview(seconds) {
    if (!state.scene || byId("seek").disabled) return;
    clearTimeout(scrub.hideTimer);
    const target = Math.max(0, Math.min(seconds, Number(byId("seek").max)));
    if (target !== scrub.time) {
      scrub.exactTime = null;
      byId("preview-exact").hidden = true;
    }
    scrub.time = target;
    capturePreview();
    showControls();
    if (scrub.status === "idle") loadPreview();
    renderPreview();
  }

  function getScene(id) {
    if (cache.has(id)) return cache.get(id);
    const query =
      "query TVScene($id:ID!){findScene(id:$id){id resume_time paths{stream vtt} sceneStreams{url mime_type label} files{duration} scene_markers{id title seconds end_seconds primary_tag{name}}}}";
    const promise = api(query, { id: id })
      .then(function (data) {
        if (!data.findScene) throw new Error("This scene is no longer in Stash. Choose Next.");
        return data.findScene;
      })
      .catch(function (error) {
        cache.delete(id);
        throw error;
      });
    cache.set(id, promise);
    while (cache.size > 3) cache.delete(cache.keys().next().value);
    return promise;
  }

  function play() {
    state.wantsPlay = true;
    if (!state.scene || !state.sourceURL || state.resume || video.seeking || video.readyState < 3)
      return;
    const generation = state.generation;
    video.play().catch(function (error) {
      if (generation !== state.generation || error.name === "AbortError") return;
      if (error.name === "NotAllowedError") {
        phase("ready", "Press Play to start.");
        showControls();
      }
    });
  }

  function setSource(index, seconds) {
    clearTimeout(state.sourceTimer);
    state.sourceIndex = index;
    const source = state.sources[index];
    if (source.offset) {
      const duration = Number((state.scene.files[0] || {}).duration) || 0;
      seconds = Math.min(seconds, Math.max(0, Math.floor((duration - 0.1) * 10) / 10));
    }
    state.offset = source.offset ? seconds : 0;
    state.resume = source.offset ? 0 : seconds;
    player.dataset.videoReady = "false";
    state.sourceURL = sourceAt(source, seconds);
    byId("source").value = String(index);
    byId("status").textContent = source.label;
    phase("loading", "Loading video...");
    video.pause();
    video.src = state.sourceURL;
    video.load();
    const generation = state.generation;
    state.sourceTimer = setTimeout(function () {
      if (generation === state.generation && state.phase === "loading") {
        phase("error", "Video is taking too long. Choose another quality or retry.");
        showControls();
      }
    }, 20000);
  }

  async function loadScene() {
    saveProgress();
    const generation = ++state.generation;
    resetPreview();
    state.startedAt = performance.now();
    clearTimeout(state.sourceTimer);
    video.pause();
    state.scene = null;
    state.markers = [];
    renderMarkers();
    state.sourceURL = "";
    state.counted = false;
    state.reported = false;
    state.playedAt = 0;
    video.removeAttribute("src");
    video.removeAttribute("poster");
    player.dataset.videoReady = "false";
    video.load();
    phase("loading", "Loading scene...");
    showControls();
    const queue = state.queue;
    const id = queue.ids[queue.index];
    byId("previous").disabled = queue.index === 0;
    byId("next").disabled = queue.index === queue.ids.length - 1;
    byId("notice").textContent = "";
    try {
      const scene = await getScene(id);
      if (generation !== state.generation) return;
      state.scene = scene;
      state.sources = streamChoices(scene, location.origin, basePath).filter(function (source, index) {
        return index === 0 || !source.mime || !!video.canPlayType(source.mime);
      });
      if (!state.sources.length) throw new Error("No playable stream is available. Choose Next.");
      byId("source").textContent = "";
      state.sources.forEach(function (source, index) {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = source.label;
        byId("source").appendChild(option);
      });
      const file = scene.files[0] || {};
      byId("duration").textContent = timeLabel(file.duration);
      byId("seek").max = String(file.duration || 1);
      state.markers = sceneMarkers(scene.scene_markers, Number(file.duration));
      renderMarkers();
      setSource(0, state.fromBeginning ? 0 : Number(scene.resume_time) || 0);
      mark("ready");
      const next = advanceQueue(queue, 1);
      if (next) getScene(next.ids[next.index]).catch(function () {});
      params.set("scene", id);
      params.set("seed", String(state.seed));
      history.replaceState(null, "", location.pathname + "?" + params.toString());
    } catch (error) {
      if (generation === state.generation) {
        phase("error", error.message);
        showControls();
      }
    }
  }

  async function loadQueue(requestedId) {
    try {
      const values = new Uint32Array(1);
      crypto.getRandomValues(values);
      const requestedSeed = Number(params.get("seed"));
      state.seed =
        requestedId &&
        Number.isInteger(requestedSeed) &&
        requestedSeed >= 0 &&
        requestedSeed <= 2147483647
          ? requestedSeed
          : values[0] % 2147483647;
      const result = await api(
        "query TVQueue($filter:FindFilterType!){findScenes(filter:$filter){scenes{id}} configuration{ui plugins(include:[\"stash-tv\"])}}",
        { filter: { sort: "random_" + state.seed, direction: "DESC", per_page: -1 } },
      );
      state.queue = makeQueue(result.findScenes.scenes, requestedId);
      state.fromBeginning = !!(result.configuration.ui || {}).alwaysStartFromBeginning;
      state.enableDelete = (result.configuration.plugins["stash-tv"] || {}).enableDelete === true;
      byId("delete").hidden = !state.enableDelete;
      cache.clear();
      await loadScene();
    } catch (error) {
      phase("error", error.message);
      showControls();
    }
  }

  function navigate(direction) {
    if (!state.queue || byId("random").disabled) return;
    const queue = advanceQueue(state.queue, direction);
    if (!queue) {
      byId("notice").textContent =
        direction > 0 ? "End of queue. Press R or Green for another random video." : "First scene in queue.";
      showControls();
      return;
    }
    state.queue = queue;
    state.wantsPlay = true;
    loadScene();
  }

  function random() {
    if (!state.queue || byId("random").disabled) return;
    const queue = randomQueue(state.queue, Math.random());
    if (!queue) return;
    state.queue = queue;
    state.wantsPlay = true;
    loadScene();
    byId("surface").focus();
  }

  function toggle() {
    if (byId("toggle").disabled) return;
    if (state.phase === "error") {
      state.wantsPlay = true;
      if (state.queue) loadScene();
      else loadQueue();
    } else if (video.paused) {
      play();
    } else {
      state.wantsPlay = false;
      video.pause();
    }
    byId("surface").focus();
    showControls();
  }

  function seek(seconds) {
    clearTimeout(state.seekTimer);
    state.seekTarget = null;
    if (byId("seek").disabled || !state.scene || !state.sources.length) return;
    const duration = Number((state.scene.files[0] || {}).duration) || 0;
    const target = Math.max(0, Math.min(seconds, duration));
    showPreview(target);
    scrub.hideTimer = setTimeout(hidePreview, 1500);
    if (state.sources[state.sourceIndex].offset) {
      saveProgress();
      setSource(state.sourceIndex, target);
    } else if (video.currentTime !== target) {
      setBuffering(true);
      video.currentTime = target;
    }
    byId("seek").value = String(target);
    paintSeek();
    showControls();
  }

  function queueSeek(delta) {
    if (byId("seek").disabled || !state.scene) return;
    const duration = Number((state.scene.files[0] || {}).duration) || 0;
    state.seekTarget = Math.max(
      0,
      Math.min((state.seekTarget === null ? currentTime() : state.seekTarget) + delta, duration),
    );
    showPreview(state.seekTarget);
    scheduleTimeline();
    clearTimeout(state.seekTimer);
    state.seekTimer = setTimeout(function () {
      seek(state.seekTarget);
    }, 120);
  }

  async function deleteScene(event) {
    if (byId("delete").disabled || event.detail > 1) return;
    const id = state.scene.id;
    const queue = state.queue;
    ++state.generation;
    resetPreview();
    clearTimeout(state.sourceTimer);
    state.scene = null;
    state.markers = [];
    renderMarkers();
    state.sourceURL = "";
    state.counted = false;
    state.playedAt = 0;
    state.wantsPlay = false;
    phase("deleting");
    showControls();
    byId("notice").textContent = "";
    video.pause();
    video.removeAttribute("src");
    video.removeAttribute("poster");
    video.load();
    cache.delete(id);
    let submitted = false;
    try {
      await activity;
      const config = await api("query TVDeleteSettings{configuration{general{deleteTrashPath}}}");
      if (config.configuration.general.deleteTrashPath !== "")
        throw new Error(
          "Trash is enabled in Stash. Disable it before permanently deleting videos.",
        );
      submitted = true;
      const result = await api(
        "mutation TVDelete($input:SceneDestroyInput!){sceneDestroy(input:$input)}",
        { input: { id: id, delete_file: true, delete_generated: true, destroy_file_entry: true } },
        false,
        45000,
      );
      if (!result.sceneDestroy) throw new Error("Stash did not confirm deletion.");
    } catch (error) {
      let exists = true;
      if (submitted) {
        try {
          const result = await api("query TVDeleted($id:ID!){findScene(id:$id){id}}", { id: id });
          exists = !!result.findScene;
        } catch {
          phase("delete-unknown", "Deletion result unknown. Reload the player to check Stash.");
          return;
        }
      }
      if (exists) {
        await loadScene();
        byId("notice").textContent = "Could not delete video: " + error.message;
        return;
      }
    }
    state.queue = removeCurrentScene(queue);
    if (state.queue) {
      state.wantsPlay = true;
      await loadScene();
      byId("surface").focus();
    } else {
      params.delete("scene");
      history.replaceState(null, "", location.pathname + "?" + params.toString());
      byId("elapsed").textContent = "0:00";
      byId("duration").textContent = "0:00";
      byId("seek").value = "0";
      paintSeek();
      phase("empty", "No videos left in this queue.");
    }
  }

  byId("toggle").onclick = toggle;
  byId("surface").onclick = function () {
    mark("click_toggle");
    toggle();
  };
  byId("next").onclick = function () {
    navigate(1);
    byId("surface").focus();
  };
  byId("previous").onclick = function () {
    navigate(-1);
    byId("surface").focus();
  };
  byId("random").onclick = random;
  byId("delete").onclick = deleteScene;
  byId("seek").addEventListener("pointerdown", function () {
    scrub.dragging = true;
    showPreview(Number(this.value));
  });
  byId("seek").addEventListener("pointermove", function (event) {
    if (scrub.dragging) return;
    const bounds = this.getBoundingClientRect();
    showPreview(seekPosition(event.clientX, bounds.left, bounds.width, Number(this.max)));
  });
  byId("seek").addEventListener("pointerleave", function () {
    if (!scrub.dragging) hidePreview();
  });
  document.addEventListener("pointerup", function () {
    if (!scrub.dragging) return;
    scrub.dragging = false;
    scrub.hideTimer = setTimeout(hidePreview, 800);
    showControls();
  });
  byId("seek").addEventListener("pointercancel", function () {
    scrub.dragging = false;
    hidePreview();
    scheduleTimeline();
  });
  byId("seek").oninput = function () {
    paintSeek();
    byId("elapsed").textContent = timeLabel(Number(this.value));
    showPreview(Number(this.value));
  };
  byId("seek").onchange = function () {
    seek(Number(this.value));
  };
  byId("mute").onclick = function () {
    if (video.muted || video.volume === 0) {
      if (video.volume === 0) video.volume = 1;
      video.muted = false;
    } else video.muted = true;
  };
  byId("volume").oninput = function () {
    video.volume = Number(this.value) / 100;
    video.muted = video.volume === 0;
  };
  video.addEventListener("volumechange", updateVolume);
  updateVolume();
  byId("source").onchange = function () {
    saveProgress();
    setSource(Number(this.value), currentTime());
  };
  byId("fullscreen").onclick = function () {
    if (fullscreen()) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) exit.call(document);
    } else enterFullscreen();
  };
  function recoverTruncatedStream() {
    if (!state.scene || video.currentSrc !== state.sourceURL || state.phase === "error") return false;
    const fallback = truncatedWebmFallback(state.sources, state.sourceIndex, state.offset,
      Number((state.scene.files[0] || {}).duration), video.duration);
    if (fallback < 0) return false;
    setSource(fallback, currentTime());
    return true;
  }
  video.addEventListener("durationchange", recoverTruncatedStream);
  setInterval(function () {
    if (state.phase === "playing") recoverTruncatedStream();
  }, 500);
  video.addEventListener("loadedmetadata", function () {
    if (!state.scene || video.currentSrc !== state.sourceURL) return;
    if (state.resume) {
      video.currentTime = state.resume;
      state.resume = 0;
    }
  });
  ["waiting", "seeking"].forEach(function (event) {
    video.addEventListener(event, function () {
      if (!state.scene || video.currentSrc !== state.sourceURL || state.phase === "error") return;
      setBuffering(true);
    });
  });
  ["canplay", "seeked"].forEach(function (event) {
    video.addEventListener(event, function () {
      if (
        !state.scene ||
        video.currentSrc !== state.sourceURL ||
        state.resume ||
        video.seeking ||
        video.readyState < 3
      )
        return;
      player.dataset.videoReady = "true";
      if (state.phase === "loading") {
        if (state.wantsPlay) play();
        else phase("ready", "Press Play to start.");
      } else setBuffering(false);
    });
  });
  video.addEventListener("playing", function () {
    if (!state.scene || video.currentSrc !== state.sourceURL) return;
    clearTimeout(state.sourceTimer);
    phase("playing");
    if (!state.playedAt) state.playedAt = performance.now();
    byId("status").textContent =
      state.sources[state.sourceIndex].label +
      (video.videoHeight ? " · " + video.videoHeight + "p" : "");
    if (!state.counted) {
      state.counted = true;
      api("mutation TVPlayed($id:ID!){sceneIncrementPlayCount(id:$id)}", {
        id: state.scene.id,
      }).catch(function () {
        byId("notice").textContent = "Play count could not be saved.";
      });
    }
    if (!state.reported) {
      state.reported = true;
      mark("playing");
    } else mark("resumed");
    showControls();
  });
  video.addEventListener("pause", function () {
    if (state.phase !== "playing") return;
    saveProgress();
    phase("paused", "Paused");
    mark("paused");
    showControls();
  });
  video.addEventListener("seeked", function () {
    mark("seeked");
    capturePreview();
  });
  video.addEventListener("loadeddata", capturePreview);
  video.addEventListener("ended", function () {
    if (recoverTruncatedStream()) return;
    saveProgress();
    navigate(1);
  });
  video.addEventListener("timeupdate", scheduleTimeline);
  video.addEventListener("error", function () {
    if (!state.scene || video.currentSrc !== state.sourceURL) return;
    const code = video.error && video.error.code;
    if ((code === 3 || code === 4) && state.sourceIndex + 1 < state.sources.length) {
      const position = currentTime() || state.resume;
      byId("notice").textContent = "Original format unavailable. Trying a compatible stream.";
      setSource(state.sourceIndex + 1, position);
    } else {
      clearTimeout(state.sourceTimer);
      phase("error", "Video could not load. Retry or choose another quality.");
      showControls();
    }
  });
  player.addEventListener("mousemove", showControls);
  player.addEventListener("pointerdown", showControls);
  player.addEventListener("click", function (event) {
    if (event.target === player || event.target === video) {
      mark("click_toggle");
      toggle();
    }
  });
  player.addEventListener("dblclick", function (event) {
    if (event.target === video || event.target === byId("surface")) enterFullscreen();
  });
  document.addEventListener("fullscreenchange", updateFullscreen);
  document.addEventListener("webkitfullscreenchange", updateFullscreen);
  window.addEventListener("resize", renderPreview);
  window.addEventListener("resize", positionMarkers);
  document.addEventListener("keydown", function (event) {
    if (
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.target.isContentEditable ||
      ["SELECT", "TEXTAREA"].includes(event.target.tagName) ||
      (event.target.tagName === "INPUT" && event.target.type !== "range")
    )
      return;
    if (
      event.target === byId("volume") &&
      [
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
        "PageUp",
        "PageDown",
      ].includes(event.key)
    ) {
      showControls();
      return;
    }
    if (event.target === byId("mute") && (event.key === " " || event.keyCode === 32)) {
      event.preventDefault();
      if (!event.repeat) byId("mute").click();
      return;
    }
    if (event.target === byId("delete") && (event.key === " " || event.keyCode === 32)) {
      event.preventDefault();
      if (!event.repeat) deleteScene(event);
      return;
    }
    if (event.target.classList.contains("marker-tick") &&
        (event.key === " " || event.key === "Enter")) {
      event.preventDefault();
      if (!event.repeat) event.target.click();
      return;
    }
    const action = remoteAction(event);
    if (!action) return;
    event.preventDefault();
    if (action.type === "seek-percent") {
      if (!event.repeat && state.scene) {
        mark("key_seek_" + action.percent);
        seek(((Number((state.scene.files[0] || {}).duration) || 0) * action.percent) / 100);
      }
      return;
    }
    if (
      event.repeat &&
      ["previous", "random", "next", "toggle", "delete", "fullscreen"].includes(action)
    )
      return;
    mark("key_" + action);
    if (action === "previous") navigate(-1);
    else if (action === "next") navigate(1);
    else if (action === "random") random();
    else if (action === "backward") queueSeek(-10);
    else if (action === "forward") queueSeek(10);
    else if (action === "backward-minute") queueSeek(-60);
    else if (action === "forward-minute") queueSeek(60);
    else if (action === "delete") deleteScene(event);
    else if (action === "fullscreen") enterFullscreen();
    else if (action === "volume-up" || action === "volume-down") {
      const volume = video.muted ? 0 : video.volume;
      video.volume = Math.max(0, Math.min(1, volume + (action === "volume-up" ? 0.05 : -0.05)));
      video.muted = video.volume === 0;
      showControls();
    } else if (action === "toggle") toggle();
    else showControls();
  });
  window.addEventListener("pagehide", function () {
    saveProgress(true);
  });
  setInterval(function () {
    if (state.phase === "playing") saveProgress();
  }, 15000);
  byId("surface").focus();
  await loadQueue(params.get("scene"));
}

if (typeof document !== "undefined") boot();
