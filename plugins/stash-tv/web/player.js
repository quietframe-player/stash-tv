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
    ArrowUp: { type: "navigate", direction: 1 },
    ArrowDown: { type: "navigate", direction: -1 },
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
    38: keys.ArrowUp,
    40: keys.ArrowDown,
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
  const stills = new Map();
  const positions = new Map();
  let buffer = null;
  let bufferSetup = null;
  let readyFrame = 0;
  let multiview = null;
  let multiviewSetup = null;
  const scrub = {
    exactTime: null,
    status: "idle",
    cues: [],
    image: null,
    controller: null,
    time: null,
    dragging: false,
    pointerId: null,
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
    layout: 1,
  };
  let activity = Promise.resolve();
  const reducedMotion = function () { return matchMedia("(prefers-reduced-motion: reduce)").matches; };
  const swipe = { phase: "idle", direction: 0, origin: 0, offset: 0, backdropOffset: 0, height: 0, target: null, generation: 0, timer: 0, frame: 0 };
  let pan = 0.5;
  const seekFeedback = { side: 0, seconds: 0, until: 0, timer: 0, pulseTimer: 0 };

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
    if (value === "error") resetSwipe();
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
    const available = new Set(state.queue?.ids).size;
    byId("layout-two").disabled = blocked || available < 2;
    byId("layout-four").disabled = blocked || available < 4;
    if (blocked) multiview?.setPlaying(false);
    byId("delete").disabled = state.layout > 1 || !state.enableDelete || blocked || !state.scene;
    byId("previous").disabled = blocked || !state.queue || state.layout === 1 && state.queue.index === 0;
    byId("next").disabled =
      blocked || !state.queue || state.layout === 1 && state.queue.index === state.queue.ids.length - 1;
    player.setAttribute("aria-busy", String(value === "deleting"));
    setBuffering(value === "loading" || (value === "paused" && video.seeking));
  }

  function setBuffering(value) {
    state.buffering = value;
    const busy = value || state.layout > 1 && multiview?.loading();
    player.dataset.buffering = String(!!busy);
    byId("toggle").setAttribute("aria-busy", String(!!busy));
    buffer?.pause(state.layout > 1 || document.hidden || value || !["ready", "playing", "paused"].includes(state.phase));
    showControls();
  }

  function showControls() {
    player.classList.remove("idle");
    clearTimeout(state.hideTimer);
    scheduleTimeline();
    if (state.phase === "playing" && player.dataset.buffering === "false" && !scrub.dragging && scrub.time === null && byId("volume-panel").hidden && byId("more-panel").hidden)
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
    byId("mute").dataset.muted = String(silent);
    byId("volume-mute").setAttribute("aria-label", label);
    byId("volume-mute").title = label;
    const mobile = matchMedia("(pointer: coarse)").matches;
    byId("mute").setAttribute("aria-label", mobile ? label : "Volume");
    byId("mute").title = mobile ? label : "Volume";
    if (mobile) closeVolume();
    multiview?.setAudio(video.volume, video.muted);
    showControls();
  }

  function fullscreen() {
    return document.fullscreenElement || document.webkitFullscreenElement || video.webkitDisplayingFullscreen;
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
    function nativeFullscreen() {
      try {
        if (state.layout > 1) throw new Error("Multiview requires fullscreen for the whole player");
        if (!video.webkitEnterFullscreen) throw new Error("Fullscreen unavailable");
        video.webkitEnterFullscreen();
      } catch {
        byId("notice").textContent = "Fullscreen is unavailable in this browser.";
      }
    }
    byId("notice").textContent = "";
    if (!request || (document.fullscreenEnabled === false && document.webkitFullscreenEnabled !== true))
      return nativeFullscreen();
    try {
      const result = request.call(player);
      if (result && result.catch) result.catch(nativeFullscreen);
    } catch { nativeFullscreen(); }
  }

  function currentTime() {
    return Math.max(0, (Number(video.currentTime) || 0) + state.offset);
  }

  function saveProgress(keepalive) {
    if (state.scene && !state.fromBeginning && !video.seeking && video.readyState >= 2) {
      const position = video.ended ? 0 : currentTime();
      positions.set(state.scene.id, position);
      state.scene.resume_time = position;
    }
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
    layer.style.top = range.offsetTop + range.clientHeight / 2 - 24 + "px";
    layer.style.bottom = "auto";
    layer.style.left = range.offsetLeft + 6 + "px";
    layer.style.width = Math.max(0, range.clientWidth - 12) + "px";
  }

  function renderMarkers() {
    const layer = byId("seek-markers");
    layer.textContent = "";
    layer.hidden = state.layout > 1 || !state.markers.length;
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

  function timelineLabel(seconds) {
    return state.layout > 1 ? Math.round(100 * seconds / (Number(byId("seek").max) || 1)) + "%" : timeLabel(seconds);
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
      const label = timelineLabel(seconds);
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
    finishScrub(false);
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
    if (state.layout > 1) { hidePreview(); return; }
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
      "query TVScene($id:ID!){findScene(id:$id){id resume_time paths{stream vtt screenshot} sceneStreams{url mime_type label} files{id size duration format mod_time} scene_markers{id title seconds end_seconds primary_tag{name}}}}";
    const promise = api(query, { id: id })
      .then(async function (data) {
        if (!data.findScene) throw new Error("This scene is no longer in Stash. Choose Next.");
        return { ...data.findScene, sources: await playbackSources(data.findScene) };
      })
      .catch(function (error) {
        cache.delete(id);
        throw error;
      });
    cache.set(id, promise);
    while (cache.size > 4) cache.delete(cache.keys().next().value);
    return promise;
  }

  function drawStill(canvas, source, cue) {
    const width = cue ? cue.width : source.videoWidth || source.width;
    const height = cue ? cue.height : source.videoHeight || source.height;
    canvas.width = Math.min(1280, width);
    canvas.height = Math.round(canvas.width * height / width);
    canvas.getContext("2d").drawImage(source, cue ? cue.x : 0, cue ? cue.y : 0,
      width, height, 0, 0, canvas.width, canvas.height);
  }

  function checkpoint(scene) {
    if (state.fromBeginning) return 0;
    const seconds = positions.has(scene.id) ? positions.get(scene.id) : Number(scene.resume_time) || 0;
    return Math.max(0, Math.min(seconds, Number(scene.files[0]?.duration) - 0.05 || 0));
  }

  function versionOriginal(scene, source) {
    const file = scene.files[0];
    if (!file || source.offset || new URL(source.url).pathname.endsWith(".m3u8")) return source;
    const url = new URL(source.url);
    url.searchParams.set("stash_tv_file", [file.id, file.size, file.mod_time].join(":"));
    return { ...source, url: url.href };
  }

  async function playbackSources(scene) {
    const sources = streamChoices(scene, location.origin, basePath).filter(function (source, index) {
      return index === 0 || !source.mime || !!video.canPlayType(source.mime);
    }).map(source => versionOriginal(scene, source));
    const webkit = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg|OPR/.test(navigator.userAgent);
    const original = sources[0];
    if (!webkit || video.canPlayType("video/x-matroska") || scene.files[0]?.format !== "matroska" ||
        !original) return sources;
    const compatible = sources.filter(source => !new URL(source.url).pathname.endsWith(".mkv"));
    const fallback = compatible.filter(source => source !== original);
    const webm = video.canPlayType('video/webm; codecs="vp9,opus"') ?
      fallback.filter(source => new URL(source.url).pathname.endsWith(".webm")) : [];
    const segmented = fallback.filter(source => new URL(source.url).pathname.endsWith(".m3u8"));
    const preferred = webm.concat(segmented);
    const ordered = preferred.concat(fallback.filter(source => !preferred.includes(source)));
    const path = new URL(original.url).pathname;
    if (path.endsWith(".mkv")) return ordered.length ? ordered : sources;
    if (original.offset || !path.endsWith("/stream")) return sources;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    try {
      const response = await fetch(original.url, { headers: { Range: "bytes=0-15" },
        credentials: "same-origin", signal: controller.signal });
      if (response.status !== 206 || !/^bytes 0-(?:[0-9]|1[0-5])\//.test(response.headers.get("Content-Range") || "")) {
        await response.body?.cancel();
        return sources;
      }
      // The direct endpoint can contain a stored MP4 even when the original file is Matroska.
      const header = new Uint8Array(await response.arrayBuffer());
      if (header[0] !== 0x1a || header[1] !== 0x45 || header[2] !== 0xdf || header[3] !== 0xa3) return sources;
      return ordered.length ? ordered : sources;
    } catch { return sources; }
    finally { clearTimeout(timer); }
  }

  function storeStill(id, seconds, promise) {
    stills.set(id, { seconds, promise });
    while (stills.size > 4) stills.delete(stills.keys().next().value);
    return promise;
  }

  function getStill(id) {
    return getScene(id).then(function (scene) {
      const still = stills.get(id);
      return still && still.seconds === checkpoint(scene) ? still.promise : null;
    }).catch(function () { return null; });
  }

  function ensureBuffer() {
    const moduleURL = new URL("./buffering.js", import.meta.url);
    moduleURL.search = new URL(import.meta.url).search;
    if (!bufferSetup) bufferSetup = import(moduleURL.href).then(module => module.createBuffer(function (prepared) {
      if (!prepared.bitmap) return;
      const canvas = document.createElement("canvas");
      drawStill(canvas, prepared.bitmap);
      prepared.bitmap.close();
      canvas.dataset.position = String(prepared.seconds);
      canvas.dataset.frameTime = String(prepared.frameTime);
      storeStill(prepared.id, prepared.seconds, Promise.resolve(canvas));
      if (swipe.target === prepared.id) getStill(prepared.id).then(frame => {
        if (frame && swipe.target === prepared.id) drawStill(byId("swipe-incoming"), frame);
      });
    }, function (status) {
      if (status.cacheBytes !== undefined) player.dataset.cacheBytes = String(status.cacheBytes);
      if (status.entries !== undefined) player.dataset.cacheEntries = String(status.entries);
      player.dispatchEvent(new CustomEvent("stash-tv-buffer", { detail: status }));
      if (debug) console.info("Stash TV buffer", status);
    })).then(value => { buffer = value; return value; }).catch(() => null);
    return bufferSetup;
  }

  async function warmNeighbours() {
    if (state.layout > 1) return;
    const generation = state.generation;
    const queue = state.queue;
    if (!queue) return;
    const items = (await Promise.all([1, 2, -1, 0].map(async direction => {
      const index = queue.index + direction;
      if (index < 0 || index >= queue.ids.length) return null;
      try {
        const scene = await getScene(queue.ids[index]);
        const file = scene.files[0];
        const source = scene.sources[0];
        if (!file || file.format !== "mp4" || !source || source.offset) return null;
        return { id: scene.id, url: source.url, size: Number(file.size), seconds: checkpoint(scene),
          signature: [file.id, file.size, file.mod_time].join(":"), current: direction === 0 };
      } catch { return null; }
    }))).filter(Boolean);
    if (generation !== state.generation || state.layout > 1) return;
    const service = buffer || (items.some(item => !item.current) ? await ensureBuffer() : null);
    if (!service || generation !== state.generation || state.layout > 1) return;
    service.pause(document.hidden || state.buffering || !["ready", "playing", "paused"].includes(state.phase));
    service.update(items);
  }

  function play() {
    state.wantsPlay = true;
    if (!state.scene || !state.sourceURL || state.resume)
      return;
    const generation = state.generation;
    video.play().catch(function (error) {
      if (generation !== state.generation || error.name === "AbortError") return;
      if (error.name === "NotAllowedError") {
        state.wantsPlay = false;
        presentFrame();
        phase("ready", "Press Play to start.");
        showControls();
      }
    });
  }

  function setSource(index, seconds) {
    if (readyFrame) video.cancelVideoFrameCallback(readyFrame);
    readyFrame = 0;
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
    player.dataset.frameDecoded = "false";
    state.sourceURL = sourceAt(source, seconds);
    byId("source").value = String(index);
    byId("status").textContent = source.label;
    phase("loading", "Loading video...");
    video.pause();
    video.src = state.sourceURL;
    video.load();
    watchFrame();
    const generation = state.generation;
    state.sourceTimer = setTimeout(function () {
      if (generation === state.generation && state.phase === "loading") {
        phase("error", "Video is taking too long. Choose another quality or retry.");
        showControls();
      }
    }, 20000);
  }

  async function loadScene(transition) {
    cancelTouch();
    if (!transition) resetSwipe();
    saveProgress();
    if (state.scene && !state.fromBeginning && !video.seeking && !video.ended &&
        player.dataset.videoReady === "true" && video.readyState >= 2 && video.videoWidth) {
      const snapshot = document.createElement("canvas");
      drawStill(snapshot, video);
      snapshot.dataset.position = String(checkpoint(state.scene));
      storeStill(state.scene.id, checkpoint(state.scene), Promise.resolve(snapshot));
    }
    const generation = ++state.generation;
    if (readyFrame) video.cancelVideoFrameCallback(readyFrame);
    readyFrame = 0;
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
    player.dataset.frameDecoded = "false";
    positionVideo(0.5);
    video.load();
    phase("loading", "Loading scene...");
    showControls();
    const queue = state.queue;
    const id = queue.ids[queue.index];
    const available = new Set(queue.ids).size;
    if (state.layout > available) setLayout(available >= 2 ? 2 : 1);
    multiview?.primaryChanged(id);
    byId("previous").disabled = state.layout === 1 && queue.index === 0;
    byId("next").disabled = state.layout === 1 && queue.index === queue.ids.length - 1;
    byId("notice").textContent = "";
    try {
      const scene = await getScene(id);
      if (generation !== state.generation) return;
      state.scene = scene;
      state.sources = scene.sources;
      if (!state.sources.length) throw new Error("No playable stream is available. Choose Next.");
      byId("source").textContent = "";
      state.sources.forEach(function (source, index) {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = source.label;
        byId("source").appendChild(option);
      });
      const file = scene.files[0] || {};
      byId("duration").textContent = state.layout > 1 ? "100%" : timeLabel(file.duration);
      byId("seek").max = String(file.duration || 1);
      state.markers = sceneMarkers(scene.scene_markers, Number(file.duration));
      renderMarkers();
      setSource(0, checkpoint(scene));
      warmNeighbours();
      mark("ready");
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
      stills.clear();
      await loadScene();
      if ([2, 4].includes(Number(params.get("layout")))) setLayout(Number(params.get("layout")));
    } catch (error) {
      phase("error", error.message);
      showControls();
    }
  }

  function navigate(direction, transition) {
    if (!state.queue || byId("random").disabled) return;
    if (state.layout > 1 && multiview) { resetSwipe(); multiview.navigate(direction); showControls(); return; }
    const queue = advanceQueue(state.queue, direction);
    if (!queue) {
      returnSwipe();
      byId("notice").textContent =
        direction > 0 ? "End of queue. Press R or Green for another random video." : "First scene in queue.";
      showControls();
      return;
    }
    if (transition) commitSwipe(direction, queue.ids[queue.index]);
    state.queue = queue;
    state.wantsPlay = true;
    loadScene(transition);
  }

  function random() {
    if (!state.queue || byId("random").disabled) return;
    if (state.layout > 1 && multiview) { resetSwipe(); multiview.random(); showControls(); return; }
    const queue = randomQueue(state.queue, Math.random());
    if (!queue) return;
    state.queue = queue;
    state.wantsPlay = true;
    loadScene();
    byId("surface").focus();
  }

  function toggle() {
    if (state.layout > 1 && multiview) { multiview.toggleAll(); showControls(); return; }
    if (byId("toggle").disabled) return;
    if (state.phase === "error") {
      state.wantsPlay = true;
      if (state.queue) loadScene();
      else loadQueue();
    } else if (video.paused && !(state.layout > 1 && state.wantsPlay)) {
      play();
    } else {
      state.wantsPlay = false;
      multiview?.setPlaying(false);
      video.pause();
    }
    byId("surface").focus();
    showControls();
  }

  async function setLayout(count) {
    if (![1, 2, 4].includes(count) || !state.queue || count > new Set(state.queue.ids).size) return;
    cancelTouch();
    endWheel();
    resetSwipe();
    closeMore();
    closeVolume();
    state.layout = count;
    byId("seek").setAttribute("aria-label", count > 1 ? "Seek all videos" : "Seek");
    byId("duration").textContent = count > 1 ? "100%" : timeLabel(Number(state.scene?.files[0]?.duration) || 0);
    byId("delete").hidden = count > 1 || !state.enableDelete;
    byId("delete").disabled = count > 1 || !state.enableDelete || !state.scene;
    renderMarkers();
    player.dataset.layout = String(count);
    byId("fullscreen").disabled = count > 1 &&
      (!player.requestFullscreen && !player.webkitRequestFullscreen ||
       document.fullscreenEnabled === false && document.webkitFullscreenEnabled !== true);
    for (const [size, id] of [[2, "layout-two"], [4, "layout-four"]]) {
      byId(id).setAttribute("aria-pressed", String(count === size));
      byId(id).title = count === size ? "Single video" : size + " videos";
    }
    if (count === 1) params.delete("layout");
    else params.set("layout", String(count));
    history.replaceState(null, "", location.pathname + "?" + params.toString());
    buffer?.pause(count > 1 || document.hidden || state.buffering);
    showControls();
    if (count > 1 && !multiviewSetup) {
      const url = new URL("./multiview.js", import.meta.url);
      url.search = new URL(import.meta.url).search;
      multiviewSetup = import(url.href).then(module => {
        multiview = module.createMultiview({
          root: byId("views"),
          primaryController: {
            node: byId("primary-view"), video,
            setPlaying(value) {
              state.wantsPlay = value;
              if (value && state.phase === "error") loadScene();
              else if (value) play();
              else video.pause();
            },
          },
          openPrimary(id) {
            state.queue = { ...state.queue, index: state.queue.ids.indexOf(id) };
            state.wantsPlay = true;
            loadScene();
          },
          changed: () => setBuffering(state.buffering),
          ids: () => state.queue.ids,
          primary: () => state.queue.ids[state.queue.index],
          getScene, checkpoint, sourceAt, truncatedWebmFallback,
          retryIcon: byId("toggle").querySelector(".icon-rotate-ccw"),
          loadingIcon: byId("toggle").querySelector(".icon-loader-circle"),
          played: id => api("mutation TVPlayed($id:ID!){sceneIncrementPlayCount(id:$id)}", { id }).catch(() => {}),
          save: (scene, resume, duration, keepalive) => {
            if (!state.fromBeginning) positions.set(scene.id, resume);
            scene.resume_time = resume;
            const write = () => api(
              "mutation TVActivity($id:ID!,$resume:Float!,$duration:Float!){sceneSaveActivity(id:$id,resume_time:$resume,playDuration:$duration)}",
              { id: scene.id, resume, duration }, keepalive, 45000);
            activity = (keepalive ? Promise.all([activity.catch(() => {}), write()]) :
              activity.catch(() => {}).then(write)).catch(() => {
                byId("notice").textContent = "Resume position could not be saved.";
              });
          },
        });
      }).catch(() => {
        multiviewSetup = null;
        setLayout(1);
        byId("notice").textContent = "Multiple videos could not load. Try again.";
      });
    }
    if (multiviewSetup) await multiviewSetup;
    multiview?.suspend(document.hidden);
    multiview?.setPlaying(state.wantsPlay);
    multiview?.setCount(state.layout);
    byId("surface").focus();
    byId("previous").disabled = state.layout === 1 && state.queue.index === 0;
    byId("next").disabled = state.layout === 1 && state.queue.index === state.queue.ids.length - 1;
    if (state.layout === 1) warmNeighbours();
  }

  function seek(seconds, preview, broadcast = true) {
    clearTimeout(state.seekTimer);
    state.seekTarget = null;
    if (byId("seek").disabled || !state.scene || !state.sources.length) return;
    const duration = Number((state.scene.files[0] || {}).duration) || 0;
    const target = Math.max(0, Math.min(seconds, duration));
    if (broadcast && state.layout > 1) multiview?.seekFraction(duration ? target / duration : 0);
    if (preview !== false) {
      showPreview(target);
      scrub.hideTimer = setTimeout(hidePreview, 1500);
    } else hidePreview();
    const source = state.sources[state.sourceIndex];
    const relative = target - state.offset;
    const buffered = [video.buffered, video.seekable].every(function (ranges) {
      for (let i = 0; i < ranges.length; i++)
        if (relative >= ranges.start(i) && relative < ranges.end(i)) return true;
      return false;
    });
    if (source.offset && !buffered) {
      saveProgress();
      setSource(state.sourceIndex, target);
    } else if (video.currentTime !== relative) {
      setBuffering(true);
      video.currentTime = relative;
    }
    byId("seek").value = String(target);
    paintSeek();
    showControls();
  }

  function queueSeek(delta, preview) {
    if (byId("seek").disabled || !state.scene) return;
    if (state.layout > 1) multiview?.seekBy(delta);
    const duration = Number((state.scene.files[0] || {}).duration) || 0;
    state.seekTarget = Math.max(
      0,
      Math.min((state.seekTarget === null ? currentTime() : state.seekTarget) + delta, duration),
    );
    if (preview !== false) showPreview(state.seekTarget);
    else hidePreview();
    scheduleTimeline();
    clearTimeout(state.seekTimer);
    state.seekTimer = setTimeout(function () {
      seek(state.seekTarget, preview, false);
    }, 120);
  }

  async function deleteScene(event) {
    if (byId("delete").disabled || event.detail > 1) return;
    cancelTouch();
    resetSwipe();
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
    stills.delete(id);
    buffer?.update([]);
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
    positions.delete(id);
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

  const surface = byId("surface");
  let touch = null;
  let tap = null;
  let touchClickUntil = 0;
  const wheel = { offset: 0, locked: false, started: false, timer: 0 };

  function endWheel() {
    clearTimeout(wheel.timer);
    if (wheel.started) returnSwipe();
    wheel.offset = 0;
    wheel.started = false;
    wheel.locked = false;
  }

  player.addEventListener("wheel", function (event) {
    if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY) ||
        event.target.closest(".chrome") || touch || !state.queue || byId("random").disabled) return;
    event.preventDefault();
    clearTimeout(wheel.timer);
    if (wheel.locked) {
      wheel.timer = setTimeout(endWheel, 180);
      return;
    }
    if (!wheel.started) { startSwipe(); wheel.started = true; }
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? player.clientHeight : 1;
    wheel.offset -= event.deltaY * scale;
    moveSwipe(wheel.offset);
    const threshold = Math.max(80, Math.min(160, player.clientHeight * 0.18));
    if (Math.abs(wheel.offset) >= threshold) {
      const direction = wheel.offset < 0 ? 1 : -1;
      wheel.started = false;
      wheel.locked = true;
      navigate(direction, true);
      wheel.timer = setTimeout(endWheel, 180);
    } else wheel.timer = setTimeout(endWheel, 180);
  }, { passive: false });
  window.addEventListener("blur", endWheel);
  window.addEventListener("pagehide", endWheel);

  function resetSwipe() {
    clearTimeout(swipe.timer);
    cancelAnimationFrame(swipe.frame);
    swipe.frame = 0;
    swipe.phase = "idle";
    swipe.offset = 0;
    swipe.origin = 0;
    swipe.backdropOffset = 0;
    swipe.target = null;
    swipe.generation++;
    delete player.dataset.swipePhase;
    video.style.transform = "";
    byId("views").style.transform = "";
    const frame = byId("swipe-outgoing");
    frame.hidden = true;
    frame.style.transform = "";
    frame.style.opacity = "";
    frame.width = frame.height = 0;
    const incoming = byId("swipe-incoming");
    incoming.hidden = true;
    incoming.style.transform = "";
    incoming.width = incoming.height = 0;
  }

  function returnSwipe() {
    if (swipe.phase !== "dragging") return;
    if (reducedMotion()) return resetSwipe();
    swipe.phase = "returning";
    player.dataset.swipePhase = "returning";
    if (state.layout > 1) byId("views").style.transform = "translateY(0px)";
    video.style.transform = "translateY(0px)";
    byId("swipe-outgoing").style.transform = "translateY(" + swipe.backdropOffset + "px)";
    byId("swipe-incoming").style.transform = "translateY(" + swipe.direction * swipe.height + "px)";
    swipe.timer = setTimeout(function () { resetSwipe(); showControls(); }, 180);
  }

  function startSwipe() {
    if (state.layout > 1) {
      resetSwipe();
      swipe.phase = "dragging";
      player.dataset.swipePhase = "dragging";
      return;
    }
    clearTimeout(swipe.timer);
    cancelAnimationFrame(swipe.frame);
    swipe.frame = 0;
    const frame = byId("swipe-outgoing");
    if (swipe.phase === "loading") {
      const incoming = byId("swipe-incoming");
      if (incoming.width) drawStill(frame, incoming);
      else frame.width = frame.height = 0;
      frame.style.objectPosition = incoming.style.objectPosition;
      frame.hidden = false;
      frame.style.transform = "translateY(0px)";
      frame.style.opacity = "1";
      video.style.transform = "translateY(0px)";
      swipe.target = null;
      swipe.generation++;
    }
    swipe.origin = new DOMMatrix(getComputedStyle(video).transform).m42;
    swipe.backdropOffset = frame.hidden ? 0
      : new DOMMatrix(getComputedStyle(frame).transform).m42 - swipe.origin;
    swipe.phase = "dragging";
    player.dataset.swipePhase = "dragging";
    video.style.transform = "translateY(" + swipe.origin + "px)";
    frame.style.transform = "translateY(" + (swipe.origin + swipe.backdropOffset) + "px)";
  }

  function moveSwipe(offset) {
    if (state.layout > 1) {
      swipe.phase = "dragging";
      player.dataset.swipePhase = "dragging";
      swipe.offset = Math.max(-player.clientHeight, Math.min(player.clientHeight, offset));
      if (!reducedMotion()) byId("views").style.transform = "translateY(" + swipe.offset + "px)";
      return;
    }
    swipe.phase = "dragging";
    player.dataset.swipePhase = "dragging";
    swipe.height = byId("primary-view").clientHeight;
    const direction = offset < 0 ? 1 : -1;
    const available = state.queue && advanceQueue(state.queue, direction);
    if (available) prepareIncoming(available.ids[available.index], direction);
    else byId("swipe-incoming").hidden = true;
    const limit = swipe.height * 0.1;
    const drag = available ? offset : offset / (1 + Math.abs(offset) / limit);
    swipe.offset = Math.max(-swipe.height, Math.min(swipe.height, swipe.origin + drag));
    video.style.transform = "translateY(" + swipe.offset + "px)";
    byId("swipe-outgoing").style.transform = "translateY(" + (swipe.offset + swipe.backdropOffset) + "px)";
    byId("swipe-incoming").style.transform = "translateY(" + (swipe.offset + direction * swipe.height) + "px)";
  }

  function prepareIncoming(id, direction) {
    swipe.direction = direction;
    swipe.height = byId("primary-view").clientHeight;
    if (swipe.target === id) return;
    swipe.target = id;
    const generation = ++swipe.generation;
    const incoming = byId("swipe-incoming");
    incoming.width = incoming.height = 0;
    incoming.style.objectPosition = "50% 50%";
    incoming.hidden = false;
    getStill(id).then(function (frame) {
      if (frame && generation === swipe.generation) drawStill(incoming, frame);
    });
  }

  function commitSwipe(direction, id) {
    clearTimeout(swipe.timer);
    cancelAnimationFrame(swipe.frame);
    const reduce = reducedMotion();
    const frame = byId("swipe-outgoing");
    const incoming = byId("swipe-incoming");
    if (video.readyState >= 2 && video.videoWidth && player.dataset.videoReady === "true") {
      drawStill(frame, video);
      frame.style.objectPosition = video.style.objectPosition;
    } else if (swipe.phase !== "dragging" && incoming.width) {
      drawStill(frame, incoming);
      frame.style.objectPosition = incoming.style.objectPosition;
    }
    frame.hidden = false;
    frame.style.opacity = "1";
    frame.style.transform = "translateY(" + swipe.offset + "px)";
    prepareIncoming(id, direction);
    incoming.style.transform = "translateY(" + (reduce ? 0 : swipe.offset + direction * swipe.height) + "px)";
    video.style.transform = "translateY(0px)";
    frame.getBoundingClientRect();
    swipe.phase = reduce ? "fading" : "settling";
    player.dataset.swipePhase = swipe.phase;
    swipe.frame = requestAnimationFrame(function () {
      swipe.frame = 0;
      incoming.style.transform = "translateY(0px)";
      if (swipe.phase === "fading") frame.style.opacity = "0";
      else frame.style.transform = "translateY(" + -direction * swipe.height + "px)";
      swipe.timer = setTimeout(function () {
        if (player.dataset.videoReady === "true") resetSwipe();
        else {
          swipe.phase = "loading";
          player.dataset.swipePhase = "loading";
          frame.hidden = true;
          swipe.offset = swipe.origin = swipe.backdropOffset = 0;
        }
        showControls();
      }, 180);
    });
  }

  function settleSwipe() {
    if (swipe.phase === "loading") resetSwipe();
  }

  function presentFrame() {
    if (video.seeking || video.readyState < 2 || state.resume) return;
    player.dataset.frameDecoded = "true";
    if ((video.paused && !state.wantsPlay) || (!video.paused && !video.requestVideoFrameCallback)) {
      if (readyFrame) video.cancelVideoFrameCallback(readyFrame);
      readyFrame = 0;
      player.dataset.videoReady = "true";
      settleSwipe();
      return;
    }
    watchFrame();
  }

  function watchFrame() {
    if (!video.requestVideoFrameCallback) return;
    if (readyFrame) return;
    const generation = state.generation;
    readyFrame = video.requestVideoFrameCallback(function (_, metadata) {
      readyFrame = 0;
      if (generation !== state.generation || video.currentSrc !== state.sourceURL) return;
      if (state.resume || Math.abs(metadata.mediaTime - video.currentTime) > 0.15) { watchFrame(); return; }
      player.dataset.frameDecoded = "true";
      player.dataset.videoReady = "true";
      settleSwipe();
    });
  }

  function clearSeekFeedback() {
    clearTimeout(seekFeedback.timer);
    clearTimeout(seekFeedback.pulseTimer);
    seekFeedback.side = 0;
    seekFeedback.until = 0;
    byId("seek-ripple").style.opacity = "0";
    byId("seek-ripple").style.transform = "scale(0.95)";
    byId("seek-feedback").hidden = true;
  }

  function touchSeek(side, x, y) {
    const now = performance.now();
    seekFeedback.seconds = seekFeedback.side === side && now < seekFeedback.until
      ? seekFeedback.seconds + 10 : 10;
    seekFeedback.side = side;
    seekFeedback.until = now + 650;
    const feedback = byId("seek-feedback");
    feedback.dataset.side = side > 0 ? "forward" : "backward";
    feedback.hidden = false;
    byId("seek-feedback-time").textContent = seekFeedback.seconds + " seconds";
    const bounds = feedback.getBoundingClientRect();
    const ripple = byId("seek-ripple");
    ripple.style.left = x - bounds.left + "px";
    ripple.style.top = y - bounds.top + "px";
    ripple.style.opacity = "0.16";
    ripple.style.transform = "scale(1.04)";
    clearTimeout(seekFeedback.pulseTimer);
    seekFeedback.pulseTimer = setTimeout(function () {
      ripple.style.opacity = "0";
      ripple.style.transform = "scale(1.08)";
    }, 80);
    clearTimeout(seekFeedback.timer);
    seekFeedback.timer = setTimeout(clearSeekFeedback, 650);
    queueSeek(side * 10, false);
  }

  function cancelTap() {
    if (tap) clearTimeout(tap.timer);
    tap = null;
  }

  function positionVideo(position) {
    if (state.layout > 1) return;
    pan = Math.max(0, Math.min(1, position));
    const value = pan * 100 + "% 50%";
    video.style.objectPosition = value;
    byId("swipe-incoming").style.objectPosition = value;
  }

  function panVideo(dx, contact) {
    positionVideo(contact.pan - dx / contact.overflow);
  }

  function cancelTouch() {
    if (touch) {
      clearTimeout(touch.timer);
      if (touch.phase === "holding") video.playbackRate = touch.rate;
      touch = null;
    }
    byId("gesture-feedback").hidden = true;
    clearSeekFeedback();
    cancelTap();
    returnSwipe();
  }

  surface.addEventListener("pointerdown", function (event) {
    if (event.pointerType !== "touch") return;
    if (!event.isPrimary || touch) return;
    touchClickUntil = performance.now() + 1000;
    if (surface.disabled) {
      cancelTouch();
      return;
    }
    event.preventDefault();
    surface.setPointerCapture(event.pointerId);
    const frame = player.dataset.videoReady === "true" ? video : byId("swipe-incoming");
    const width = frame.videoWidth || frame.width;
    const height = frame.videoHeight || frame.height;
    const overflow = player.dataset.fit === "cover" && width && height
      ? Math.max(0, width * Math.max(player.clientWidth / width, player.clientHeight / height) - player.clientWidth)
      : 0;
    touch = {
      id: event.pointerId, x: event.clientX, y: event.clientY,
      phase: "pending", rate: video.playbackRate, timer: 0, time: performance.now(),
      pan: pan, overflow: overflow,
    };
    touch.timer = setTimeout(function () {
      if (!touch || touch.phase !== "pending" || video.paused) return;
      cancelTap();
      touch.phase = "holding";
      video.playbackRate = 2;
      byId("gesture-feedback").hidden = false;
    }, 200);
  });
  surface.addEventListener("pointermove", function (event) {
    if (!touch || touch.id !== event.pointerId) return;
    const dx = event.clientX - touch.x;
    const dy = event.clientY - touch.y;
    if (touch.phase === "swiping") { moveSwipe(dy); return; }
    if (touch.phase === "panning") { panVideo(dx, touch); return; }
    if (Math.hypot(dx, dy) <= 12 || touch.phase !== "pending") return;
    clearTimeout(touch.timer);
    cancelTap();
    touch.phase = Math.abs(dy) > Math.abs(dx) * 1.5 ? "swiping"
      : touch.overflow > 0 && Math.abs(dx) > Math.abs(dy) * 1.5 ? "panning" : "moving";
    if (touch.phase === "swiping") { startSwipe(); moveSwipe(dy); }
    if (touch.phase === "panning") panVideo(dx, touch);
  });
  surface.addEventListener("pointerup", function (event) {
    if (!touch || touch.id !== event.pointerId) return;
    event.preventDefault();
    touchClickUntil = performance.now() + 1000;
    const ended = touch;
    clearTimeout(ended.timer);
    touch = null;
    if (ended.phase === "holding") {
      video.playbackRate = ended.rate;
      byId("gesture-feedback").hidden = true;
      return;
    }
    const dx = event.clientX - ended.x;
    const dy = event.clientY - ended.y;
    if (ended.phase === "panning") {
      cancelTap();
      panVideo(dx, ended);
      return;
    }
    if (ended.phase === "swiping" || ended.phase === "moving" || Math.hypot(dx, dy) > 12) {
      cancelTap();
      const distance = Math.abs(dy);
      const velocity = distance / Math.max(1, performance.now() - ended.time);
      const threshold = Math.max(64, Math.min(120, player.clientHeight * 0.12));
      if (ended.phase === "swiping" && (distance >= threshold || (distance >= 32 && velocity > 0.11)))
        navigate(dy < 0 ? 1 : -1, true);
      else returnSwipe();
      return;
    }
    const bounds = surface.getBoundingClientRect();
    const fraction = (ended.x - bounds.left) / bounds.width;
    const side = fraction < 0.35 ? -1 : fraction > 0.65 ? 1 : 0;
    const now = performance.now();
    if (side && seekFeedback.side === side && now < seekFeedback.until) {
      cancelTap();
      touchSeek(side, ended.x, ended.y);
      return;
    }
    if (tap && now - tap.time < 300 && side && tap.side === side) {
      const started = tap.started;
      cancelTap();
      if (started) { state.wantsPlay = false; multiview?.setPlaying(false); video.pause(); }
      touchSeek(side, ended.x, ended.y);
      return;
    }
    if (tap) {
      const pending = tap;
      cancelTap();
      if (!pending.started) toggle();
    }
    // iOS requires play() during the touch event, before a double-tap timer expires.
    const started = video.paused;
    if (started) toggle();
    tap = { time: now, side: side, started: started, timer: setTimeout(function () {
      const pending = tap;
      tap = null;
      if (pending && !pending.started) toggle();
    }, 300) };
  });
  surface.addEventListener("pointercancel", cancelTouch);
  surface.addEventListener("lostpointercapture", function () {
    if (touch) cancelTouch();
  });
  surface.addEventListener("contextmenu", function (event) {
    if (touch || performance.now() < touchClickUntil) event.preventDefault();
  });
  window.addEventListener("blur", cancelTouch);
  window.addEventListener("pagehide", cancelTouch);
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) { cancelTouch(); endWheel(); }
    multiview?.suspend(document.hidden);
    buffer?.pause(state.layout > 1 || document.hidden || state.buffering || !["ready", "playing", "paused"].includes(state.phase));
    if (!document.hidden) warmNeighbours();
  });
  window.addEventListener("pagehide", function (event) {
    buffer?.pause(true);
    if (event.persisted) multiview?.suspend(true);
    else { multiview?.dispose(true); multiview = null; multiviewSetup = null; }
    if (!event.persisted) { buffer?.update([]); buffer?.dispose(); }
  });
  window.addEventListener("pageshow", function (event) {
    if (event.persisted) multiview?.suspend(document.hidden);
    if (event.persisted) warmNeighbours();
  });

  // Handle touch controls directly; a preceding drag can suppress compatibility clicks.
  let controlTouch = null;
  let controlClickUntil = 0;
  const controls = player.querySelector("nav");
  controls.addEventListener("pointerdown", function (event) {
    const button = event.target.closest("button");
    if (event.pointerType === "touch" && event.isPrimary && button && !button.disabled)
      controlTouch = { button: button, id: event.pointerId, x: event.clientX, y: event.clientY };
  });
  controls.addEventListener("pointerup", function (event) {
    const contact = controlTouch;
    controlTouch = null;
    if (!contact || contact.id !== event.pointerId ||
        event.target.closest("button") !== contact.button ||
        Math.hypot(event.clientX - contact.x, event.clientY - contact.y) > 12) return;
    event.preventDefault();
    controlClickUntil = performance.now() + 700;
    contact.button.click();
  });
  controls.addEventListener("pointercancel", function () { controlTouch = null; });
  controls.addEventListener("click", function (event) {
    if (event.detail !== 0 && performance.now() < controlClickUntil) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  byId("toggle").onclick = toggle;
  byId("surface").onclick = function (event) {
    if (event.detail !== 0 && performance.now() < touchClickUntil) return;
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
  for (const [count, id] of [[2, "layout-two"], [4, "layout-four"]]) byId(id).onclick = () => {
    const target = state.layout === count ? 1 : count;
    setLayout(target);
    if (target > 1) play();
  };
  byId("delete").onclick = deleteScene;
  function updateScrub(event) {
    const range = byId("seek");
    const bounds = range.getBoundingClientRect();
    range.value = String(seekPosition(event.clientX, bounds.left, bounds.width, Number(range.max)));
    paintSeek();
    byId("elapsed").textContent = timelineLabel(Number(range.value));
    showPreview(Number(range.value));
  }

  function finishScrub(commit) {
    if (scrub.pointerId === null) return;
    const range = byId("seek");
    const id = scrub.pointerId;
    const target = Number(range.value);
    scrub.pointerId = null;
    scrub.dragging = false;
    if (range.hasPointerCapture(id)) range.releasePointerCapture(id);
    if (commit) seek(target);
    else { hidePreview(); scheduleTimeline(); }
  }

  byId("seek").addEventListener("pointerdown", function (event) {
    if (!event.isPrimary || this.disabled || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    finishScrub(false);
    clearTimeout(state.seekTimer);
    state.seekTarget = null;
    scrub.pointerId = event.pointerId;
    scrub.dragging = true;
    this.setPointerCapture(event.pointerId);
    updateScrub(event);
  });
  byId("seek").addEventListener("pointermove", function (event) {
    if (scrub.pointerId !== null) {
      if (event.pointerId === scrub.pointerId) updateScrub(event);
      return;
    }
    if (event.pointerType === "touch") return;
    const bounds = this.getBoundingClientRect();
    showPreview(seekPosition(event.clientX, bounds.left, bounds.width, Number(this.max)));
  });
  byId("seek").addEventListener("pointerleave", function () {
    if (!scrub.dragging) hidePreview();
  });
  document.addEventListener("pointerup", function (event) {
    if (event.pointerId !== scrub.pointerId) return;
    event.preventDefault();
    updateScrub(event);
    finishScrub(true);
  });
  byId("seek").addEventListener("pointercancel", function (event) {
    if (event.pointerId === scrub.pointerId) finishScrub(false);
  });
  byId("seek").addEventListener("lostpointercapture", function (event) {
    if (event.pointerId === scrub.pointerId) finishScrub(false);
  });
  window.addEventListener("blur", function () { finishScrub(false); });
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) finishScrub(false);
  });
  byId("seek").oninput = function () {
    paintSeek();
    byId("elapsed").textContent = timelineLabel(Number(this.value));
    showPreview(Number(this.value));
  };
  byId("seek").onchange = function () {
    seek(Number(this.value));
  };
  function closeMore() {
    byId("more-panel").hidden = true;
    byId("more").setAttribute("aria-expanded", "false");
  }
  byId("more").onclick = function () {
    const open = byId("more-panel").hidden;
    closeVolume();
    byId("more-panel").hidden = !open;
    byId("more").setAttribute("aria-expanded", String(open));
    showControls();
  };
  byId("more-panel").addEventListener("click", function (event) {
    if (event.target.closest("button")) { closeMore(); showControls(); }
  });
  document.addEventListener("pointerdown", function (event) {
    if (!event.target.closest(".more-controls")) closeMore();
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !byId("more-panel").hidden) {
      event.stopImmediatePropagation(); closeMore(); byId("more").focus(); showControls();
    }
  });
  function closeVolume() {
    const open = !byId("volume-panel").hidden;
    byId("volume-panel").hidden = true;
    byId("mute").setAttribute("aria-expanded", "false");
    if (open) showControls();
  }
  byId("mute").onclick = function () {
    if (matchMedia("(pointer: coarse)").matches) { toggleMute(); return; }
    closeMore();
    const open = byId("volume-panel").hidden;
    byId("volume-panel").hidden = !open;
    byId("mute").setAttribute("aria-expanded", String(open));
    showControls();
  };
  byId("zoom").onclick = function () {
    const fill = player.dataset.fit !== "cover";
    player.dataset.fit = fill ? "cover" : "contain";
    positionVideo(0.5);
    const label = fill ? "Fit video" : "Fill screen";
    byId("zoom").setAttribute("aria-pressed", String(fill));
    byId("zoom").setAttribute("aria-label", label);
    byId("zoom").title = label;
    showControls();
  };
  document.addEventListener("pointerdown", function (event) {
    if (!event.target.closest(".volume-controls")) closeVolume();
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !byId("volume-panel").hidden) {
      event.stopImmediatePropagation();
      closeVolume();
      byId("mute").focus();
    }
  });
  function toggleMute() {
    if (video.muted || video.volume === 0) {
      if (video.volume === 0) video.volume = 1;
      video.muted = false;
    } else video.muted = true;
    updateVolume();
    if (!video.muted && state.wantsPlay) { play(); multiview?.setPlaying(true); }
  }
  byId("volume-mute").onclick = toggleMute;
  byId("volume").oninput = function () {
    video.volume = Number(this.value) / 100;
    video.muted = video.volume === 0;
  };
  video.addEventListener("volumechange", updateVolume);
  video.addEventListener("ratechange", () => multiview?.setRate(video.playbackRate));
  matchMedia("(pointer: coarse)").addEventListener?.("change", updateVolume);
  updateVolume();
  byId("source").onchange = function () {
    saveProgress();
    setSource(Number(this.value), currentTime());
  };
  byId("fullscreen").onclick = function () {
    if (fullscreen()) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (video.webkitDisplayingFullscreen && video.webkitExitFullscreen) video.webkitExitFullscreen();
      else if (exit) exit.call(document);
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
  setInterval(function () {
    if (!document.hidden && !state.buffering && ["ready", "playing", "paused"].includes(state.phase)) warmNeighbours();
  }, 30000);
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
        video.readyState < 2
      )
        return;
      presentFrame();
      if (state.phase === "loading") warmNeighbours();
      if (state.phase === "loading") {
        if (state.wantsPlay) play();
        else phase("ready", "Press Play to start.");
      } else setBuffering(false);
    });
  });
  function onPlaying() {
    if (!state.scene || video.currentSrc !== state.sourceURL) return;
    clearTimeout(state.sourceTimer);
    presentFrame();
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
  }
  video.addEventListener("playing", onPlaying);
  video.addEventListener("pause", function () {
    if (touch && touch.phase === "holding") cancelTouch();
    if (!state.wantsPlay && state.scene && video.currentSrc === state.sourceURL) presentFrame();
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
  video.addEventListener("timeupdate", function () {
    scheduleTimeline();
    if (!state.scene || video.currentSrc !== state.sourceURL || state.resume ||
        video.paused || video.ended || video.seeking || video.readyState < 2) return;
    if (["loading", "ready", "paused"].includes(state.phase)) {
      presentFrame();
      onPlaying();
    } else if (state.phase === "playing" && state.buffering) setBuffering(false);
  });
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
  player.addEventListener("pointerdown", function (event) {
    if (!event.isPrimary) return;
    if (event.target !== surface) cancelTouch();
    showControls();
  });
  player.addEventListener("click", function (event) {
    if (event.target === player || event.target === video) {
      mark("click_toggle");
      toggle();
    }
  });
  player.addEventListener("dblclick", function (event) {
    if (performance.now() >= touchClickUntil &&
        (event.target === video || event.target === byId("surface"))) enterFullscreen();
  });
  video.addEventListener("webkitbeginfullscreen", updateFullscreen);
  video.addEventListener("webkitendfullscreen", updateFullscreen);
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
    if (([byId("mute"), byId("volume-mute")].includes(event.target) &&
         (event.key === " " || event.keyCode === 32)) ||
        ([byId("layout-two"), byId("layout-four")].includes(event.target) &&
         (event.key === " " || event.key === "Enter"))) {
      event.preventDefault();
      if (!event.repeat) event.target.click();
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
    if (action.type === "navigate") {
      if (!event.repeat) {
        mark(action.direction > 0 ? "key_next" : "key_previous");
        navigate(action.direction, true);
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
