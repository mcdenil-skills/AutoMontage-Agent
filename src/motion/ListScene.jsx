import { SceneFrame, TextBox, useEntrance } from './parts';
import { motionTheme as t } from './motion-theme';

const ListItem = ({ text, index, count, durationInFrames }) => {
  const entry = useEntrance(durationInFrames, index, count);
  return <div style={{ display: 'flex', gap: 24, padding: '24px 28px', background: t.panel,
    borderRadius: 24, border: `1px solid ${t.line}`, ...entry,
  }}>
    <span style={{ color: t.accent, fontWeight: 750, fontSize: 32, paddingTop: 4 }}>{String(index + 1).padStart(2, '0')}</span>
    <div style={{ flex: 1, minWidth: 0 }}><TextBox text={text} height={128} maxSize={46} weight={500} /></div>
  </div>;
};
export const ListScene = ({ title, items, caption, durationInFrames }) => <SceneFrame caption={caption}>
  {title && <TextBox text={title} height={200} maxSize={70} weight={750} />}
  <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
    {items.map((item, index) => <ListItem key={index} text={item} index={index} count={items.length} durationInFrames={durationInFrames} />)}
  </div>
</SceneFrame>;
