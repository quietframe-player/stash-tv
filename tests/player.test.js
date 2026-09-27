import { expect, test } from "bun:test";
import {
  advanceQueue,
  makeQueue,
  previewAt,
  previewCues,
  randomQueue,
  removeCurrentScene,
  remoteAction,
  seekPosition,
  sourceAt,
  truncatedWebmFallback,
  streamChoices,
  timeLabel,
} from "../plugins/stash-tv/web/player.js";

test("Stash VTT selects sprite frames at cue boundaries and at the end", () => {
  const cues = previewCues(
    "WEBVTT\r\n\r\n1\r\n00:00:00.000 --> 00:00:22.768\r\nsheet.jpg#xywh=0,0,240,136\r\n\r\n00:00:22.768 --> 00:00:45.537\r\nsheet.jpg#xywh=240,0,240,136\r\n",
    "https://stash.test/scene/hash_thumbs.vtt",
    "https://stash.test",
  );
  expect(cues).toHaveLength(2);
  expect(previewAt(cues, 0)).toMatchObject({
    url: "https://stash.test/scene/sheet.jpg",
    x: 0,
    width: 240,
  });
  expect(previewAt(cues, 22.768).x).toBe(240);
  expect(previewAt(cues, 45.537).x).toBe(240);
  expect(previewAt(cues, 47).x).toBe(240);
  expect(previewAt(cues, -1)).toBeNull();
});

test("malformed, empty, external and zero-sized preview frames are ignored", () => {
  const rows = [
    "https://other.test/a.jpg#xywh=0,0,240,136",
    "sheet.jpg#xywh=0,0,0,136",
    "bad#xywh=-1,0,240,136",
    "javascript:alert(1)#xywh=0,0,240,136",
  ];
  const text = rows.map((row) => "00:00.000 --> 00:20.000\n" + row).join("\n\n");
  expect(previewCues(text, "https://stash.test/scene/a.vtt", "https://stash.test")).toEqual([]);
  expect(previewCues("not a VTT", "https://stash.test/a.vtt", "https://stash.test")).toEqual([]);
  expect(previewAt([], 10)).toBeNull();
});

test("deleting a video removes every occurrence from shuffled history and advances", () => {
  const queue = { ids: ["9", "3", "9", "47", "9", "5"], index: 2 };
  const remaining = removeCurrentScene(queue);
  expect(remaining).toEqual({ ids: ["3", "47", "5"], index: 1 });
  expect(advanceQueue(remaining, -1).ids).not.toContain("9");
  expect(randomQueue(remaining, 0).ids).not.toContain("9");
  expect(queue.ids).toEqual(["9", "3", "9", "47", "9", "5"]);
});

test("deleting at either end selects a remaining video and the last deletion empties the queue", () => {
  expect(removeCurrentScene({ ids: ["1", "2", "3"], index: 0 })).toEqual({
    ids: ["2", "3"],
    index: 0,
  });
  expect(removeCurrentScene({ ids: ["1", "2", "3"], index: 2 })).toEqual({
    ids: ["1", "2"],
    index: 1,
  });
  expect(removeCurrentScene({ ids: ["1", "1"], index: 1 })).toBeNull();
});

test("random changes the video and Previous returns to the video just watched", () => {
  const queue = makeQueue([{ id: "9" }, { id: "3" }, { id: "47" }], "3");
  const random = randomQueue(queue, 0);
  expect(random.ids[random.index]).toBe("9");
  const previous = advanceQueue(random, -1);
  expect(previous.ids[previous.index]).toBe("3");
  expect(random.ids.slice(random.index + 1)).toEqual(["47"]);
  expect(randomQueue(makeQueue([{ id: "9" }]), 0.5)).toBeNull();
});

test("number keys seek by percentage while arrows seek and Enter requests fullscreen", () => {
  for (const [key, action, keyCode] of [
    ["ArrowLeft", "backward", 37],
    ["ArrowRight", "forward", 39],
    ["Enter", "fullscreen", 13],
  ]) {
    expect(remoteAction({ key })).toBe(action);
    expect(remoteAction({ key: "Unidentified", keyCode })).toBe(action);
  }
  for (let digit = 0; digit <= 9; digit++) {
    const action = { type: "seek-percent", percent: digit * 10 };
    expect(remoteAction({ key: String(digit) })).toEqual(action);
    expect(remoteAction({ key: "Unidentified", keyCode: 48 + digit })).toEqual(action);
    expect(remoteAction({ keyCode: 96 + digit })).toEqual(action);
    expect(remoteAction({ key: String(digit), ctrlKey: true })).toBeNull();
  }
  expect(remoteAction({ key: "!", keyCode: 49, shiftKey: true })).toBeNull();
  expect(remoteAction({ key: "End", keyCode: 97 })).toBeNull();
  expect(remoteAction({ key: "Backspace" })).toBeNull();
});

test("previous follows the same shuffled snapshot after next", () => {
  const queue = makeQueue([{ id: "9" }, { id: "3" }, { id: "47" }], "3");
  const next = advanceQueue(queue, 1);
  expect(next.ids[next.index]).toBe("47");
  const previous = advanceQueue(next, -1);
  expect(previous.ids[previous.index]).toBe("3");
  expect(queue.index).toBe(1);
  expect(advanceQueue(next, 1)).toBeNull();
  expect(advanceQueue(makeQueue([{ id: "9" }]), -1)).toBeNull();
});

test("LG color buttons share playback actions through key codes and standard key names", () => {
  for (const [keyCode, key, action] of [
    [403, "ColorF0Red", "previous"],
    [404, "ColorF1Green", "random"],
    [405, "ColorF2Yellow", "toggle"],
    [406, "ColorF3Blue", "next"],
  ]) {
    expect(remoteAction({ keyCode, key: "Unidentified" })).toBe(action);
    expect(remoteAction({ key })).toBe(action);
  }
  expect(remoteAction({ keyCode: 407 })).toBeNull();
});

test("deleted requested scenes fall back to an existing ID and duplicates are removed", () => {
  expect(makeQueue([{ id: "7" }, { id: "7" }, { id: "../bad" }, { id: "21" }], "999")).toEqual({
    ids: ["7", "21"],
    index: 0,
  });
  expect(() => makeQueue([])).toThrow("no scenes");
});

test("stream choices keep signed parameters and reject another origin or scene", () => {
  const direct = "https://stash.test/scene/7/stream?apikey=test-value";
  const scene = {
    id: "7",
    paths: { stream: direct },
    sceneStreams: [
      { url: direct },
      {
        url: "https://stash.test/scene/7/stream.mp4?resolution=FULL_HD&apikey=test-value",
        label: "1080p",
        mime_type: "video/mp4",
      },
      { url: "https://external.test/scene/7/stream" },
      { url: "https://user:password@stash.test/scene/7/stream" },
      { url: "https://stash.test/scene/8/stream" },
    ],
  };
  const choices = streamChoices(scene, "https://stash.test");
  expect(choices).toHaveLength(2);
  expect(choices[0]).toMatchObject({ url: direct, offset: false });
  expect(sourceAt(choices[0], 30)).toBe(direct);
  const fallback = new URL(sourceAt(choices[1], 30));
  expect(fallback.searchParams.get("start")).toBe("30");
  expect(fallback.searchParams.get("resolution")).toBe("FULL_HD");
  expect(fallback.searchParams.get("apikey")).toBe("test-value");
});

test("seek time is expressed as media time for direct and HLS sources", () => {
  const scene = {
    id: "7",
    paths: {},
    sceneStreams: [
      { url: "https://stash.test/scene/7/stream.m3u8?resolution=FULL_HD", label: "1080p" },
    ],
  };
  const source = streamChoices(scene, "https://stash.test")[0];
  expect(source.offset).toBe(false);
  expect(sourceAt(source, 40)).toBe(source.url);
  expect(timeLabel(3721)).toBe("1:02:01");
});

test("the player and controls fit the initial compressed size budget", async () => {
  const files = ["index.html", "style.css", "player.js"];
  let bytes = 0;
  for (const file of files) {
    const source = await Bun.file(
      new URL("../plugins/stash-tv/web/" + file, import.meta.url),
    ).arrayBuffer();
    bytes += Bun.gzipSync(source).byteLength;
  }
  expect(bytes).toBeLessThan(50_000);
});

test("keyboard playback shortcuts preserve browser modifiers and distinguish Shift F", () => {
  for (const [key, action] of [
    ["w", "volume-up"],
    ["s", "volume-down"],
    ["a", "backward"],
    ["d", "forward"],
    ["f", "next"],
    ["r", "random"],
    ["Delete", "delete"],
  ]) {
    expect(remoteAction({ key })).toBe(action);
    if (key.length === 1) expect(remoteAction({ key: key.toUpperCase() })).toBe(action);
    for (const modifier of ["ctrlKey", "metaKey", "altKey"]) {
      expect(remoteAction({ key, [modifier]: true })).toBeNull();
    }
  }
  expect(remoteAction({ key: "A", shiftKey: true })).toBe("backward-minute");
  expect(remoteAction({ key: "a", shiftKey: true })).toBe("backward-minute");
  expect(remoteAction({ key: "D", shiftKey: true })).toBe("forward-minute");
  expect(remoteAction({ key: "d", shiftKey: true })).toBe("forward-minute");
  expect(remoteAction({ key: "F", shiftKey: true })).toBe("previous");
  expect(remoteAction({ key: "f", shiftKey: true })).toBe("previous");
  expect(remoteAction({ key: "Unidentified", keyCode: 46 })).toBe("delete");
});

test("hover positions match range thumb travel, clamp endpoints, and round to the seek step", () => {
  expect(seekPosition(106, 100, 212, 300)).toBe(0);
  expect(seekPosition(206, 100, 212, 300)).toBe(150);
  expect(seekPosition(306, 100, 212, 300)).toBe(300);
  expect(seekPosition(0, 100, 212, 300)).toBe(0);
  expect(seekPosition(500, 100, 212, 300)).toBe(300);
  expect(seekPosition(203.999999, 100, 212, 300)).toBe(147);
});


test("stream choices support a Stash reverse-proxy path without accepting other paths", () => {
  const scene = {id: "9", paths: {stream: "https://stash.test/library/scene/9/stream?token=test"}, sceneStreams: [
    {url: "https://stash.test/library/scene/9/stream.mp4"},
    {url: "https://stash.test/scene/9/stream"},
    {url: "https://stash.test/library/scene/10/stream"},
    {url: "https://other.test/library/scene/9/stream"}
  ]};
  const sources = streamChoices(scene, "https://stash.test", "/library/");
  expect(sources).toHaveLength(2);
  expect(sources[0].url).toContain("?token=test");
  expect(sourceAt(sources[1], 60)).toContain("start=60");
});


test("truncated WebM duration recovers to the same-resolution MP4 only", () => {
  const sources = [
    {url: "https://stash.test/scene/1/stream.webm?resolution=LOW"},
    {url: "https://stash.test/scene/1/stream.mp4?resolution=STANDARD"},
    {url: "https://stash.test/scene/1/stream.mp4?resolution=LOW"},
  ];
  expect(truncatedWebmFallback(sources, 0, 30, 52, 3)).toBe(2);
  expect(truncatedWebmFallback(sources, 0, 30, 52, Infinity)).toBe(-1);
  expect(truncatedWebmFallback(sources, 0, 30, 52, 22)).toBe(-1);
  expect(truncatedWebmFallback(sources, 0, 52.1, 52.2, 0.2)).toBe(-1);
  expect(truncatedWebmFallback(sources, 2, 30, 52, 3)).toBe(-1);
  expect(truncatedWebmFallback(sources.slice(0, 2), 0, 30, 52, 3)).toBe(-1);
});
