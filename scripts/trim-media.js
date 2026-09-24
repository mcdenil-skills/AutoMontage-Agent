const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { finiteNumber } = require('./build-options');
const { captureTool, hostPath, runTool } = require('./process');

const MODERN_FILTER_SCRIPT_OPTION = '-/filter_complex';
const LEGACY_FILTER_SCRIPT_OPTION = '-filter_complex_script';

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

function time(value, precision) {
  return precision == null ? String(value) : value.toFixed(precision);
}

function buildConcatFilter(intervals, {
  audioFadeSec = 0,
  precision = null,
} = {}) {
  const keep = validateIntervals(intervals);
  const fade = finiteNumber(audioFadeSec, 'audio fade', { min: 0, max: 1 });
  let filter = '';
  let videoInputs = '';
  let audioInputs = '';
  keep.forEach(([start, end], index) => {
    const startText = time(start, precision);
    const endText = time(end, precision);
    filter += `[0:v]trim=${startText}:${endText},setpts=PTS-STARTPTS[v${index}];`;
    filter += `[0:a]atrim=${startText}:${endText},asetpts=PTS-STARTPTS`;
    if (fade > 0) {
      const fadeOutStart = Math.max(0, end - start - fade);
      filter += `,afade=t=in:st=0:d=${fade},afade=t=out:st=${time(fadeOutStart, precision)}:d=${fade}`;
    }
    filter += `[a${index}];`;
    videoInputs += `[v${index}]`;
    audioInputs += `[a${index}]`;
  });
  return `${filter}${videoInputs}concat=n=${keep.length}:v=1:a=0[vout];${audioInputs}concat=n=${keep.length}:v=0:a=1[aout]`;
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

function trimCommand(input, output, filterPath, {
  filterScriptOption = MODERN_FILTER_SCRIPT_OPTION,
} = {}) {
  if (![MODERN_FILTER_SCRIPT_OPTION, LEGACY_FILTER_SCRIPT_OPTION].includes(filterScriptOption)) {
    throw new Error('неизвестная опция filter script для ffmpeg');
  }
  return {
    command: 'ffmpeg',
    args: [
      '-y',
      '-i', hostPath(input),
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

function runTrim({
  input,
  output,
  intervals,
  audioFadeSec = 0,
  precision = null,
  filterPath = path.join(os.tmpdir(), `automontage-trim-${randomUUID()}.txt`),
}, {
  fileSystem = fs,
  run = runTool,
  filterScriptOption = null,
  detectOption = detectFilterScriptOption,
} = {}) {
  const filter = buildConcatFilter(intervals, { audioFadeSec, precision });
  const resolvedFilterPath = hostPath(filterPath);
  try {
    fileSystem.writeFileSync(resolvedFilterPath, filter);
    const command = trimCommand(input, output, resolvedFilterPath, {
      filterScriptOption: filterScriptOption || detectOption(),
    });
    run(command.command, command.args, { stage: 'trim encode' });
    return command;
  } finally {
    if (fileSystem.existsSync(resolvedFilterPath)) fileSystem.unlinkSync(resolvedFilterPath);
  }
}

module.exports = {
  LEGACY_FILTER_SCRIPT_OPTION,
  MODERN_FILTER_SCRIPT_OPTION,
  buildConcatFilter,
  detectFilterScriptOption,
  filterScriptOptionForVersion,
  runTrim,
  trimCommand,
  validateIntervals,
};
