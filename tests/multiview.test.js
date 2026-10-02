import { expect, test } from "bun:test";
import { randomScenes, createGridQueue, advanceGrid, randomGrid, gridNeighbours, singleSoundtrack } from "../plugins/stash-tv/web/multiview.js";
import { frameInsets, frameScale } from "../plugins/stash-tv/web/frame-fill.js";

test("multiview selects distinct random scenes without the primary or other active slots", () => {
  expect(randomScenes(["1", "2", "2", "3", "4", "5"], 3, ["1", "4"], () => 0.9)).toEqual(["5", "3", "2"]);
  expect(randomScenes(["1", "2"], 4, ["1"], () => 0)).toEqual(["2"]);
  expect(randomScenes(["1"], 3, ["1"], () => 0)).toEqual([]);
});

function picture(top, bottom, left = 0, right = 0) {
  const pixels = new Uint8ClampedArray(160 * 90 * 4);
  for (let y = top; y < 90 - bottom; y++) for (let x = left; x < 160 - right; x++) {
    const offset = (y * 160 + x) * 4;
    pixels.set([80, 130, 170, 255], offset);
  }
  return pixels;
}

test("solid paired padding is excluded from the picture with a resampling margin", () => {
  expect(frameInsets(picture(10, 10), 160, 90)).toEqual({x:0,y:11/90});
  expect(frameInsets(picture(0, 0, 16, 16), 160, 90)).toEqual({x:17/160,y:0});
  expect(frameInsets(picture(0, 0, 54, 54), 160, 90)).toEqual({x:55/160,y:0});
});

test("black fades and asymmetric dark scenery do not cause a crop", () => {
  expect(frameInsets(picture(45, 45), 160, 90)).toBeNull();
  expect(frameInsets(picture(10, 0), 160, 90)).toEqual({x:0,y:0});
  expect(frameInsets(picture(0, 0), 160, 90)).toEqual({x:0,y:0});
});

test("cropped picture covers portrait tiles without enlarging already-filled wide tiles", () => {
  const crop = {x:0,y:11/90};
  const portrait = frameScale(crop, 854, 480, 195, 422);
  const imageHeight = 422 * portrait;
  expect(422 / 2 - imageHeight / 2 + imageHeight * (58 / 480)).toBeLessThan(0);
  expect(frameScale(crop, 854, 480, 800, 220)).toBe(1);
  expect(frameScale({x:0,y:0}, 854, 480, 195, 422)).toBe(1);
});

const gridIDs = ["1", "2", "3", "4", "5"];
test("complete grids move without duplicate or unchanged feeds, and history restores all tiles", () => {
  const start = createGridQueue(gridIDs, ["1", "3", "4", "5"]);
  const next = advanceGrid(start, 1);
  expect(next.history[next.cursor]).toEqual(["2", "4", "5", "1"]);
  expect(advanceGrid(next, -1).history[0]).toEqual(start.history[0]);
  const random = randomGrid(start, () => 0.99);
  expect(new Set(random.history[random.cursor]).size).toBe(4);
  expect(random.history[random.cursor].every((id,i)=>id!==start.history[0][i])).toBe(true);
  expect(advanceGrid(random,-1).history[0]).toEqual(start.history[0]);
  expect(advanceGrid(advanceGrid(random,-1),1).history[1]).toEqual(random.history[1]);
});
test("grid navigation wraps at both ends and random retries have a distinct bounded fallback", () => {
  const start = createGridQueue(["1","2"], ["1","2"]);
  expect(advanceGrid(start,-1).history[0]).toEqual(["2","1"]);
  expect(randomGrid(start,()=>0).history[1]).toEqual(["2","1"]);
  let queue=start;
  for(let i=0;i<200;i++) queue=advanceGrid(queue,1);
  expect(queue.history.length).toBe(100);
  expect(queue.cursor).toBe(99);
});

test("grid buffering follows actual history and skips scenes already playing in any pane", () => {
  const start = createGridQueue(gridIDs, ["1", "3"]);
  expect(gridNeighbours(start)).toEqual([
    {id:"2",current:false},{id:"4",current:false},{id:"3",current:true},{id:"5",current:false},{id:"1",current:true},
  ]);
  const shuffled = randomGrid(start, () => 0.99);
  const previous = advanceGrid(shuffled, -1);
  expect(gridNeighbours(previous).slice(0, 2).map(item => item.id)).toEqual(shuffled.history[shuffled.cursor]);
  expect(start.history).toEqual([["1", "3"]]);
  expect(gridNeighbours(null)).toEqual([]);
});

test("iPhone and iPad use one soundtrack without applying iOS restrictions to Android or desktop", () => {
  expect(singleSoundtrack("Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)", "iPhone", 5)).toBe(true);
  expect(singleSoundtrack("Mozilla/5.0 (Macintosh; Intel Mac OS X)", "MacIntel", 5)).toBe(true);
  expect(singleSoundtrack("Mozilla/5.0 (Macintosh; Intel Mac OS X)", "MacIntel", 0)).toBe(false);
  expect(singleSoundtrack("Mozilla/5.0 (Linux; Android 16)", "Linux armv8l", 5)).toBe(false);
});
