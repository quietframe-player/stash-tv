import { expect, test } from "bun:test";
import { randomScenes } from "../plugins/stash-tv/web/multiview.js";

test("multiview selects distinct random scenes without the primary or other active slots", () => {
  expect(randomScenes(["1", "2", "2", "3", "4", "5"], 3, ["1", "4"], () => 0.9)).toEqual(["5", "3", "2"]);
  expect(randomScenes(["1", "2"], 4, ["1"], () => 0)).toEqual(["2"]);
  expect(randomScenes(["1"], 3, ["1"], () => 0)).toEqual([]);
});
