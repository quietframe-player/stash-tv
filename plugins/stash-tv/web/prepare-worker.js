import { createFile, DataStream } from "./mp4box-parser.js?v=2.4.1";

const ITEM_LIMIT = 64 * 1024 * 1024;
const INDEX_LIMIT = 8 * 1024 * 1024;
const PAGE = 1024 * 1024;
let active = null;

function trackShift(track, movieTimescale) {
  const edits = track.edts?.elst.entries || [];
  if (!edits.length) return 0;
  if (edits.some(edit => edit.media_rate_integer !== 1 || edit.media_rate_fraction !== 0) ||
      edits.slice(0, -1).some(edit => edit.media_time !== -1) || edits.at(-1).media_time < 0)
    throw new Error("Unsupported edit list");
  const lead = edits.slice(0, -1).reduce((seconds, edit) => seconds + edit.segment_duration / movieTimescale, 0);
  return edits.at(-1).media_time / track.mdia.mdhd.timescale - lead;
}

async function prepare(input, signal) {
  const url = new URL(input.url);
  if (url.origin !== location.origin || !/\/scene\/\d+\/stream$/.test(url.pathname))
    throw new Error("Invalid original stream");
  const ranges = [];
  let bytes = 0, total = 0, modified = "", mime = "";
  async function read(start, end) {
    signal.throwIfAborted();
    if (bytes + end - start + 1 > ITEM_LIMIT) throw new Error("Preparation byte limit");
    const response = await fetch(url, {
      headers: { Range: "bytes=" + start + "-" + end }, signal, credentials: "same-origin",
    });
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("Content-Range") || "");
    if (response.status !== 206 || !match || Number(match[1]) !== start || Number(match[2]) > end) {
      await response.body?.cancel();
      throw new Error("Original stream does not support bounded ranges");
    }
    const size = Number(match[3]);
    const stamp = response.headers.get("Last-Modified") || "";
    if (size !== input.size || (total && (size !== total || stamp !== modified))) {
      await response.body?.cancel();
      throw new Error("Original file changed");
    }
    total = size; modified = stamp; mime = response.headers.get("Content-Type") || "video/mp4";
    const data = await response.arrayBuffer();
    if (data.byteLength !== Number(match[2]) - start + 1) throw new Error("Incomplete range");
    bytes += data.byteLength;
    const range = { start, end: start + data.byteLength - 1, data };
    ranges.push(range);
    return range;
  }
  const file = createFile(false);
  let info, parserError;
  file.onReady = value => { info = value; };
  file.onError = error => { parserError = new Error(String(error)); };
  let offset = 0, indexBytes = 0;
  while (!info) {
    const range = await read(offset, Math.min(total || input.size, offset + PAGE) - 1);
    indexBytes += range.data.byteLength;
    range.data.fileStart = offset;
    const suggested = file.appendBuffer(range.data);
    if (parserError) throw parserError;
    if (info) break;
    // Only mdat payloads can skip bytes; incomplete headers and padding must stay contiguous.
    const next = file.parsingMdat ? suggested : range.end + 1;
    if (indexBytes >= INDEX_LIMIT || next >= input.size || next <= offset)
      throw new Error("MP4 index exceeds preparation limit");
    offset = next;
  }
  if (!info.videoTracks.length || info.isFragmented) throw new Error("No progressive MP4 video track");
  const videoInfo = info.videoTracks[0];
  const track = file.getTrackById(videoInfo.id);
  const shift = trackShift(track, info.timescale);
  const target = Math.max(0, Math.min(input.seconds, info.duration / info.timescale - 0.05));
  let first = -1;
  for (let i = 0; i < track.samples.length; i++) {
    const sample = track.samples[i];
    if (sample.is_sync && sample.cts / sample.timescale - shift <= target) first = i;
  }
  if (first < 0 && track.samples[0]?.is_sync && track.samples[0].cts / track.samples[0].timescale - shift > target)
    first = 0;
  if (first < 0) throw new Error("No preceding keyframe");
  let start = track.samples[first].offset, end = start;
  for (const item of info.tracks) {
    const samples = file.getTrackById(item.id).samples;
    const delay = trackShift(file.getTrackById(item.id), info.timescale);
    for (let i = item.id === track.tkhd.track_id ? first : 0; i < samples.length; i++) {
      const sample = samples[i];
      const seconds = sample.cts / sample.timescale - delay;
      if (item.type !== "video" && seconds + sample.duration / sample.timescale < target) continue;
      if (seconds > target + 30) break;
      start = Math.min(start, sample.offset);
      end = Math.max(end, sample.offset + sample.size - 1);
    }
  }
  end = Math.min(end, start + ITEM_LIMIT - bytes - 1);
  let cursor = start;
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    if (range.end < cursor || range.start > end) continue;
    if (range.start > cursor) await read(cursor, range.start - 1);
    cursor = Math.max(cursor, range.end + 1);
  }
  if (cursor <= end) await read(cursor, end);
  let bitmap = null, frameTime = null;
  if (typeof VideoDecoder === "function" && typeof createImageBitmap === "function") {
    let decoder, chosen;
    const close = () => { if (decoder && decoder.state !== "closed") decoder.close(); };
    signal.addEventListener("abort", close, { once: true });
    try {
      const sample = track.samples[first];
      const box = sample.description.avcC || sample.description.hvcC || sample.description.av1C;
      const config = { codec: videoInfo.codec, codedWidth: videoInfo.video.width, codedHeight: videoInfo.video.height,
        hardwareAcceleration: "prefer-software" };
      if (box) {
        const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
        box.write(stream);
        config.description = new Uint8Array(stream.buffer, 8);
      }
      if (!(await VideoDecoder.isConfigSupported(config)).supported) throw new Error("Frame decoder unavailable");
      let failure;
      decoder = new VideoDecoder({
        output: frame => {
          if (frame.timestamp / 1000000 <= target + 0.0001 && (!chosen || frame.timestamp > chosen.timestamp)) {
            chosen?.close(); chosen = frame;
          } else frame.close();
        },
        error: error => { failure = error; },
      });
      decoder.configure(config);
      for (let i = first; i < Math.min(track.samples.length, first + 360); i++) {
        signal.throwIfAborted();
        const sample = track.samples[i];
        const range = ranges.find(r => r.start <= sample.offset && r.end >= sample.offset + sample.size - 1);
        if (!range) break;
        const seconds = sample.cts / sample.timescale - shift;
        decoder.decode(new EncodedVideoChunk({
          type: sample.is_sync ? "key" : "delta", timestamp: Math.round(seconds * 1000000),
          duration: Math.round(sample.duration / sample.timescale * 1000000),
          data: new Uint8Array(range.data, sample.offset - range.start, sample.size),
        }));
        if (seconds > target + 0.4) break;
        if (decoder.decodeQueueSize > 12) await new Promise((resolve, reject) => {
          const aborted = () => { decoder.removeEventListener("dequeue", drained); reject(signal.reason); };
          const drained = () => { signal.removeEventListener("abort", aborted); resolve(); };
          decoder.addEventListener("dequeue", drained, { once: true });
          signal.addEventListener("abort", aborted, { once: true });
          if (signal.aborted) aborted();
        });
      }
      await decoder.flush();
      if (failure) throw failure;
      if (chosen && target - chosen.timestamp / 1000000 < 0.15) {
        const width = Math.min(1280, chosen.displayWidth);
        bitmap = await createImageBitmap(chosen, { resizeWidth: width,
          resizeHeight: Math.round(width * chosen.displayHeight / chosen.displayWidth), resizeQuality: "low" });
        frameTime = chosen.timestamp / 1000000;
      }
    } catch (error) { if (signal.aborted) throw error; }
    finally { signal.removeEventListener("abort", close); chosen?.close(); close(); }
  }
  signal.throwIfAborted();
  return { id: input.id, url: input.url, seconds: input.seconds, signature: input.signature,
    total, modified, mime, bytes, ranges, bitmap, frameTime };
}

self.onmessage = async event => {
  if (event.data.type === "cancel") { active?.abort(); return; }
  if (event.data.type !== "prepare") return;
  active?.abort();
  const controller = new AbortController();
  active = controller;
  const timer = setTimeout(() => controller.abort(), 30000);
  const token = event.data.token;
  try {
    const prepared = await prepare(event.data.item, controller.signal);
    self.postMessage({ token, prepared }, [...prepared.ranges.map(range => range.data), ...(prepared.bitmap ? [prepared.bitmap] : [])]);
  } catch (error) { self.postMessage({ token, error: controller.signal.aborted ? "cancelled" : error.message }); }
  finally { clearTimeout(timer); if (active === controller) active = null; }
};
