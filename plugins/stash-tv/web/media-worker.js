const CACHE = "stash-tv-media-v1";
const LIMIT = 64 * 1024 * 1024;
const TTL = 10 * 60 * 1000;
const root = new URL("./_media/", self.location.href);
let writes = Promise.resolve();

async function hash(url) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function key(id, part = "index") { return new URL(id + "/" + part, root).href; }
async function entries(cache) {
  const keys = await cache.keys();
  const indexes = keys.filter(request => request.url.endsWith("/index"));
  return Promise.all(indexes.map(async request => ({ ...(await (await cache.match(request)).json()), key: request.url })));
}
async function remove(cache, entry) {
  await Promise.all([cache.delete(entry.key), ...entry.ranges.map(range => cache.delete(key(entry.id, range.start)))]);
}
async function prune(cache, wanted, limit = LIMIT, slots = 4) {
  const list = (await entries(cache)).sort((a, b) => b.stored - a.stored);
  let bytes = 0, count = 0;
  for (const entry of list) {
    if (Date.now() - entry.stored > TTL || (wanted && !wanted.includes(entry.id)) ||
        bytes + entry.bytes > limit || count >= slots) await remove(cache, entry);
    else { bytes += entry.bytes; count++; }
  }
  const keep = new Set();
  for (const entry of await entries(cache)) {
    keep.add(entry.key);
    for (const range of entry.ranges) keep.add(key(entry.id, range.start));
  }
  for (const request of await cache.keys()) if (!keep.has(request.url)) await cache.delete(request);
  return { bytes, count };
}
self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("message", event => {
  const port = event.ports[0];
  if (!port || !event.source?.url?.startsWith(new URL("./", self.location.href).href)) return;
  writes = writes.catch(() => {}).then(async () => {
    const cache = await caches.open(CACHE);
    const input = event.data;
    if (input.type === "retain") return prune(cache, await Promise.all(input.urls.map(hash)));
    if (input.type === "store") {
      const value = input.prepared;
      const url = new URL(value.url);
      if (url.origin !== self.location.origin || !/\/scene\/\d+\/stream$/.test(url.pathname) ||
          value.bytes > 16 * 1024 * 1024) throw new Error("Invalid prepared stream");
      const id = await hash(url.href);
      const old = await cache.match(key(id));
      if (old) await remove(cache, { ...(await old.json()), key: key(id) });
      await prune(cache, null, LIMIT - value.bytes, 3);
      const ranges = value.ranges.map(range => ({ start: range.start, end: range.end }));
      try {
        for (const range of value.ranges) await cache.put(key(id, range.start), new Response(range.data));
        await cache.put(key(id), new Response(JSON.stringify({ id, total: value.total, mime: value.mime,
          modified: value.modified, ranges, bytes: value.bytes, signature: value.signature, stored: Date.now() }),
        { headers: { "Content-Type": "application/json" } }));
      } catch (error) {
        await remove(cache, { id, key: key(id), ranges });
        throw error;
      }
    }
    return prune(cache);
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
    const chunks = [];
    for (const range of ranges) {
      const response = await cache.match(key(id, range.start));
      if (!response) return fetch(request);
      chunks.push({ ...range, data: new Uint8Array(await response.arrayBuffer()) });
    }
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
          const chunk = chunks.find(range => range.start <= cursor && range.end >= cursor);
          if (chunk) {
            const last = Math.min(end, chunk.end);
            output.enqueue(chunk.data.subarray(cursor - chunk.start, last - chunk.start + 1));
            cursor = last + 1;
            return;
          }
          const next = chunks.find(range => range.start > cursor);
          const last = next ? Math.min(end, next.start - 1) : end;
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
