import { Img, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { brollClipVolume } from '../scenes/BrollMedia';
import { SceneFrame, TextBox, useEntrance } from './parts';
import { clamp01, motionTheme as t } from './motion-theme';

export const mediaPlaybackProps = (media, fps) => ({
  trimBefore: Math.round((media.trimStartSec ?? 0) * fps),
  muted: (media.audioMode ?? 'mute') === 'mute',
  objectFit: media.fit,
});

export const MediaScene = ({ media, overlayText, caption, durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const presentation = mediaPlaybackProps(media, fps);
  const overlayEntry = useEntrance(durationInFrames, 1, 2);
  const zoom = 1 + 0.025 * clamp01(frame / Math.max(1, durationInFrames - 1));
  // Contain preserves every reviewed image edge; cover allows a restrained camera move.
  const style = { width: '100%', height: '100%', objectFit: presentation.objectFit,
    transform: `scale(${media.fit === 'cover' ? zoom : 1})` };
  return <SceneFrame caption={caption}>
    <div style={{ height: overlayText ? 600 : 890, flexShrink: 0, borderRadius: t.radius,
      overflow: 'hidden', background: t.panel, border: `1px solid ${t.line}`,
    }}>
      {media.kind === 'image' ? <Img src={staticFile(media.src)} style={style} /> : <OffthreadVideo
        src={staticFile(media.src)} trimBefore={presentation.trimBefore} muted={presentation.muted}
        volume={presentation.muted ? undefined : (localFrame) => brollClipVolume({
          mode: media.audioMode, localFrame, durationInFrames, fps,
        })} style={style}
      />}
    </div>
    {overlayText && <TextBox text={overlayText} height={300} maxSize={72} weight={750} style={overlayEntry} />}
  </SceneFrame>;
};
