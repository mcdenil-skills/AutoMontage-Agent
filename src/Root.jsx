import { Composition } from 'remotion';
import { Timeline } from './Timeline';
import { scenario } from './scenario';
import { scenarioCaptions } from './scenario-captions';
import { scenarioBroll } from './scenario-broll';
import { scenarioJob1 } from './scenario-job1';
import { scenarioJob1V } from './scenario-job1v';
import { scenarioPreview } from './scenario-preview';
import { scenarioPreviewH } from './scenario-preview-h';
import { LessonComp } from './LessonComp';
import { lessonSample } from './data/lesson-sample';
import { LessonSequence } from './LessonSequence';
import { lessonSeqDemo } from './data/lesson-seq-demo';
import { LessonVertical } from './LessonVertical';
import { SceneDirector } from './SceneDirector';
import { MotionDirector } from './MotionDirector';

export const RemotionRoot = () => {
  return (
    <>
      <Composition
        id="MotionReel"
        component={MotionDirector}
        durationInFrames={300}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{ theme: 'motion-neutral', scenes: [], durationInFrames: 300, fps: 30, width: 1080, height: 1920 }}
        calculateMetadata={({ props }) => ({
          durationInFrames: props.durationInFrames,
          fps: props.fps,
          width: props.width,
          height: props.height,
        })}
      />
      <Composition
        id="Reel"
        component={Timeline}
        durationInFrames={360}
        fps={30}
        width={720}
        height={1280}
        defaultProps={scenario}
      />
      {/* Демо этапа 4: авто-субтитры (12с) */}
      <Composition
        id="ReelCaptions"
        component={Timeline}
        durationInFrames={360}
        fps={30}
        width={720}
        height={1280}
        defaultProps={scenarioCaptions}
      />
      {/* Демо этапа 3: broll-врезка (12с) */}
      <Composition
        id="ReelBroll"
        component={Timeline}
        durationInFrames={360}
        fps={30}
        width={720}
        height={1280}
        defaultProps={scenarioBroll}
      />
      {/* Боевой ролик (горизонт) */}
      <Composition
        id="Job1"
        component={Timeline}
        durationInFrames={350}
        fps={25}
        width={1870}
        height={1080}
        defaultProps={scenarioJob1}
        calculateMetadata={({ props }) => ({
          durationInFrames: props.durationInFrames || 350,
          width: props.width || 1870,
          height: props.height || 1080,
          fps: props.fps || 25,
        })}
      />
      {/* Боевой ролик – вертикальная версия (reframe + нейтральные broll) */}
      <Composition
        id="Job1V"
        component={Timeline}
        durationInFrames={350}
        fps={25}
        width={1080}
        height={1920}
        defaultProps={scenarioJob1V}
      />
      {/* ПРЕВЬЮ-ролик (вертикаль, зум-ритм + врезки + плашки) */}
      <Composition
        id="Preview"
        component={Timeline}
        durationInFrames={350}
        fps={25}
        width={1080}
        height={1920}
        defaultProps={scenarioPreview}
      />
      {/* ПРЕВЬЮ-ролик ГОРИЗОНТАЛЬНЫЙ (как исходник, 720p под Telegram) */}
      <Composition
        id="PreviewH"
        component={Timeline}
        durationInFrames={350}
        fps={25}
        width={1280}
        height={720}
        defaultProps={scenarioPreviewH}
      />
      {/* Шаблон lesson-presentation (16:9): карточка спикера + слайд-панель.
          theme приходит из props (строка или объект-тема из внешнего бренд-пака). */}
      <Composition
        id="Lesson"
        component={LessonComp}
        durationInFrames={90}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={lessonSample}
      />
      {/* lesson-presentation: секвенсор слайдов по таймкодам + карточка спикера */}
      <Composition
        id="LessonSeq"
        component={LessonSequence}
        durationInFrames={240}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={lessonSeqDemo}
        calculateMetadata={({ props }) => {
          const fps = props.fps || 30;
          const last = (props.slides || []).reduce((m, s) => Math.max(m, s.end ?? 0), 0);
          const dur = props.durationInFrames || Math.max(60, Math.round((last || 8) * fps));
          return { durationInFrames: dur, fps, width: props.width || 1920, height: props.height || 1080 };
        }}
      />
      {/* lesson-vertical: вертикаль 9:16 для Stories/Shorts (спикер сверху, слайд снизу) */}
      <Composition
        id="LessonVert"
        component={LessonVertical}
        durationInFrames={90}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{ theme: 'lesson-neutral', slide: lessonSample.slide, videoTitle: 'ВИДЕО', name: 'Спикер', role: '' }}
      />
      {/* Режиссёр сцен (вертикаль 9:16): список сцен по таймкодам + переходы + сейф-зона */}
      <Composition
        id="ReelScenes"
        component={SceneDirector}
        durationInFrames={300}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{ theme: 'lesson-neutral', videoTitle: 'ВИДЕО', scenes: [] }}
        calculateMetadata={({ props }) => {
          const fps = props.fps || 30;
          const last = (props.scenes || []).reduce((m, s) => Math.max(m, s.end ?? 0), 0);
          return { durationInFrames: props.durationInFrames || Math.max(30, Math.round((last || 10) * fps)), fps, width: props.width || 1080, height: props.height || 1920 };
        }}
      />
      {/* Пайплайн: размеры и длина берутся из props (любой аспект/длительность) */}
      <Composition
        id="Dynamic"
        component={Timeline}
        durationInFrames={300}
        fps={30}
        width={720}
        height={1280}
        defaultProps={scenario}
        calculateMetadata={({ props }) => ({
          props: { ...props, beatZoom: props.beatZoom ?? false, beatSec: props.beatSec ?? 3 },
          durationInFrames: props.durationInFrames || 300,
          width: props.width || 720,
          height: props.height || 1280,
          fps: props.fps || 30,
        })}
      />
    </>
  );
};
