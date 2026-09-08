import { AbsoluteFill, Audio, Sequence, staticFile, useVideoConfig } from 'remotion';
import { FontStyle } from './fonts';
import { sourceVolumeForFrame } from './scenes/BrollMedia';
import { KineticTitle } from './motion/KineticTitle';
import { CardScene } from './motion/CardScene';
import { StepsScene } from './motion/StepsScene';
import { ListScene } from './motion/ListScene';
import { CounterScene } from './motion/CounterScene';
import { MediaScene } from './motion/MediaScene';
import { CtaScene } from './motion/CtaScene';
import { motionTheme } from './motion/motion-theme';

export const MOTION_COMPONENTS = {
  'kinetic-title': KineticTitle, card: CardScene, steps: StepsScene, list: ListScene,
  counter: CounterScene, media: MediaScene, cta: CtaScene,
};

export const getMotionTiming = (scene, fps) => {
  const from = Math.round(scene.start * fps);
  return { from, durationInFrames: Math.max(1, Math.round(scene.end * fps) - from) };
};

export const MotionDirector = ({ theme = 'motion-neutral', scenes = [], audioSrc, draftPreview = false }) => {
  const { fps, width } = useVideoConfig();
  if (theme !== 'motion-neutral') throw new Error(`Unknown public motion theme: ${theme}`);
  const timedScenes = scenes.map((scene) => ({ scene, ...getMotionTiming(scene, fps),
    audioMode: scene.media?.kind === 'video' ? scene.media.audioMode ?? 'mute' : null,
  }));
  return <AbsoluteFill style={{ background: motionTheme.background, fontFamily: motionTheme.fontFamily }}>
    <FontStyle />
    {audioSrc && <Audio src={staticFile(audioSrc)} volume={(frame) => sourceVolumeForFrame({ frame, scenes: timedScenes, fps })} />}
    {timedScenes.map(({ scene, from, durationInFrames }, index) => {
      const Component = MOTION_COMPONENTS[scene.scene];
      if (!Component) throw new Error(`Unknown motion scene: ${scene.scene}`);
      return <Sequence key={index} from={from} durationInFrames={durationInFrames}>
        <Component {...scene} durationInFrames={durationInFrames} />
      </Sequence>;
    })}
    {draftPreview && <div data-draft-preview-watermark="true" style={{ position: 'absolute',
      top: '5%', left: '7%', zIndex: 1000, padding: '10px 18px', borderRadius: 8,
      color: motionTheme.ink, background: motionTheme.panel, fontWeight: 800,
      fontSize: width * 0.03, opacity: 0.8,
    }}>ЧЕРНОВИК</div>}
  </AbsoluteFill>;
};
