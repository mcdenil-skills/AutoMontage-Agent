import { useLayoutEffect, useRef } from 'react';
import { cancelRender, continueRender, delayRender, useCurrentFrame, useVideoConfig } from 'remotion';
import { safeFor } from '../scenes/safezone';
import { motionTheme as t, motionPresets, revealProgress } from './motion-theme';

export const MOTION_WIDTH = 1080;
export const MOTION_HEIGHT = 1920;
const safe = safeFor(MOTION_WIDTH, MOTION_HEIGHT);
export const CONTENT_WIDTH = MOTION_WIDTH - safe.left - safe.right;

// Font fit uses the real bundled Cyrillic font, not a Latin character-width estimate.
// Wait for fit before capturing a frame. No clipping, truncation or omitted words.
export const TextBox = ({ text, children, height, maxSize = 64, weight = 600, style = {}, ...data }) => {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const handle = delayRender('Fit motion text');
    let cancelled = false;
    const fit = async () => {
      try {
        await document.fonts.load(`${weight} ${maxSize}px Onest`);
        if (cancelled || !ref.current) return;
        const el = ref.current;
        const computed = getComputedStyle(el);
        const availableHeight = el.clientHeight - parseFloat(computed.paddingTop) - parseFloat(computed.paddingBottom);
        let low = 1;
        let high = maxSize;
        while (high - low > 0.25) {
          const size = (low + high) / 2;
          el.style.fontSize = `${size}px`;
          const content = el.firstElementChild;
          const fits = content.scrollWidth <= el.clientWidth + 1
            && content.offsetHeight <= availableHeight;
          if (fits) low = size;
          else high = size;
        }
        el.style.fontSize = `${Math.floor(low * 4) / 4}px`;
      } catch (error) {
        if (!cancelled) cancelRender(error);
      } finally {
        continueRender(handle);
      }
    };
    fit();
    return () => { cancelled = true; continueRender(handle); };
  }, [text, height, maxSize, weight]);
  return <div ref={ref} data-motion-text="true" {...data} style={{
    width: '100%', height, flexShrink: 0, fontSize: maxSize, fontWeight: weight,
    lineHeight: 1.16, overflowWrap: 'anywhere', whiteSpace: 'normal', ...style,
  }}><div>{children ?? text}</div></div>;
};

export const useEntrance = (durationInFrames, index = 0, count = 1, spacingSec) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = revealProgress(frame, fps, durationInFrames, index, count, spacingSec);
  return { opacity: progress, transform: `translateY(${(1 - progress) * motionPresets.risePx}px)` };
};

export const SceneFrame = ({ children, caption }) => {
  const { width, height } = useVideoConfig();
  const scale = Math.min(width / MOTION_WIDTH, height / MOTION_HEIGHT);
  return <div style={{ position: 'absolute', width: MOTION_WIDTH, height: MOTION_HEIGHT,
    left: (width - MOTION_WIDTH * scale) / 2, top: (height - MOTION_HEIGHT * scale) / 2,
    transform: `scale(${scale})`, transformOrigin: 'top left',
    color: t.ink, fontFamily: t.fontFamily,
  }}>
    <div aria-hidden="true" style={{ position: 'absolute', top: 175, left: safe.left, width: 70, height: 8, background: t.accent, borderRadius: 4 }} />
    <div data-motion-safe="true" style={{ position: 'absolute', top: safe.top, left: safe.left,
      width: CONTENT_WIDTH, height: MOTION_HEIGHT - safe.top - safe.bottom,
      display: 'flex', flexDirection: 'column', gap: 30,
    }}>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 28 }}>{children}</div>
      {caption && <TextBox data-motion-caption="true" text={caption} height={160} maxSize={34} weight={400}
        style={{ color: t.muted, borderTop: `2px solid ${t.line}`, paddingTop: 12, boxSizing: 'border-box' }} />}
    </div>
  </div>;
};

export const Panel = ({ children, style = {} }) => <div style={{
  background: t.panel, borderRadius: t.radius, padding: 38, boxSizing: 'border-box',
  border: `1px solid ${t.line}`, ...style,
}}>{children}</div>;
