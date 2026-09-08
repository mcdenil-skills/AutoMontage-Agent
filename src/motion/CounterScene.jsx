import { useCurrentFrame, useVideoConfig } from 'remotion';
import { SceneFrame, TextBox } from './parts';
import { clamp01, easeOut, motionTheme as t } from './motion-theme';

export const counterValue = (frame, fps, durationInFrames, value) => {
  const end = Math.min(fps * 1.8, durationInFrames - 1);
  if (end <= 0 || frame >= end) return value;
  if (frame <= 0) return 0;
  return value * easeOut(frame / end);
};

// Preserve the exact approved decimal/exponent at rest; intermediate numbers are readable.
export const formatCounter = (value, approved) => {
  if (value === approved) return String(approved);
  if (Math.abs(approved) >= 1e12 || (Math.abs(approved) > 0 && Math.abs(approved) < 0.001)) return value.toPrecision(4);
  const decimals = Math.min(6, (String(approved).split('.')[1] || '').length);
  return value.toFixed(decimals);
};

export const CounterScene = ({ label, value, prefix = '', suffix = '', caption, durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const current = counterValue(frame, fps, durationInFrames, value);
  const end = Math.min(fps * 1.8, durationInFrames - 1);
  const progress = end <= 0 ? 1 : clamp01(frame / end);
  return <SceneFrame caption={caption}>
    <TextBox text={label} height={260} maxSize={76} weight={600} />
    {prefix && <TextBox text={prefix} height={80} maxSize={52} style={{ color: t.muted }} />}
    <TextBox data-counter-value={current} text={formatCounter(current, value)} height={390} maxSize={190} weight={800}
      style={{ color: t.accent, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflowWrap: 'normal' }} />
    {suffix && <TextBox text={suffix} height={90} maxSize={54} style={{ color: t.muted }} />}
    <div aria-hidden="true" style={{ height: 14, background: t.line, borderRadius: 7 }}>
      <div style={{ width: `${progress * 100}%`, height: '100%', background: t.accent, borderRadius: 7 }} />
    </div>
  </SceneFrame>;
};
