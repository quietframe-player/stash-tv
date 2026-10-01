import { mountTileControls } from "./tile-controls.js";

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
  let defaultPlaying = false;
  let suspended = false;
  let primaryControls = null, toolbar = null, closeGridMenu = null;
  let selected = null;
  const layoutHomes = options.layoutButtons.map(button => ({ button, parent: button.parentNode, next: button.nextSibling }));
  const controlOptions = {
    ...options.controls,
    activate: select,
    visibility(node, visible) {
      if (node === selected) options.root.parentNode.dataset.gridControls = String(visible);
    },
    selectAudio(video) {
      for (const other of [options.primaryController.video, ...slots.map(slot => slot.video)]) other.muted = other !== video;
      if (video.volume === 0) video.volume = 1;
    },
  };

  function controls() {
    return [{node:options.primaryController.node,ui:primaryControls}, ...slots.map(slot => ({node:slot.node,ui:slot.controls}))];
  }
  function selectedControls() { return controls().find(entry => entry.node === selected)?.ui; }
  function select(node) {
    if (selected === node) return;
    closeGridMenu?.();
    selected = node;
    for (const entry of controls()) {
      entry.node.dataset.selected = String(entry.node === node);
      if (entry.node !== node) entry.ui?.dismiss();
    }
    selectedControls()?.show();
  }

  function groupPlaying(value) {
    options.primaryController.setPlaying(value);
    setPlaying(value);
  }
  function toggleAll() {
    groupPlaying([options.primaryController.video, ...slots.map(slot => slot.video)].every(video => video.paused));
  }
  function renderGroup() {
    if (!toolbar) return;
    const paused = [options.primaryController.video, ...slots.map(slot => slot.video)].every(video => video.paused);
    toolbar.dataset.paused = String(paused);
    const button = toolbar.querySelector(".multiview-toggle");
    button.setAttribute("aria-label", paused ? "Play all videos" : "Pause all videos");
    button.title = button.getAttribute("aria-label");
  }
  function mountPrimary() {
    if (primaryControls) return;
    selected = options.primaryController.node;
    selected.dataset.selected = "true";
    primaryControls = mountTileControls(options.primaryController, controlOptions);
    toolbar = document.createElement("div");
    toolbar.className = "multiview-toolbar";
    toolbar.setAttribute("role", "group");
    toolbar.setAttribute("aria-label", "Multiview layout and group playback");
    const menu = document.createElement("button");
    menu.type = "button";
    menu.className = "multiview-menu-toggle";
    menu.setAttribute("aria-label", "Multiview options");
    menu.setAttribute("aria-expanded", "false");
    menu.appendChild(options.layoutButtons[1].querySelector("svg").cloneNode(true));
    const panel = document.createElement("div");
    panel.className = "multiview-menu";
    panel.hidden = true;
    closeGridMenu = () => {
      panel.hidden = true;
      menu.setAttribute("aria-expanded", "false");
      options.root.parentNode.dataset.gridMenu = "false";
    };
    menu.onclick = () => {
      panel.hidden = !panel.hidden;
      menu.setAttribute("aria-expanded", String(!panel.hidden));
      options.root.parentNode.dataset.gridMenu = String(!panel.hidden);
      if (!panel.hidden) menu.focus({preventScroll:true});
      selectedControls()?.show();
    };
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "multiview-toggle";
    toggle.append(options.controls.icon("play"), options.controls.icon("pause"));
    toggle.onclick = toggleAll;
    panel.append(toggle, ...options.layoutButtons);
    panel.onclick = event => {
      if (!event.target.closest("button")) return;
      closeGridMenu?.(); selectedControls()?.focus();
    };
    toolbar.append(menu, panel);
    toolbar.addEventListener("focusin", () => selectedControls()?.show());
    toolbar.addEventListener("pointermove", () => selectedControls()?.show());
    toolbar.addEventListener("keydown", event => {
      if (event.key === "Escape" && !panel.hidden) {
        event.preventDefault(); event.stopPropagation(); closeGridMenu?.(); menu.focus();
      }
    });
    options.root.parentNode.appendChild(toolbar);
    document.addEventListener("pointerdown", dismissGridMenu);
    options.primaryController.video.addEventListener("playing", renderGroup);
    options.primaryController.video.addEventListener("pause", renderGroup);
    renderGroup();
  }
  function dismissGridMenu(event) {
    if (!toolbar?.contains(event.target)) closeGridMenu?.();
  }
  function unmountPrimary() {
    if (!primaryControls) return;
    primaryControls.dispose(); primaryControls = null;
    selected = null;
    delete options.primaryController.node.dataset.selected;
    delete options.root.parentNode.dataset.gridControls;
    delete options.root.parentNode.dataset.gridMenu;
    document.removeEventListener("pointerdown", dismissGridMenu);
    closeGridMenu = null;
    options.primaryController.video.removeEventListener("playing", renderGroup);
    options.primaryController.video.removeEventListener("pause", renderGroup);
    for (const { button, parent, next } of [...layoutHomes].reverse()) parent.insertBefore(button, next?.parentNode === parent ? next : null);
    toolbar.remove(); toolbar = null;
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
    slot.controls?.render();
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
    if (slot.history[slot.cursor] !== id) {
      slot.history.splice(slot.cursor + 1);
      slot.history.push(id);
      if (slot.history.length > 100) slot.history.shift();
      slot.cursor = slot.history.length - 1;
    }
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
    node.dataset.selected = "false";
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
      wantsPlay: defaultPlaying, history: [], cursor: -1, controls: null,
      offset: 0, resume: 0, url: "", phase: "loading", counted: false, playedAt: 0, timer: 0, frame: 0 };
    retry.onclick = () => retrySlot(slot);
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
    video.addEventListener("pause", () => { save(slot); renderGroup(); });
    video.addEventListener("playing", renderGroup);
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
    slot.controls = mountTileControls({
      node, video,
      snapshot: () => ({
        time: video.currentTime + slot.offset,
        duration: Number(slot.scene?.files[0]?.duration) || 0,
        loading: slot.phase === "loading",
        error: slot.phase === "error",
        unavailable: !slot.scene,
        previous: slot.cursor > 0,
        next: true,
      }),
      setPlaying(value) {
        slot.wantsPlay = value;
        if (value) {
          if (slot.phase === "error") retrySlot(slot);
          else play(slot);
        } else { video.pause(); present(slot); }
      },
      seek(seconds) {
        if (!slot.scene) return;
        const duration = Number(slot.scene.files[0]?.duration) || 0;
        const target = Math.max(0, Math.min(seconds, Math.max(0, duration - 0.1)));
        const relative = target - slot.offset;
        const stream = slot.scene.sources[slot.index];
        const buffered = [video.buffered, video.seekable].every(ranges => {
          for (let i = 0; i < ranges.length; i++) if (relative >= ranges.start(i) && relative < ranges.end(i)) return true;
          return false;
        });
        if (stream.offset && !buffered) { save(slot); source(slot, slot.index, target); }
        else video.currentTime = relative;
      },
      navigate(direction) {
        const cursor = slot.cursor + direction;
        if (cursor >= 0 && cursor < slot.history.length) {
          slot.cursor = cursor; slot.wantsPlay = true; load(slot, slot.history[cursor]);
        } else if (direction > 0) { slot.wantsPlay = true; replacement(slot); }
      },
      random() { slot.wantsPlay = true; replacement(slot); },
    }, controlOptions);
    slots.push(slot);
    return slot;
  }

  function unmount(slot, keepalive) {
    save(slot, keepalive);
    if (selected === slot.node) select(options.primaryController.node);
    if (!slot.video.muted && slot.video.volume > 0) controlOptions.selectAudio(options.primaryController.video);
    slot.controls.dispose();
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
    renderGroup();
  }

  const progress = setInterval(() => slots.forEach(slot => save(slot)), 15000);
  return {
    toggleAll,
    focus() { selectedControls()?.focus(); },
    setCount(count) {
      if (count > 1) mountPrimary();
      else unmountPrimary();
      while (slots.length > count - 1) unmount(slots.pop());
      while (slots.length < count - 1) {
        const slot = mount();
        replacement(slot);
      }
    },
    setPlaying,
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
      unmountPrimary();
      while (slots.length) unmount(slots.pop(), keepalive);
    },
  };
}
