#!/usr/bin/env node
// Фаза 1.2 – финиш-проход: громкость под соцсети + (опц.) HDR→SDR + резкость.
//   node finish.js <in.mp4> <out.mp4> [--hdrfix auto|on|off] [--sharpen] [--lanczos WxH]
const { finiteNumber, optionValue } = require('./build-options');
const { buildFinishAudioFilter } = require('./finish-audio');
const {
  captureTool,
  captureToolResult,
  hostPath,
  runTool,
} = require('./process');

function parseResolution(value) {
  if (value == null) return null;
  const match = /^(\d+)x(\d+)$/i.exec(String(value));
  if (!match) throw new Error('--lanczos должен иметь формат WIDTHxHEIGHT');
  const width = finiteNumber(match[1], '--lanczos width', { min: 16, max: 8192, integer: true });
  const height = finiteNumber(match[2], '--lanczos height', { min: 16, max: 8192, integer: true });
  return { width, height };
}

function parseFinishOptions(args) {
  const hdrMode = optionValue(args, 'hdrfix', 'auto');
  if (!['auto', 'on', 'off'].includes(hdrMode)) {
    throw new Error('--hdrfix принимает только auto, on или off');
  }
  const audioAdvanceMs = finiteNumber(
    optionValue(args, 'audio-advance-ms', '0'),
    '--audio-advance-ms',
    { min: 0, max: 250 },
  );
  buildFinishAudioFilter(audioAdvanceMs);
  return {
    hdrMode,
    sharpen: args.includes('--sharpen'),
    lanczos: parseResolution(optionValue(args, 'lanczos', null)),
    audioAdvanceMs,
  };
}

function hdrProbeCommand(input) {
  return {
    command: 'ffprobe',
    args: [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=color_transfer',
      '-of', 'default=nk=1:nw=1',
      hostPath(input),
    ],
  };
}

function finishEncodeCommand(input, output, options, isHDR) {
  const doHDR = options.hdrMode === 'on' || (options.hdrMode === 'auto' && isHDR);
  const videoFilters = [];
  if (doHDR) {
    videoFilters.push(
      'zscale=t=linear:npl=100',
      'format=gbrpf32le',
      'zscale=p=bt709',
      'tonemap=tonemap=hable:desat=0',
      'zscale=t=bt709:m=bt709:r=tv',
      'format=yuv420p',
    );
  }
  if (options.lanczos) {
    videoFilters.push(`scale=${options.lanczos.width}:${options.lanczos.height}:flags=lanczos`);
  }
  if (options.sharpen) videoFilters.push('unsharp=5:5:0.8:5:5:0.0');

  const args = ['-y', '-i', hostPath(input)];
  if (videoFilters.length) {
    args.push('-vf', videoFilters.join(','), '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p');
  } else {
    args.push('-c:v', 'copy');
  }
  args.push(
    '-af', buildFinishAudioFilter(options.audioAdvanceMs),
    '-c:a', 'aac',
    '-b:a', '160k',
    '-shortest',
    '-movflags', '+faststart',
    hostPath(output),
  );
  return { command: 'ffmpeg', args, doHDR };
}

function loudnessCommand(output) {
  return {
    command: 'ffmpeg',
    args: ['-i', hostPath(output), '-vn', '-af', 'loudnorm=print_format=summary', '-f', 'null', '-'],
  };
}

function parseLoudnessSummary(stderr) {
  const match = /Input Integrated:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*LUFS/i.exec(String(stderr || ''));
  return match ? match[1].toLowerCase() : null;
}

function main(args = process.argv.slice(2)) {
  const [input, output] = args;
  if (!input || !output) throw new Error('укажи входной и выходной MP4');
  const options = parseFinishOptions(args);
  let isHDR = false;
  if (options.hdrMode === 'auto') {
    try {
      const probe = hdrProbeCommand(input);
      const transfer = captureTool(probe.command, probe.args, {
        stage: 'HDR probe',
        maxBuffer: 1024 * 1024,
      });
      isHDR = /smpte2084|arib-std-b67/.test(transfer);
    } catch (error) {
      console.warn(`⚠️ HDR probe не сработал: ${error.message}`);
    }
  }
  const command = finishEncodeCommand(input, output, options, isHDR);
  console.log(`финиш: loudnorm=-14LUFS${options.audioAdvanceMs ? ` + звук вперёд ${options.audioAdvanceMs}мс` : ''}${command.doHDR ? ' + HDR→SDR' : ''}${options.sharpen ? ' + sharpen' : ''}${options.lanczos ? ' + lanczos' : ''}`);
  runTool(command.command, command.args, { stage: 'finish encode' });

  try {
    const loudness = loudnessCommand(output);
    const result = captureToolResult(loudness.command, loudness.args, {
      stage: 'loudness verification',
      maxBuffer: 4 * 1024 * 1024,
    });
    const integrated = parseLoudnessSummary(result.stderr);
    if (integrated == null) console.warn('⚠️ loudness verification не вернул Input Integrated');
    else console.log(`  факт: громкость Integrated: ${integrated} LUFS`);
  } catch (error) {
    console.warn(`⚠️ loudness verification не сработал: ${error.message}`);
  }
  console.log(`✅ ${output}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  finishEncodeCommand,
  hdrProbeCommand,
  loudnessCommand,
  main,
  parseFinishOptions,
  parseLoudnessSummary,
};
