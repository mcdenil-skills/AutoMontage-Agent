import { SceneFrame, TextBox, Panel, useEntrance } from './parts';
import { motionTheme as t } from './motion-theme';

export const CtaScene = ({ title, action, handle, caption, durationInFrames }) => {
  const titleEntry = useEntrance(durationInFrames);
  const actionEntry = useEntrance(durationInFrames, 1, handle ? 3 : 2);
  const handleEntry = useEntrance(durationInFrames, 2, 3);
  return <SceneFrame caption={caption}>
    <TextBox text={title} height={310} maxSize={90} weight={750} style={titleEntry} />
    <Panel style={{ background: t.accent, color: t.panel, borderColor: t.accent, ...actionEntry }}>
      <TextBox text={action} height={260} maxSize={76} weight={650} />
    </Panel>
    {handle && <TextBox text={handle} height={230} maxSize={54} weight={500} style={{ color: t.muted, ...handleEntry }} />}
  </SceneFrame>;
};
