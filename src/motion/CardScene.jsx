import { SceneFrame, TextBox, Panel, useEntrance } from './parts';
import { motionTheme as t } from './motion-theme';

export const CardScene = ({ title, body, caption, durationInFrames }) => {
  const entry = useEntrance(durationInFrames);
  const bodyEntry = useEntrance(durationInFrames, 1, 2);
  return <SceneFrame caption={caption}>
    <Panel style={entry}>
      <div style={{ height: 8, width: 80, background: t.accent, borderRadius: 4, marginBottom: 30 }} />
      <TextBox text={title} height={260} maxSize={80} weight={750} />
      {body && <TextBox text={body} height={480} maxSize={52} weight={400} style={{ color: t.muted, marginTop: 32, ...bodyEntry }} />}
    </Panel>
  </SceneFrame>;
};
