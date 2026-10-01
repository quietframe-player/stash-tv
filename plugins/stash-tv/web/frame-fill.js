export function frameInsets(pixels, width, height) {
  let lit = 0;
  const black = (x, y) => {
    const offset = (y * width + x) * 4;
    return Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) <= 12;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (!black(x, y)) lit++;
  if (lit < width * height * 0.03) return null;
  function edge(length, cross, vertical, reverse) {
    const limit = Math.floor(length * 0.4);
    for (let distance = 0; distance <= limit; distance++) {
      const position = reverse ? length - distance - 1 : distance;
      for (let other = 0; other < cross; other++) {
        if (!black(vertical ? position : other, vertical ? other : position)) return distance;
      }
    }
    return limit + 1;
  }
  function paired(a, b, length) {
    if (Math.max(a, b) > length * 0.4) return null;
    return Math.min(a, b) >= 2 && Math.abs(a - b) <= 2 ? (Math.min(a, b) + 1) / length : 0;
  }
  const x = paired(edge(width, height, true, false), edge(width, height, true, true), width);
  const y = paired(edge(height, width, false, false), edge(height, width, false, true), height);
  return x === null || y === null ? null : {x, y};
}

export function frameScale(insets, width, height, tileWidth, tileHeight) {
  const full = Math.max(tileWidth / width, tileHeight / height);
  const picture = Math.max(tileWidth / (width * (1 - 2 * insets.x)), tileHeight / (height * (1 - 2 * insets.y)));
  return picture / full;
}

export function mountFrameFill(node, video) {
  const canvas = document.createElement("canvas");
  canvas.width = 160; canvas.height = 90;
  const context = canvas.getContext("2d", {willReadFrequently:true});
  let source = "", samples = 0, attempts = 0, sampledAt = -Infinity, insets = null, width = 0, height = 0;
  function geometry() {
    if (!insets || !width || !height) return;
    const tile = node.getBoundingClientRect();
    if (tile.width && tile.height)
      node.style.setProperty("--frame-scale", String(frameScale(insets, width, height, tile.width, tile.height)));
  }
  function capture() {
    if (video.readyState < 2 || video.seeking || !video.videoWidth || !video.currentSrc) return;
    if (source !== video.currentSrc) {
      source = video.currentSrc;
      samples = attempts = 0;
      sampledAt = -Infinity;
      insets = null;
    }
    if (samples >= 3 || attempts >= 12 || Math.abs(video.currentTime - sampledAt) < 0.15) return;
    sampledAt = video.currentTime;
    attempts++;
    let result;
    try {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      result = frameInsets(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
    } catch {
      attempts = 12;
      node.style.removeProperty("--frame-scale");
      return;
    }
    if (!result) return;
    insets = insets ? {x:Math.min(insets.x,result.x),y:Math.min(insets.y,result.y)} : result;
    width = video.videoWidth; height = video.videoHeight;
    samples++;
    geometry();
  }
  const events = ["loadeddata", "seeked", "playing", "timeupdate"];
  events.forEach(event => video.addEventListener(event, capture));
  const resize = typeof ResizeObserver === "function" ? new ResizeObserver(geometry) : null;
  resize?.observe(node);
  window.addEventListener("resize", geometry);
  document.addEventListener("fullscreenchange", geometry);
  document.addEventListener("webkitfullscreenchange", geometry);
  capture();
  return {
    refresh() { capture(); geometry(); },
    dispose() {
      events.forEach(event => video.removeEventListener(event, capture));
      resize?.disconnect();
      window.removeEventListener("resize", geometry);
      document.removeEventListener("fullscreenchange", geometry);
      document.removeEventListener("webkitfullscreenchange", geometry);
      node.style.removeProperty("--frame-scale");
    },
  };
}
