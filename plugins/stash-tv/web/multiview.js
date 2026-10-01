export function randomScenes(ids, count, excluded, random = Math.random) {
  const pool = [...new Set(ids)].filter(id => !excluded.includes(id));
  const selected = [];
  while (pool.length && selected.length < count) {
    selected.push(pool.splice(Math.min(pool.length - 1, Math.floor(random() * pool.length)), 1)[0]);
  }
  return selected;
}

export function createMultiview(options) {
  const slots = [];
  let wantsPlay = false;
  let suspended = false;

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
    if (!wantsPlay || suspended || !slot.scene || slot.resume || slot.phase === "error") return;
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
      slot.cover.hidden = true;
    }
    if ((!wantsPlay && video.paused) || !video.requestVideoFrameCallback) reveal();
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
    video.muted = video.defaultMuted = true;
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
      offset: 0, resume: 0, url: "", phase: "loading", counted: false, playedAt: 0, timer: 0, frame: 0 };
    retry.onclick = () => {
      if (!slot.scene) load(slot, slot.id);
      else if (retry.dataset.action === "play") { slot.phase = "ready"; slot.retry.hidden = true; play(slot); }
      else source(slot, slot.index, video.currentTime + slot.offset || slot.resume);
    };
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
    });
    for (const event of ["waiting", "seeking"]) video.addEventListener(event, () => {
      if (!slot.scene || video.currentSrc !== slot.url || slot.phase === "error") return;
      slot.phase = "loading";
      slot.node.dataset.phase = "loading";
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
    });
    video.addEventListener("pause", () => save(slot));
    function recover() {
      if (!slot.scene || video.currentSrc !== slot.url || slot.phase === "error") return false;
      const next = options.truncatedWebmFallback(slot.scene.sources, slot.index, slot.offset,
        Number(slot.scene.files[0]?.duration), video.duration);
      if (next < 0) return false;
      source(slot, next, video.currentTime + slot.offset);
      return true;
    }
    video.addEventListener("durationchange", recover);
    video.addEventListener("ended", () => { if (!recover()) replacement(slot); });
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
    ++slot.generation;
    cancelFrame(slot);
    clearTimeout(slot.timer);
    slot.scene = null;
    slot.video.pause();
    slot.video.removeAttribute("src");
    slot.video.load();
    slot.node.remove();
  }

  const progress = setInterval(() => slots.forEach(slot => save(slot)), 15000);
  return {
    setCount(count) {
      while (slots.length > count - 1) unmount(slots.pop());
      while (slots.length < count - 1) {
        const slot = mount();
        replacement(slot);
      }
    },
    setPlaying(value) {
      wantsPlay = value;
      slots.forEach(slot => {
        if (value && !suspended) {
          if (slot.phase === "error" && slot.retry.dataset.action === "play") {
            slot.phase = "ready";
            slot.retry.hidden = true;
          }
          play(slot);
        }
        else { slot.video.pause(); present(slot); }
      });
    },
    suspend(value) {
      suspended = value;
      slots.forEach(slot => { if (value) slot.video.pause(); else play(slot); });
    },
    primaryChanged(id) {
      slots.filter(slot => slot.id === id).forEach(replacement);
    },
    shuffle() {
      const ids = randomScenes(options.ids(), slots.length, [options.primary()]);
      slots.forEach((slot, index) => load(slot, ids[index]));
    },
    dispose(keepalive) {
      clearInterval(progress);
      while (slots.length) unmount(slots.pop(), keepalive);
    },
  };
}
