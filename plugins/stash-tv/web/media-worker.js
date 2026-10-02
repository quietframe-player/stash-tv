const CACHE = "stash-tv-media-v1";
const LIMIT = 1024 * 1024 * 1024;
const ITEM_LIMIT = 64 * 1024 * 1024;
const CHUNK = 2 * 1024 * 1024;
const TTL = 10 * 60 * 1000;
const root = new URL("./_media/", self.location.href);
let writes = Promise.resolve();

async function hash(url) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function key(id, part = "index") { return new URL(id + "/" + part, root).href; }
function rangeKey(entry, range) {
  return key(entry.id, (entry.revision ? entry.revision + "/" : "") + range.start);
}
async function entries(cache) {
  const keys = await cache.keys();
  const indexes = keys.filter(request => request.url.endsWith("/index"));
  return Promise.all(indexes.map(async request => ({ ...(await (await cache.match(request)).json()), key: request.url })));
}
async function remove(cache, entry) {
  await Promise.all([cache.delete(entry.key), ...entry.ranges.map(range => cache.delete(rangeKey(entry, range)))]);
}
async function budget(cache) {
  try {
    const { quota, usage } = await navigator.storage.estimate();
    if (Number.isFinite(quota) && quota > 0 && Number.isFinite(usage)) {
      const cached = (await entries(cache)).reduce((sum, entry) => sum + entry.bytes, 0);
      return Math.max(0, Math.min(LIMIT, Math.floor(quota * 0.8 - Math.max(0, usage - cached))));
    }
  } catch {}
  return LIMIT;
}
async function prune(cache, wanted, limit, slots = 4) {
  const list = (await entries(cache)).sort((a, b) => wanted
    ? wanted.indexOf(a.id) - wanted.indexOf(b.id) : b.stored - a.stored);
  let bytes = 0, count = 0;
  const keep = new Set(), retained = [];
  for (const entry of list) {
    if (Date.now() - entry.stored > TTL || (wanted && !wanted.includes(entry.id)) ||
        bytes + entry.bytes > limit || count >= slots) await remove(cache, entry);
    else {
      bytes += entry.bytes; count++;
      keep.add(entry.key);
      for (const range of entry.ranges) keep.add(rangeKey(entry, range));
      retained.push({ signature: entry.signature, seconds: entry.seconds });
    }
  }
  for (const request of await cache.keys()) if (!keep.has(request.url)) await cache.delete(request);
  return { bytes, count, retained };
}
self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("message", event => {
  const port = event.ports[0];
  if (!port || !event.source?.url?.startsWith(new URL("./", self.location.href).href)) return;
  writes = writes.catch(() => {}).then(async () => {
    const cache = await caches.open(CACHE);
    const input = event.data;
    const limit = await budget(cache);
    const wanted = await Promise.all((input.urls || []).slice(0, 16).map(hash));
    const slots = Math.max(4, wanted.length);
    if (input.type === "retain") return { ...await prune(cache, wanted, limit, slots), limit };
    if (input.type === "store") {
      const value = input.prepared;
      const url = new URL(value.url);
      if (url.origin !== self.location.origin || !/\/scene\/\d+\/stream$/.test(url.pathname) ||
          !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > ITEM_LIMIT ||
          value.ranges.reduce((sum, range) => sum + range.data.byteLength, 0) !== value.bytes ||
          value.ranges.some(range => range.end - range.start + 1 !== range.data.byteLength || range.start < 0 || range.end >= value.total))
        throw new Error("Invalid prepared stream");
      const id = await hash(url.href);
      const priority = wanted.indexOf(id);
      const higher = (await entries(cache)).filter(entry => entry.id !== id &&
        Date.now() - entry.stored <= TTL && wanted.includes(entry.id) && wanted.indexOf(entry.id) < priority);
      if (priority < 0 || higher.length >= slots || higher.reduce((sum, entry) => sum + entry.bytes, 0) + value.bytes > limit)
        return { ...await prune(cache, wanted, limit, slots), limit, stored: false };
      const old = await cache.match(key(id));
      if (old) await remove(cache, { ...(await old.json()), key: key(id) });
      const revision = crypto.getRandomValues(new Uint32Array(4)).join("-");
      const entry = { id, revision, ranges: [] };
      await prune(cache, wanted, limit - value.bytes, slots - 1);
      try {
        for (const range of value.ranges) for (let offset = 0; offset < range.data.byteLength; offset += CHUNK) {
          const data = new Uint8Array(range.data, offset, Math.min(CHUNK, range.data.byteLength - offset));
          const part = { start: range.start + offset, end: range.start + offset + data.byteLength - 1 };
          entry.ranges.push(part);
          await cache.put(rangeKey(entry, part), new Response(data));
        }
        await cache.put(key(id), new Response(JSON.stringify({ id, revision, total: value.total, mime: value.mime,
          modified: value.modified, ranges: entry.ranges, bytes: value.bytes, signature: value.signature, seconds: value.seconds, stored: Date.now() }),
        { headers: { "Content-Type": "application/json" } }));
      } catch (error) {
        await remove(cache, { ...entry, key: key(id) });
        throw error;
      }
    }
    return { ...await prune(cache, wanted, limit, slots), limit, stored: true };
  });
  event.waitUntil(writes.then(result => port.postMessage({ result }), error => port.postMessage({ error: error.message })));
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("Range") || "");
  if (request.method !== "GET" || request.destination !== "video" || !match ||
      url.origin !== self.location.origin || !/\/scene\/\d+\/stream$/.test(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const id = await hash(request.url);
    const index = await cache.match(key(id));
    if (!index) return fetch(request);
    const entry = await index.json();
    const start = Number(match[1]), end = match[2] ? Math.min(Number(match[2]), entry.total - 1) : entry.total - 1;
    const ranges = entry.ranges.filter(range => range.end >= start && range.start <= end).sort((a, b) => a.start - b.start);
    const ifRange = request.headers.get("If-Range");
    if (Date.now() - entry.stored > TTL || start > end || !ranges.length ||
        (ifRange && ifRange !== entry.modified)) return fetch(request);
    const controller = new AbortController();
    let cursor = start, reader = null, remaining = 0;
    const stream = new ReadableStream({
      async pull(output) {
        try {
          if (reader) {
            const value = await reader.read();
            if (!value.done) { cursor += value.value.byteLength; remaining -= value.value.byteLength; output.enqueue(value.value); return; }
            reader = null;
            if (remaining !== 0) throw new Error("Incomplete original stream");
          }
          if (cursor > end) { output.close(); return; }
          const chunk = ranges.find(range => range.start <= cursor && range.end >= cursor);
          if (chunk) {
            const last = Math.min(end, chunk.end);
            const response = await cache.match(rangeKey(entry, chunk));
            if (response) {
              const data = new Uint8Array(await response.arrayBuffer());
              if (data.byteLength !== chunk.end - chunk.start + 1) throw new Error("Incomplete cached range");
              output.enqueue(data.subarray(cursor - chunk.start, last - chunk.start + 1));
              cursor = last + 1;
              return;
            }
          }
          const next = ranges.find(range => range.start > cursor);
          const last = chunk ? Math.min(end, chunk.end) : next ? Math.min(end, next.start - 1) : end;
          const headers = new Headers(request.headers);
          headers.set("Range", "bytes=" + cursor + "-" + last);
          const response = await fetch(request.url, { headers, credentials: "same-origin", signal: controller.signal });
          if (response.status !== 206 || response.headers.get("Content-Range") !== "bytes " + cursor + "-" + last + "/" + entry.total ||
              (response.headers.get("Last-Modified") || "") !== entry.modified) throw new Error("Original stream changed");
          reader = response.body.getReader();
          remaining = last - cursor + 1;
          const value = await reader.read();
          if (value.done) throw new Error("Empty original stream");
          cursor += value.value.byteLength; remaining -= value.value.byteLength;
          output.enqueue(value.value);
        } catch (error) { controller.abort(); output.error(error); }
      },
      cancel() { controller.abort(); return reader?.cancel().catch(() => {}); },
    });
    const headers = { "Content-Type": entry.mime, "Accept-Ranges": "bytes", "Cache-Control": "no-store",
      "Content-Range": "bytes " + start + "-" + end + "/" + entry.total,
      "Content-Length": String(end - start + 1), "X-Stash-TV-Cache": "hit" };
    if (entry.modified) headers["Last-Modified"] = entry.modified;
    return new Response(stream, { status: 206, headers });
  })().catch(() => fetch(request)));
});
