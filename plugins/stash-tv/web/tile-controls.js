export function mountTileControls(controller, options) {
  const { node, video } = controller;
  const disposers = [];
  let hideTimer = 0, pointer = null, target = 0;
  function listen(element, event, handler) {
    element.addEventListener(event, handler);
    disposers.push(() => element.removeEventListener(event, handler));
  }
  function element(tag, className) {
    const result = document.createElement(tag);
    result.className = className;
    return result;
  }
  function button(action, label, icons) {
    const result = element("button", "tile-" + action);
    result.type = "button";
    result.dataset.action = action;
    result.setAttribute("aria-label", label);
    result.title = label;
    for (const icon of icons) result.appendChild(options.icon(icon));
    return result;
  }
  const surface = button("surface", "Play or pause this video", []);
  const footer = element("div", "tile-controls");
  const timeline = element("div", "tile-timeline");
  const elapsed = element("span", "tile-elapsed");
  const duration = element("span", "tile-duration");
  const seek = element("input", "tile-seek");
  seek.type = "range"; seek.min = "0"; seek.max = "1"; seek.step = "0.1"; seek.value = "0";
  seek.setAttribute("aria-label", "Seek this video");
  timeline.append(elapsed, seek, duration);
  const nav = element("div", "tile-nav");
  nav.setAttribute("role", "group");
  nav.setAttribute("aria-label", "Controls for this video");
  const previous = button("previous", "Previous video in this tile", ["skip-back"]);
  const toggle = button("toggle", "Pause this video", ["play", "pause", "loader-circle", "rotate-ccw"]);
  const next = button("next", "Next video in this tile", ["skip-forward"]);
  const random = button("random", "Random video in this tile", ["shuffle"]);
  const audio = button("audio", "Volume for this video", ["volume-2", "volume-x"]);
  const fullscreen = button("fullscreen", "Fullscreen this video", ["maximize", "minimize"]);
  const more = button("more", "More controls for this video", ["ellipsis"]);
  more.setAttribute("aria-expanded", "false");
  const actions = element("div", "tile-more-panel");
  actions.hidden = true;
  actions.setAttribute("role", "group");
  actions.setAttribute("aria-label", "Video navigation");
  actions.append(previous, random, next);
  nav.append(toggle, audio, fullscreen, more);
  const panel = element("div", "tile-volume-panel");
  panel.hidden = true;
  const mute = button("mute", "Mute this video", ["volume-2", "volume-x"]);
  const volume = element("input", "tile-volume");
  volume.type = "range"; volume.min = "0"; volume.max = "1"; volume.step = "0.05";
  volume.setAttribute("aria-label", "Volume for this video");
  panel.append(mute, volume);
  audio.setAttribute("aria-expanded", "false");
  footer.append(timeline, nav, panel, actions);
  node.append(surface, footer);

  function show() {
    clearTimeout(hideTimer);
    node.dataset.controls = "true";
    options.visibility(node, true);
    if (!video.paused && panel.hidden && actions.hidden && pointer === null)
      hideTimer = setTimeout(() => { node.dataset.controls = "false"; options.visibility(node, false); }, 2200);
  }
  function closePanels() {
    panel.hidden = actions.hidden = true;
    audio.setAttribute("aria-expanded", "false");
    more.setAttribute("aria-expanded", "false");
  }
  function activate() {
    options.activate(node);
    show();
  }
  function label(button, value) {
    button.setAttribute("aria-label", value);
    button.title = value;
  }
  function render() {
    const state = controller.snapshot();
    node.dataset.tilePhase = state.loading ? "loading" : state.error ? "error" : video.paused ? "paused" : "playing";
    node.dataset.muted = String(video.muted || video.volume === 0);
    seek.disabled = !state.duration || state.error;
    toggle.disabled = state.unavailable && !state.error;
    previous.disabled = !state.previous;
    next.disabled = !state.next;
    random.disabled = state.unavailable;
    if (pointer === null) {
      seek.max = String(state.duration || 1);
      seek.value = String(state.time);
      elapsed.textContent = options.timeLabel(state.time);
      seek.style.setProperty("--progress", (state.duration ? state.time / state.duration * 100 : 0) + "%");
    }
    duration.textContent = options.timeLabel(state.duration);
    volume.value = String(video.muted ? 0 : video.volume);
    label(toggle, state.error ? "Retry this video" : video.paused ? "Play this video" : "Pause this video");
    label(mute, video.muted ? "Unmute this video" : "Mute this video");
    const full = document.fullscreenElement === node || document.webkitFullscreenElement === node || video.webkitDisplayingFullscreen;
    node.dataset.tileFullscreen = String(!!full);
    label(fullscreen, full ? "Exit fullscreen" : "Fullscreen this video");
  }
  function togglePlayback() { activate(); controller.setPlaying(controller.snapshot().error || video.paused); show(); render(); }
  listen(surface, "click", togglePlayback);
  listen(toggle, "click", togglePlayback);
  listen(previous, "click", () => { closePanels(); controller.navigate(-1); show(); });
  listen(next, "click", () => { closePanels(); controller.navigate(1); show(); });
  listen(random, "click", () => { closePanels(); controller.random(); show(); });
  listen(more, "click", () => {
    const open = actions.hidden;
    closePanels(); actions.hidden = !open;
    more.setAttribute("aria-expanded", String(open));
    show();
  });
  listen(audio, "click", () => {
    const open = panel.hidden;
    closePanels(); panel.hidden = !open;
    audio.setAttribute("aria-expanded", String(!panel.hidden));
    if (!panel.hidden && (video.muted || video.volume === 0)) options.selectAudio(video);
    show(); render();
  });
  listen(mute, "click", () => {
    if (video.muted || video.volume === 0) options.selectAudio(video);
    else video.muted = true;
    render();
  });
  listen(volume, "input", () => {
    const value = Number(volume.value);
    if (value) options.selectAudio(video);
    video.volume = value;
    video.muted = value === 0;
    render();
  });
  listen(fullscreen, "click", () => {
    if (video.webkitDisplayingFullscreen) video.webkitExitFullscreen?.();
    else if (document.fullscreenElement || document.webkitFullscreenElement)
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    else {
      const native = () => {
        if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
        else options.notice("Fullscreen is unavailable in this browser.");
      };
      try {
        const request = node.requestFullscreen || node.webkitRequestFullscreen;
        if (!request || document.fullscreenEnabled === false && document.webkitFullscreenEnabled !== true) native();
        else request.call(node)?.catch(native);
      } catch { native(); }
    }
  });

  function preview(value) {
    target = Math.max(0, Math.min(value, Number(seek.max)));
    seek.value = String(target);
    elapsed.textContent = options.timeLabel(target);
    seek.style.setProperty("--progress", (target / Number(seek.max) * 100) + "%");
  }
  function scrub(event) {
    const rect = seek.getBoundingClientRect();
    preview((event.clientX - rect.left) / rect.width * Number(seek.max));
  }
  function finish(commit) {
    if (pointer === null) return;
    const id = pointer;
    pointer = null;
    if (seek.hasPointerCapture?.(id)) seek.releasePointerCapture(id);
    if (commit) controller.seek(target);
    render(); show();
  }
  listen(seek, "pointerdown", event => {
    if (seek.disabled || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    pointer = event.pointerId;
    seek.setPointerCapture(event.pointerId);
    scrub(event); show();
  });
  listen(document, "pointermove", event => {
    if (event.pointerId !== pointer) return;
    event.preventDefault(); scrub(event);
  });
  listen(document, "pointerup", event => {
    if (event.pointerId !== pointer) return;
    event.preventDefault(); scrub(event); finish(true);
  });
  listen(seek, "pointercancel", () => finish(false));
  listen(seek, "lostpointercapture", () => finish(false));
  listen(seek, "input", () => { preview(Number(seek.value)); show(); });
  listen(seek, "change", () => { if (pointer === null) controller.seek(Number(seek.value)); });
  listen(node, "pointerenter", event => { if (event.pointerType === "mouse") activate(); });
  listen(node, "pointermove", show);
  listen(node, "pointerdown", activate);
  listen(node, "focusin", activate);
  listen(footer, "focusout", show);
  listen(document, "pointerdown", event => { if (!footer.contains(event.target)) closePanels(); });
  listen(node, "keydown", event => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    activate();
    if (event.key === "Escape" && (!panel.hidden || !actions.hidden)) {
      const focus = !actions.hidden ? more : audio;
      closePanels(); focus.focus(); show();
      event.stopPropagation(); return;
    }
    if (event.target.tagName === "INPUT" ||
        event.target.tagName === "BUTTON" && event.target !== surface && [" ", "Enter"].includes(event.key)) {
      event.stopPropagation(); return;
    }
    const action = options.keyAction(event);
    if (!action) return;
    const state = controller.snapshot();
    const commands = {
      previous: () => controller.navigate(-1), next: () => controller.navigate(1),
      random: () => controller.random(), toggle: togglePlayback,
      fullscreen: () => fullscreen.click(),
      backward: () => controller.seek(state.time - 10), forward: () => controller.seek(state.time + 10),
      "backward-minute": () => controller.seek(state.time - 60), "forward-minute": () => controller.seek(state.time + 60),
      "volume-up": () => volumeStep(0.05), "volume-down": () => volumeStep(-0.05),
    };
    event.preventDefault();
    event.stopPropagation();
    if (action.type === "seek-percent" && !event.repeat) controller.seek(state.duration * action.percent / 100);
    else if (action.type === "navigate" && !event.repeat) controller.navigate(action.direction);
    else if (!event.repeat || ["backward", "forward", "backward-minute", "forward-minute", "volume-up", "volume-down"].includes(action)) commands[action]?.();
    show();
  });
  function volumeStep(delta) {
    const value = Math.max(0, Math.min(1, (video.muted ? 0 : video.volume) + delta));
    if (value) options.selectAudio(video);
    video.volume = value; video.muted = value === 0;
  }
  for (const event of ["timeupdate", "durationchange", "loadedmetadata", "playing", "pause", "waiting", "seeking", "seeked", "canplay", "volumechange", "emptied", "error"]) {
    listen(video, event, () => { render(); if (video.paused || event === "playing") show(); });
  }
  for (const event of ["fullscreenchange", "webkitfullscreenchange"]) listen(document, event, render);
  for (const event of ["webkitbeginfullscreen", "webkitendfullscreen"]) listen(video, event, render);
  listen(window, "blur", () => finish(false));
  render(); show();
  return {
    render, show,
    focus() { surface.focus({preventScroll:true}); },
    dismiss() { closePanels(); finish(false); clearTimeout(hideTimer); node.dataset.controls = "false"; },
    dispose() {
      finish(false); clearTimeout(hideTimer);
      disposers.forEach(dispose => dispose());
      surface.remove(); footer.remove();
      delete node.dataset.controls;
    },
  };
}
