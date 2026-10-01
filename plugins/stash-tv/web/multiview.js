import { mountFrameFill } from "./frame-fill.js";

export function randomScenes(ids, count, excluded, random = Math.random) {
  const pool = [...new Set(ids)].filter(id => !excluded.includes(id));
  const selected = [];
  while (pool.length && selected.length < count) {
    selected.push(pool.splice(Math.min(pool.length - 1, Math.floor(random() * pool.length)), 1)[0]);
  }
  return selected;
}

export function createGridQueue(ids, current) {
  return { pool: [...new Set(ids)], history: [current.slice()], cursor: 0 };
}

function appendGrid(queue, snapshot) {
  const history = [...queue.history.slice(0, queue.cursor + 1), snapshot].slice(-100);
  return { ...queue, history, cursor: history.length - 1 };
}

export function advanceGrid(queue, direction) {
  const cursor = queue.cursor + direction;
  if (cursor >= 0 && cursor < queue.history.length) return { ...queue, cursor };
  const current = queue.history[queue.cursor];
  const next = current.map(id => queue.pool[(queue.pool.indexOf(id) + direction + queue.pool.length) % queue.pool.length]);
  if (direction > 0) return appendGrid(queue, next);
  return { ...queue, history: [next, ...queue.history].slice(0, 100), cursor: 0 };
}

export function randomGrid(queue, random = Math.random) {
  const current = queue.history[queue.cursor];
  for (let attempt = 0; attempt < 64; attempt++) {
    const next = randomScenes(queue.pool, current.length, [], random);
    if (next.every((id, index) => id !== current[index])) return appendGrid(queue, next);
  }
  const next = current.map(id => queue.pool[(queue.pool.indexOf(id) + 1) % queue.pool.length]);
  return appendGrid(queue, next);
}

export function createMultiview(options) {
  const slots = [];
  let defaultPlaying = false;
  let suspended = false;
  let primaryFill = null;
  let queue = null;
  let audio = { volume: options.primaryController.video.volume, muted: options.primaryController.video.muted };
  let rate = options.primaryController.video.playbackRate;

  function groupPlaying(value) {
    options.primaryController.setPlaying(value);
    setPlaying(value);
  }
  function toggleAll() {
    groupPlaying([options.primaryController.video, ...slots.map(slot => slot.video)].every(video => video.paused));
  }
  function open(snapshot) {
    defaultPlaying = true;
    slots.forEach((slot, index) => { slot.wantsPlay = true; load(slot, snapshot[index + 1]); });
    options.openPrimary(snapshot[0]);
  }
  function navigate(direction) {
    queue = advanceGrid(queue, direction);
    open(queue.history[queue.cursor]);
  }
  function random() {
    queue = randomGrid(queue);
    open(queue.history[queue.cursor]);
  }
  function position(slot) {
    return slot.resume || slot.video.currentTime + slot.offset;
  }
  function seekSlot(slot, seconds) {
    if (!slot.scene) return;
    const duration = Number(slot.scene.files[0]?.duration) || 0;
    const target = Math.max(0, Math.min(seconds, Math.max(0, duration - 0.1)));
    const relative = target - slot.offset;
    const stream = slot.scene.sources[slot.index];
    const buffered = [slot.video.buffered, slot.video.seekable].every(ranges => {
      for (let i = 0; i < ranges.length; i++) if (relative >= ranges.start(i) && relative < ranges.end(i)) return true;
      return false;
    });
    if (stream.offset && !buffered) { save(slot); source(slot, slot.index, target); }
    else if (slot.video.readyState < 1) slot.resume = target;
    else slot.video.currentTime = relative;
  }

  function save(slot, keepalive) {
    const video = slot.video;
    if (!slot.scene || !slot.counted || video.seeking || video.readyState < 2) return;
    const now = performance.now();
    const resume = video.ended ? 0 : video.currentTime + slot.offset;
    const duration = slot.playedAt ? Math.max(0, (now - slot.playedAt) / 1000) : 0;
    slot.playedAt = video.paused ? 0 : now;
    options.save(slot.scene, resume, duration, keepalive);
  }

  function play(slot) {
    if (!slot.wantsPlay || suspended || !slot.scene || slot.resume || slot.phase === "error") return;
    const generation = slot.generation;
    slot.video.play().catch(error => {
      if (generation !== slot.generation || error.name === "AbortError") return;
      fail(slot, error.name === "NotAllowedError" ? "Tap to play this video" : "Retry video", error.name === "NotAllowedError");
    });
  }

  function fail(slot, label, playOnly = false) {
    clearTimeout(slot.timer);
    slot.phase = "error";
    slot.node.dataset.phase = "error";
    slot.retry.setAttribute("aria-label", label);
    slot.retry.title = label;
    slot.retry.dataset.action = playOnly ? "play" : "reload";
    slot.retry.hidden = false;
    options.changed();
  }

  function retrySlot(slot) {
    if (!slot.scene) load(slot, slot.id);
    else if (slot.retry.dataset.action === "play") { slot.phase = "ready"; slot.retry.hidden = true; play(slot); }
    else source(slot, slot.index, slot.video.currentTime + slot.offset || slot.resume);
  }

  function cancelFrame(slot) {
    if (slot.frame) slot.video.cancelVideoFrameCallback(slot.frame);
    slot.frame = 0;
  }

  function present(slot) {
    const video = slot.video;
    if (!slot.scene || video.currentSrc !== slot.url || slot.resume || video.seeking || video.readyState < 2) return;
    const generation = slot.generation;
    function reveal(_, metadata) {
      slot.frame = 0;
      if (generation !== slot.generation || video.seeking || video.currentSrc !== slot.url) return;
      if (slot.resume || video.readyState < 2 || metadata && Math.abs(metadata.mediaTime - video.currentTime) > 0.15) {
        present(slot);
        return;
      }
      slot.node.dataset.decoded = "true";
      slot.fill?.refresh();
      slot.cover.hidden = true;
    }
    if ((!slot.wantsPlay && video.paused) || !video.requestVideoFrameCallback) reveal();
    else if (!slot.frame) slot.frame = video.requestVideoFrameCallback(reveal);
  }

  function source(slot, index, seconds) {
    ++slot.generation;
    cancelFrame(slot);
    clearTimeout(slot.timer);
    slot.index = index;
    const stream = slot.scene.sources[index];
    const duration = Number(slot.scene.files[0]?.duration) || 0;
    seconds = Math.max(0, Math.min(seconds, Math.max(0, duration - 0.1)));
    slot.offset = stream.offset ? seconds : 0;
    slot.resume = stream.offset ? 0 : seconds;
    slot.url = options.sourceAt(stream, seconds);
    slot.phase = "loading";
    slot.node.dataset.phase = "loading";
    slot.node.dataset.decoded = "false";
    slot.retry.hidden = true;
    slot.video.pause();
    slot.video.src = slot.url;
    slot.video.load();
    options.changed();
    const generation = slot.generation;
    slot.timer = setTimeout(() => {
      if (generation === slot.generation && slot.phase === "loading") fail(slot, "Retry video");
    }, 20000);
  }

  async function load(slot, id) {
    save(slot);
    if (slot.video.readyState >= 2 && slot.video.videoWidth && !slot.video.seeking) {
      slot.cover.width = Math.min(1280, slot.video.videoWidth);
      slot.cover.height = Math.round(slot.cover.width * slot.video.videoHeight / slot.video.videoWidth);
      slot.cover.getContext("2d").drawImage(slot.video, 0, 0, slot.cover.width, slot.cover.height);
      slot.cover.hidden = false;
    }
    const generation = ++slot.generation;
    cancelFrame(slot);
    clearTimeout(slot.timer);
    slot.id = id;
    slot.scene = null;
    slot.counted = false;
    slot.playedAt = 0;
    slot.url = "";
    slot.phase = "loading";
    slot.node.dataset.scene = id;
    slot.node.dataset.phase = "loading";
    slot.node.dataset.decoded = "false";
    slot.retry.hidden = true;
    slot.video.pause();
    slot.video.removeAttribute("src");
    slot.video.load();
    try {
      const scene = await options.getScene(id);
      if (generation !== slot.generation) return;
      if (!scene.sources.length) throw new Error("No playable stream");
      slot.scene = scene;
      source(slot, 0, options.checkpoint(scene));
    } catch {
      if (generation === slot.generation) fail(slot, "Retry video");
    }
  }

  function replacement(slot) {
    const excluded = [options.primary(), ...slots.filter(other => other !== slot).map(other => other.id)];
    const ids = randomScenes(options.ids(), 1, [...excluded, slot.id]);
    const id = ids[0] || randomScenes(options.ids(), 1, excluded)[0];
    if (id) load(slot, id);
  }

  function mount() {
    const node = document.createElement("div");
    node.className = "view extra-view";
    const video = document.createElement("video");
    video.playsInline = true;
    video.volume = audio.volume;
    video.muted = video.defaultMuted = audio.muted;
    video.playbackRate = rate;
    video.preload = "metadata";
    video.crossOrigin = "anonymous";
    const cover = document.createElement("canvas");
    cover.hidden = true;
    cover.setAttribute("aria-hidden", "true");
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "tile-retry";
    retry.hidden = true;
    retry.appendChild(options.retryIcon.cloneNode(true));
    const loader = options.loadingIcon.cloneNode(true);
    loader.classList.add("tile-loading");
    node.append(video, cover, loader, retry);
    options.root.appendChild(node);
    const slot = { node, video, cover, retry, id: "", scene: null, index: 0, generation: 0,
      wantsPlay: defaultPlaying, fill: mountFrameFill(node,video),
      offset: 0, resume: 0, url: "", phase: "loading", counted: false, playedAt: 0, timer: 0, frame: 0 };
    retry.onclick = () => groupPlaying(true);
    video.addEventListener("loadedmetadata", () => {
      if (slot.scene && video.currentSrc === slot.url && slot.resume) {
        video.currentTime = slot.resume;
        slot.resume = 0;
      }
    });
    for (const event of ["canplay", "seeked"]) video.addEventListener(event, () => {
      if (!slot.scene || video.currentSrc !== slot.url || slot.resume || video.seeking || video.readyState < 2) return;
      clearTimeout(slot.timer);
      slot.phase = "ready";
      slot.node.dataset.phase = "ready";
      slot.retry.hidden = true;
      present(slot);
      play(slot);
      options.changed();
    });
    for (const event of ["waiting", "seeking"]) video.addEventListener(event, () => {
      if (!slot.scene || video.currentSrc !== slot.url || slot.phase === "error") return;
      slot.phase = "loading";
      slot.node.dataset.phase = "loading";
      options.changed();
    });
    video.addEventListener("playing", () => {
      if (!slot.scene || video.currentSrc !== slot.url) return;
      clearTimeout(slot.timer);
      slot.phase = "playing";
      slot.node.dataset.phase = "playing";
      slot.retry.hidden = true;
      if (!slot.playedAt) slot.playedAt = performance.now();
      if (!slot.counted) { slot.counted = true; options.played(slot.scene.id); }
      present(slot);
      options.changed();
    });
    video.addEventListener("pause", () => { save(slot); options.changed(); });
    function recover() {
      if (!slot.scene || video.currentSrc !== slot.url || slot.phase === "error") return false;
      const next = options.truncatedWebmFallback(slot.scene.sources, slot.index, slot.offset,
        Number(slot.scene.files[0]?.duration), video.duration);
      if (next < 0) return false;
      source(slot, next, video.currentTime + slot.offset);
      return true;
    }
    video.addEventListener("durationchange", recover);
    video.addEventListener("ended", () => { if (!recover()) navigate(1); });
    video.addEventListener("error", () => {
      if (!slot.scene || video.currentSrc !== slot.url) return;
      const next = slot.index + 1;
      if (next < slot.scene.sources.length) source(slot, next, video.currentTime + slot.offset || slot.resume);
      else fail(slot, "Retry video");
    });
    slots.push(slot);
    return slot;
  }

  function unmount(slot, keepalive) {
    save(slot, keepalive);
    slot.fill.dispose();
    ++slot.generation;
    cancelFrame(slot);
    clearTimeout(slot.timer);
    slot.scene = null;
    slot.video.pause();
    slot.video.removeAttribute("src");
    slot.video.load();
    slot.node.remove();
  }

  function setPlaying(value) {
    defaultPlaying = value;
    slots.forEach(slot => {
      slot.wantsPlay = value;
      if (value && !suspended) {
        if (slot.phase === "error") retrySlot(slot);
        else play(slot);
      } else { slot.video.pause(); present(slot); }
    });
    options.changed();
  }

  const progress = setInterval(() => slots.forEach(slot => save(slot)), 15000);
  return {
    toggleAll, navigate, random,
    setCount(count) {
      if (count > 1 && !primaryFill) primaryFill = mountFrameFill(options.primaryController.node, options.primaryController.video);
      if (count === 1 && primaryFill) { primaryFill.dispose(); primaryFill = null; }
      while (slots.length > count - 1) unmount(slots.pop());
      while (slots.length < count - 1) { const slot = mount(); replacement(slot); }
      queue = count > 1 ? createGridQueue(options.ids(), [options.primary(), ...slots.map(slot => slot.id)]) : null;
      primaryFill?.refresh(); slots.forEach(slot => slot.fill.refresh());
      options.changed();
    },
    setPlaying,
    seekBy(delta) { slots.forEach(slot => seekSlot(slot, position(slot) + delta)); },
    seekFraction(fraction) { slots.forEach(slot => seekSlot(slot, fraction * (Number(slot.scene?.files[0]?.duration) || 0))); },
    setAudio(volume, muted) {
      audio = {volume, muted};
      slots.forEach(slot => { slot.video.volume = volume; slot.video.muted = muted; });
    },
    setRate(value) { rate = value; slots.forEach(slot => { slot.video.playbackRate = value; }); },
    loading: () => slots.some(slot => slot.phase === "loading"),
    suspend(value) {
      suspended = value;
      slots.forEach(slot => { if (value) slot.video.pause(); else play(slot); });
    },
    primaryChanged(id) { slots.filter(slot => slot.id === id).forEach(replacement); },
    dispose(keepalive) {
      clearInterval(progress);
      primaryFill?.dispose(); primaryFill = null;
      while (slots.length) unmount(slots.pop(), keepalive);
    },
  };
}
