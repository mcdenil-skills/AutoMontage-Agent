import { useCurrentFrame, useVideoConfig } from 'remotion';
import { SceneFrame, TextBox, useEntrance } from './parts';
import { motionTheme as t, revealProgress } from './motion-theme';

export const KineticTitle = ({ text, emphasis, caption, durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const words = text.split(/(\s+)/);
  const wordCount = words.filter((word) => word.trim()).length;
  let index = 0;
  const emphasisStart = emphasis ? text.indexOf(emphasis) : -1;
  let offset = 0;
  const line = useEntrance(durationInFrames, 1, 2);
  return <SceneFrame caption={caption}>
    <TextBox text={text} height={760} maxSize={112} weight={750}>
      {words.map((word, key) => {
        const begin = offset;
        offset += word.length;
        if (!word.trim()) return word;
        const progress = revealProgress(frame, fps, durationInFrames, index++, wordCount, 0.22);
        const accented = emphasisStart >= 0 && begin < emphasisStart + emphasis.length && offset > emphasisStart;
        return <span key={key} style={{ opacity: progress, color: accented ? t.accent : t.ink }}>{word}</span>;
      })}
    </TextBox>
    <div aria-hidden="true" style={{ height: 12, background: t.accent, width: 160, borderRadius: 6, ...line }} />
  </SceneFrame>;
};
