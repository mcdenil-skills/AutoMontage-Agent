const fs = require('node:fs');

const { frameRateFromFps } = require('../review/media-time');
const { collectWords } = require('../tighten');
const { publishSourceRevision, roundedTime } = require('./source-revision');
const { assertCompatibleTakes, describeTake } = require('./takes');
const {
  assertTakesEditShape,
  remapTakeRangesTranscript,
  snapTakeRanges,
  takesTrimPlan,
  validateTakeRanges,
} = require('./takes-edit');
const { resolveProjectPath } = require('./workspace');

function buildTakesMaster({ workspace, edit, editRelative, source }, dependencies) {
  const {
    fileSystem = fs,
    probeVideoImpl,
    probeMediaPathImpl,
    runSegmentsTrimImpl,
  } = dependencies;
  const normalized = assertTakesEditShape(edit, { sourceRevision: source.revision });
  const registry = workspace.manifest.takes || [];
  if (!registry.length) {
    throw new Error('project has no registered takes; run automontage takes add first');
  }
  const takes = new Map();
  for (const range of normalized.ranges) {
    if (takes.has(range.take)) continue;
    const entry = registry.find((take) => take.id === range.take);
    if (!entry) throw new Error(`takes edit references unknown take ${range.take}`);
    const filePath = resolveProjectPath(workspace.dir, entry.localPath, {
      label: `${entry.id} path`, fileSystem, mustExist: true, type: 'file',
    });
    const transcriptPath = resolveProjectPath(workspace.dir, entry.transcriptPath, {
      label: `${entry.id} transcript path`, fileSystem, mustExist: true, type: 'file',
    });
    const take = describeTake(entry.id, {
      filePath,
      video: probeVideoImpl(filePath, { stage: `${entry.id} probe` }),
      media: probeMediaPathImpl(filePath, { stage: `${entry.id} media probe` }),
    });
    takes.set(entry.id, { ...take, transcriptPath });
  }
  const used = [...takes.values()];
  assertCompatibleTakes(used);
  validateTakeRanges(normalized.ranges, takes);
  const [first] = used;
  const ranges = snapTakeRanges(normalized.ranges, { fps: first.fps, takes });
  const wordsByTake = new Map(used.map((take) => {
    try {
      return [take.id, collectWords(JSON.parse(fileSystem.readFileSync(take.transcriptPath, 'utf8')))];
    } catch (error) {
      // Без имени дубля непонятно, у какого из нескольких кусков сломан транскрипт.
      error.message = `${take.id} transcript: ${error.message}`;
      throw error;
    }
  }));
  const words = remapTakeRangesTranscript(ranges, wordsByTake, first.fps);
  const duration = ranges.reduce((sum, range) => sum + range.end - range.start, 0);
  const rate = frameRateFromFps(first.fps);
  const { inputs, segments } = takesTrimPlan(ranges, takes);
  const result = publishSourceRevision({
    workspace,
    source,
    editRelative,
    words,
    duration,
    fps: first.fps,
    expected: { width: first.width, height: first.height },
    encode(output) {
      runSegmentsTrimImpl({
        inputs,
        output,
        segments,
        audioFadeSec: 0.04,
        precision: 6,
        fps: `${rate.numerator}/${rate.denominator}`,
        // Порядок кусков не должен понижать качество звука: берём максимальный sample rate
        // и stereo, если хотя бы один из использованных дублей многоканальный.
        audioFormat: {
          sampleRate: Math.max(...used.map((take) => take.audioSampleRate)),
          channelLayout: used.some((take) => take.audioChannels >= 2) ? 'stereo' : 'mono',
        },
      });
    },
  }, dependencies);
  return {
    ...result,
    kind: 'takes',
    duration: roundedTime(duration, first.fps),
    takes: used.map((take) => take.id),
    ranges: ranges.map(({ take, start, end, beat }) => ({
      take,
      start: roundedTime(start, first.fps),
      end: roundedTime(end, first.fps),
      beat,
    })),
  };
}

module.exports = { buildTakesMaster };
