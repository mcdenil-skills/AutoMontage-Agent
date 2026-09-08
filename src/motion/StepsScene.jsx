import { useCurrentFrame, useVideoConfig } from 'remotion';
import { SceneFrame, TextBox } from './parts';
import { motionTheme as t, revealProgress } from './motion-theme';

export const stepState = (frame, fps, durationInFrames, count) => {
  const progress = (index) => revealProgress(frame, fps, durationInFrames, index, count * 2 - 1, 0.9);
  return {
    nodes: Array.from({ length: count }, (_, index) => progress(index * 2)),
    connectors: Array.from({ length: count - 1 }, (_, index) => progress(index * 2 + 1)),
  };
};

export const StepsScene = ({ title, steps, caption, durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const state = stepState(frame, fps, durationInFrames, steps.length);
  return <SceneFrame caption={caption}>
    {title && <TextBox text={title} height={210} maxSize={70} weight={750} />}
    <div>{steps.map((step, index) => <div key={index}>
      {index > 0 && <div data-step-connector={index} style={{ height: 42, width: 4, marginLeft: 31,
        background: t.accent, transform: `scaleY(${state.connectors[index - 1]})`, transformOrigin: 'top',
      }} />}
      <div data-step-node={index} style={{ display: 'flex', alignItems: 'center', gap: 24, opacity: state.nodes[index] }}>
        <div style={{ width: 66, height: 66, flexShrink: 0, borderRadius: '50%', background: t.accent,
          color: t.panel, display: 'flex', justifyContent: 'center', alignItems: 'center', fontSize: 30, fontWeight: 700,
        }}>{index + 1}</div>
        <div style={{ flex: 1, minWidth: 0, padding: '20px 26px', background: t.panel, borderRadius: 24, border: `1px solid ${t.line}` }}>
          <TextBox text={step} height={112} maxSize={48} />
        </div>
      </div>
    </div>)}</div>
  </SceneFrame>;
};
