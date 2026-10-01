import { expect, test } from "bun:test";
import { randomScenes } from "../plugins/stash-tv/web/multiview.js";
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
