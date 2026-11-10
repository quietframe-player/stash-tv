import { playbackFeature, playbackRateFeature, timeFeature, volumeFeature } from "@videojs/core/dom";
import { combine, createStore } from "@videojs/store";

const playback = combine(playbackFeature, playbackRateFeature, timeFeature, volumeFeature);

export function attachPlayback(video) {
  const store = createStore()(playback);
  store.attach({ media: video, container: null });
  return store;
}
