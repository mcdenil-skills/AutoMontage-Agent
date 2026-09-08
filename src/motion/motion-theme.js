// Original public defaults: matte paper, ink, blue emphasis. No external brand pack.
export const motionTheme = Object.freeze({
  background: '#EDF0F4', panel: '#FFFFFF', ink: '#202A36', muted: '#546477',
  accent: '#335E99', accentSoft: '#DEE7F3', line: '#C3CEDB',
  fontFamily: 'Onest, sans-serif', radius: 32,
});

// Durations are in seconds; scene-local frames are the only animation clock.
export const motionPresets = Object.freeze({ entranceSec: 0.45, eventSec: 1.8, risePx: 24 });

export const clamp01 = (value) => Math.max(0, Math.min(1, value));
export const easeOut = (value) => 1 - (1 - clamp01(value)) ** 3;

export const revealProgress = (frame, fps, durationInFrames, index = 0, count = 1, spacingSec = motionPresets.eventSec) => {
  const last = Math.max(0, durationInFrames - 1);
  if (last === 0) return 1;
  const entrance = Math.min(fps * motionPresets.entranceSec, last / Math.max(2, count));
  const spacing = count > 1 ? Math.min(fps * spacingSec, (last - entrance) / (count - 1)) : 0;
  // Keep the opening event perceptible on the first frame of a hard cut.
  const progress = easeOut((frame - index * spacing) / entrance);
  return index === 0 && frame >= 0 ? Math.max(0.12, progress) : progress;
};
