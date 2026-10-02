import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function cacheWorker(estimate = async () => ({ quota: 8 * 1024 ** 3, usage: 0 }), network = () => { throw new Error("Unexpected network read"); }) {
  const data = new Map(), handlers = {};
  let chunkReads = 0;
  const cache = {
    keys: async () => [...data.keys()].map(url => ({ url })),
    match: async key => {
      const url = typeof key === "string" ? key : key.url;
      if (!url.endsWith("/index")) chunkReads++;
      return data.get(url)?.clone();
    },
    put: async (key, response) => { data.set(String(key), response); },
    delete: async key => data.delete(String(key)),
  };
  const location = new URL("https://stash.example/plugin/stash-tv/assets/media-worker.js");
  runInNewContext(readFileSync(new URL("../plugins/stash-tv/web/media-worker.js", import.meta.url), "utf8"), {
    self: { location, addEventListener: (type, handler) => { handlers[type] = handler; } },
    location, navigator: { storage: { estimate } }, caches: { open: async () => cache },
    crypto, TextEncoder, URL, Response, Headers, Uint8Array, Uint32Array, AbortController, ReadableStream, fetch: network,
  });
  return {
    fetch: request => new Promise(resolve => handlers.fetch({ request, respondWith: response => resolve(response) })),
    evictChunk: start => { for (const key of data.keys()) if (key.endsWith("/" + start)) data.delete(key); },
    chunkReads: () => chunkReads,
    async request(input) {
      let output;
      await new Promise(resolve => handlers.message({
        data: input, source: { url: "https://stash.example/plugin/stash-tv/assets/index.html" },
        ports: [{ postMessage: value => { output = value; } }], waitUntil: promise => promise.then(resolve),
      }));
      if (output.error) throw new Error(output.error);
      return output.result;
    },
    used: async () => (await Promise.all([...data.entries()].filter(([key]) => !key.endsWith("/index"))
      .map(async ([, response]) => (await response.clone().arrayBuffer()).byteLength))).reduce((sum, bytes) => sum + bytes, 0),
  };
}

const urls = Array.from({ length: 6 }, (_, i) => "https://stash.example/scene/" + (i + 1) + "/stream");
const item = (index, bytes) => ({ url: urls[index], bytes, total: bytes, mime: "video/mp4", modified: "",
  signature: String(index), seconds: 0, ranges: [{ start: 0, end: bytes - 1, data: new ArrayBuffer(bytes) }] });

test("cache uses a full GiB budget and falls back when estimates are unavailable", async () => {
  for (const estimate of [undefined, async () => { throw new Error("unavailable"); }, async () => ({})]) {
    expect((await cacheWorker(estimate).request({ type: "retain", urls: [] })).limit).toBe(1024 ** 3);
  }
});

test("quota headroom preserves nearest entries and accounts for the cache itself", async () => {
  const worker = cacheWorker(async () => ({ quota: 100, usage: await worker.used() }));
  const results = [];
  for (const i of [4, 3, 2, 1, 0, 4]) results.push(await worker.request({ type: "store", urls, prepared: item(i, 24) }));
  expect(results.slice(0, 5).every(result => result.stored)).toBe(true);
  expect(results[5].stored).toBe(false);
  expect(results[5].bytes).toBe(72);
  expect(results[5].retained.map(entry => entry.signature).sort()).toEqual(["0", "1", "2"]);
});

test("unrelated origin usage can disable preparation without exceeding its quota", async () => {
  const worker = cacheWorker(async () => ({ quota: 100, usage: 90 }));
  const result = await worker.request({ type: "store", urls, prepared: item(0, 1) });
  expect(result).toMatchObject({ limit: 0, bytes: 0, count: 0, stored: false });
});

test("worker rejects prepared metadata that understates the actual encoded bytes", async () => {
  const worker = cacheWorker();
  const prepared = item(0, 16);
  prepared.bytes = 8;
  await expect(worker.request({ type: "store", urls, prepared })).rejects.toThrow("Invalid prepared stream");
  expect((await worker.request({ type: "retain", urls })).count).toBe(0);
});

test("native reads stay byte accurate across bounded chunks and in-flight eviction", async () => {
  const bytes = 4 * 1024 ** 2 + 10;
  const prepared = item(0, bytes), source = new Uint8Array(prepared.ranges[0].data);
  for (let i = 0; i < bytes; i++) source[i] = i % 251;
  const requests = [];
  const worker = cacheWorker(undefined, async (url, options) => {
    const range = options.headers.get("Range"); requests.push(range);
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range).map(Number);
    return new Response(source.slice(start, end + 1), { status: 206,
      headers: { "Content-Range": "bytes " + start + "-" + end + "/" + bytes } });
  });
  await worker.request({ type: "store", urls, prepared });
  const response = await worker.fetch({ method: "GET", destination: "video", url: urls[0], headers: new Headers({ Range: "bytes=0-" }) });
  expect(worker.chunkReads()).toBeLessThanOrEqual(1);
  worker.evictChunk(2 * 1024 ** 2);
  const actual = await response.arrayBuffer();
  const digest = async data => Buffer.from(await crypto.subtle.digest("SHA-256", data)).toString("hex");
  expect(actual.byteLength).toBe(bytes);
  expect(await digest(actual)).toBe(await digest(source));
  expect(requests).toEqual(["bytes=2097152-4194303"]);
});
