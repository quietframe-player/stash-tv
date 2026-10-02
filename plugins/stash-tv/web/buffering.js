export async function createBuffer(onPrepared, onStatus) {
  if (!navigator.serviceWorker || !globalThis.Worker || !globalThis.caches) return null;
  const workerURL = new URL("./media-worker.js", import.meta.url);
  workerURL.search = new URL(import.meta.url).search;
  await navigator.serviceWorker.register(workerURL, { scope: new URL("./", workerURL).pathname, updateViaCache: "none" });
  if (navigator.serviceWorker.controller?.scriptURL !== workerURL.href) await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { navigator.serviceWorker.removeEventListener("controllerchange", changed); reject(new Error("Media worker unavailable")); }, 5000);
    function changed() {
      if (navigator.serviceWorker.controller?.scriptURL !== workerURL.href) return;
      clearTimeout(timer); navigator.serviceWorker.removeEventListener("controllerchange", changed); resolve();
    }
    navigator.serviceWorker.addEventListener("controllerchange", changed);
    changed();
  });
  const preparationURL = new URL("./prepare-worker.js", import.meta.url);
  preparationURL.search = new URL(import.meta.url).search;
  const worker = new Worker(preparationURL, { type: "module" });
  let plan = [], paused = true, active = null, token = 0, disposed = false;
  const done = new Map();
  const skipped = new Set();
  const identity = item => item.url + "/" + item.signature + "/" + item.seconds;
  function retained(stats) {
    const kept = new Set(stats.retained.map(item => item.signature + "/" + item.seconds));
    for (const item of plan) if (!kept.has(item.signature + "/" + item.seconds)) done.delete(identity(item));
  }
  function request(message, transfer = []) {
    return new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => { channel.port1.close(); reject(new Error("Media cache unavailable")); }, 15000);
      channel.port1.onmessage = event => {
        clearTimeout(timer); channel.port1.close();
        if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.result);
      };
      navigator.serviceWorker.controller.postMessage(message, [channel.port2, ...transfer]);
    });
  }
  function run() {
    if (paused || active || disposed) return;
    const item = plan.find(item => !item.current && Date.now() - (done.get(identity(item)) || 0) > 9 * 60 * 1000 && !skipped.has(identity(item)));
    if (!item) return;
    active = { item, token: ++token };
    onStatus({ state: "preparing", id: item.id });
    worker.postMessage({ type: "prepare", token, item });
  }
  worker.onmessage = async event => {
    const message = event.data;
    const current = active;
    if (!current || current.token !== message.token) { message.prepared?.bitmap?.close(); return; }
    const wanted = plan.some(item => identity(item) === identity(current.item));
    if (message.error) {
      if (message.error !== "cancelled") skipped.add(identity(current.item));
      onStatus({ state: message.error === "cancelled" ? "cancelled" : "skipped", id: current.item.id });
    } else if (wanted && !paused && !disposed) {
      const prepared = message.prepared;
      const bitmap = prepared.bitmap;
      delete prepared.bitmap;
      try {
        const stats = await request({ type: "store", prepared, urls: plan.map(item => item.url) }, prepared.ranges.map(range => range.data));
        retained(stats);
        if (!stats.stored) {
          bitmap?.close(); skipped.add(identity(current.item));
          onStatus({ state: "skipped", id: current.item.id, reason: "cache budget" });
        } else if (plan.some(item => identity(item) === identity(current.item)) && !disposed) {
          done.set(identity(current.item), Date.now());
          onPrepared({ ...current.item, bitmap, frameTime: prepared.frameTime });
          onStatus({ state: "prepared", id: current.item.id, bytes: prepared.bytes, seconds: current.item.seconds,
            frameTime: prepared.frameTime, cacheBytes: stats.bytes, cacheLimit: stats.limit, entries: stats.count });
        } else bitmap?.close();
      } catch {
        bitmap?.close(); skipped.add(identity(current.item));
        onStatus({ state: "skipped", id: current.item.id, reason: "cache storage" });
      }
    } else message.prepared?.bitmap?.close();
    if (active === current) active = null;
    run();
  };
  worker.onerror = () => { active = null; paused = true; onStatus({ state: "unavailable" }); };
  return {
    update(items) {
      if (plan.map(identity).join("\n") !== items.map(identity).join("\n")) skipped.clear();
      plan = items;
      const wanted = new Set(items.map(identity));
      for (const key of done.keys()) if (!wanted.has(key)) done.delete(key);
      for (const key of skipped) if (!wanted.has(key)) skipped.delete(key);
      if (active && !wanted.has(identity(active.item))) worker.postMessage({ type: "cancel" });
      request({ type: "retain", urls: items.map(item => item.url) }).then(stats => {
        retained(stats); run();
      }).catch(() => {});
      run();
    },
    pause(value) {
      paused = value;
      if (paused && active) worker.postMessage({ type: "cancel" });
      if (!paused) run();
    },
    dispose() { disposed = true; worker.terminate(); },
  };
}
