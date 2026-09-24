const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { finiteNumber } = require('./build-options');
const { captureTool, hostPath, runTool } = require('./process');

const MODERN_FILTER_SCRIPT_OPTION = '-/filter_complex';
const LEGACY_FILTER_SCRIPT_OPTION = '-filter_complex_script';
const FILTER_RATE = /^[1-9]\d{0,9}\/[1-9]\d{0,9}$/;
const CHANNEL_LAYOUTS = new Set(['mono', 'stereo']);

function validateIntervals(intervals) {
  if (!Array.isArray(intervals) || intervals.length === 0) {
    throw new Error('нужен хотя бы один keep-интервал');
  }
  let previousEnd = -1;
  return intervals.map((interval) => {
    if (!Array.isArray(interval) || interval.length !== 2) {
      throw new Error('keep-интервал должен содержать start и end');
    }
    const start = Number(interval[0]);
    const end = Number(interval[1]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw new Error('keep-интервал должен быть конечным и иметь end > start >= 0');
    }
    if (start < previousEnd) throw new Error('keep-интервалы пересекаются');
    previousEnd = end;
    return [start, end];
  });
}

function validateSegments(segments, inputCount) {
  if (!Number.isSafeInteger(inputCount) || inputCount < 1) {
    throw new Error('нужен хотя бы один входной файл');
  }
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('нужен хотя бы один сегмент');
  }
  return segments.map((segment) => {
    const input = Number(segment?.input);
    const start = Number(segment?.start);
    const end = Number(segment?.end);
    if (!Number.isSafeInteger(input) || input < 0 || input >= inputCount) {
      throw new Error('сегмент ссылается на несуществующий входной файл');
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw new Error('сегмент должен быть конечным и иметь end > start >= 0');
    }
    return { input, start, end };
  });
}

function time(value, precision) {
  return precision == null ? String(value) : value.toFixed(precision);
}

function buildSegmentsConcatFilter(segments, {
  inputCount = 1,
  audioFadeSec = 0,
  precision = null,
  fps = null,
  audioFormat = null,
} = {}) {
  const list = validateSegments(segments, inputCount);
  const fade = finiteNumber(audioFadeSec, 'audio fade', { min: 0, max: 1 });
  if (fps !== null && !FILTER_RATE.test(String(fps))) {
    throw new Error('FPS для склейки должен быть дробью вида 30000/1001');
  }
  if (audioFormat !== null) {
    if (typeof audioFormat.sampleRate !== 'number') {
      throw new Error('audio sample rate должен быть числом');
    }
    finiteNumber(audioFormat.sampleRate, 'audio sample rate', { min: 8000, max: 384000, integer: true });
    if (!CHANNEL_LAYOUTS.has(audioFormat.channelLayout)) {
      throw new Error('раскладка каналов должна быть mono или stereo');
    }
  }
  let filter = '';
  let videoInputs = '';
  let audioInputs = '';
  list.forEach(({ input, start, end }, index) => {
    const startText = time(start, precision);
    const endText = time(end, precision);
    filter += `[${input}:v]trim=${startText}:${endText},setpts=PTS-STARTPTS`;
    if (fps !== null) filter += `,fps=${fps}`;
    filter += `[v${index}];`;
    filter += `[${input}:a]atrim=${startText}:${endText},asetpts=PTS-STARTPTS`;
    if (audioFormat !== null) {
      filter += `,aformat=sample_rates=${audioFormat.sampleRate}:channel_layouts=${audioFormat.channelLayout}`;
    }
    if (fade > 0) {
      const fadeOutStart = Math.max(0, end - start - fade);
      filter += `,afade=t=in:st=0:d=${fade},afade=t=out:st=${time(fadeOutStart, precision)}:d=${fade}`;
    }
    filter += `[a${index}];`;
    videoInputs += `[v${index}]`;
    audioInputs += `[a${index}]`;
  });
  return `${filter}${videoInputs}concat=n=${list.length}:v=1:a=0[vout];${audioInputs}concat=n=${list.length}:v=0:a=1[aout]`;
}

function buildConcatFilter(intervals, {
  audioFadeSec = 0,
  precision = null,
} = {}) {
  const keep = validateIntervals(intervals);
  return buildSegmentsConcatFilter(
    keep.map(([start, end]) => ({ input: 0, start, end })),
    { inputCount: 1, audioFadeSec, precision },
  );
}

// FFmpeg 7.0 добавил синтаксис `-/option <file>`, а FFmpeg 9 удалил `-filter_complex_script`.
// Сборки без номера версии (git master) новее 7.0, поэтому получают современную форму.
function filterScriptOptionForVersion(versionOutput) {
  const match = /^ffmpeg version n?(\d+)\./m.exec(String(versionOutput || ''));
  if (match && Number(match[1]) < 7) return LEGACY_FILTER_SCRIPT_OPTION;
  return MODERN_FILTER_SCRIPT_OPTION;
}

function detectFilterScriptOption({ capture = captureTool } = {}) {
  try {
    return filterScriptOptionForVersion(capture('ffmpeg', ['-hide_banner', '-version'], {
      stage: 'ffmpeg version',
      maxBuffer: 1024 * 1024,
    }));
  } catch (_) {
    // Сам запуск ffmpeg ниже сообщит понятную ошибку об отсутствии инструмента.
    return MODERN_FILTER_SCRIPT_OPTION;
  }
}

function filterScriptCommand(inputs, output, filterPath, {
  filterScriptOption = MODERN_FILTER_SCRIPT_OPTION,
} = {}) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error('нужен хотя бы один входной файл');
  }
  if (![MODERN_FILTER_SCRIPT_OPTION, LEGACY_FILTER_SCRIPT_OPTION].includes(filterScriptOption)) {
    throw new Error('неизвестная опция filter script для ffmpeg');
  }
  return {
    command: 'ffmpeg',
    args: [
      '-y',
      ...inputs.flatMap((input) => ['-i', hostPath(input)]),
      filterScriptOption, hostPath(filterPath),
      '-map', '[vout]',
      '-map', '[aout]',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
      '-c:a', 'aac',
      hostPath(output),
    ],
  };
}

function trimCommand(input, output, filterPath, options = {}) {
  return filterScriptCommand([input], output, filterPath, options);
}

function defaultFilterPath() {
  return path.join(os.tmpdir(), `automontage-trim-${randomUUID()}.txt`);
}

function runFilterScript({ inputs, output, filter, filterPath, stage }, {
  fileSystem = fs,
  run = runTool,
  filterScriptOption = null,
  detectOption = detectFilterScriptOption,
} = {}) {
  const resolvedFilterPath = hostPath(filterPath);
  try {
    fileSystem.writeFileSync(resolvedFilterPath, filter);
    const command = filterScriptCommand(inputs, output, resolvedFilterPath, {
      filterScriptOption: filterScriptOption || detectOption(),
    });
    run(command.command, command.args, { stage });
    return command;
  } finally {
    if (fileSystem.existsSync(resolvedFilterPath)) fileSystem.unlinkSync(resolvedFilterPath);
  }
}

function runTrim({
  input,
  output,
  intervals,
  audioFadeSec = 0,
  precision = null,
  filterPath = defaultFilterPath(),
}, dependencies = {}) {
  const filter = buildConcatFilter(intervals, { audioFadeSec, precision });
  return runFilterScript({
    inputs: [input], output, filter, filterPath, stage: 'trim encode',
  }, dependencies);
}

function runSegmentsTrim({
  inputs,
  output,
  segments,
  audioFadeSec = 0,
  precision = null,
  fps = null,
  audioFormat = null,
  filterPath = defaultFilterPath(),
}, dependencies = {}) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error('нужен хотя бы один входной файл');
  }
  const filter = buildSegmentsConcatFilter(segments, {
    inputCount: inputs.length, audioFadeSec, precision, fps, audioFormat,
  });
  return runFilterScript({
    inputs, output, filter, filterPath, stage: 'takes encode',
  }, dependencies);
}

module.exports = {
  LEGACY_FILTER_SCRIPT_OPTION,
  MODERN_FILTER_SCRIPT_OPTION,
  buildConcatFilter,
  buildSegmentsConcatFilter,
  detectFilterScriptOption,
  filterScriptCommand,
  filterScriptOptionForVersion,
  runSegmentsTrim,
  runTrim,
  trimCommand,
  validateIntervals,
};
