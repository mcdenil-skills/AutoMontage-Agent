#!/usr/bin/env node
// palette.js — извлекает цветовую палитру из видео и генерирует дизайн-токены
// темы движка AutoMontage-Agent. Гарантирует WCAG-контраст ≥4.5:1 для текста
// и поддерживает параметр brandLock (насколько жёстко держать бренд-акцент).
//
// Запуск:
//   node scripts/palette.js <video> [--brandLock 0..1] [--brandAccent #CC785C]
//
// Пример:
//   node scripts/palette.js ./tmp/preview_src.mp4 --brandLock 1.0
//   node scripts/palette.js ./tmp/preview_src.mp4 --brandLock 0.3
//
// Зависимости: @material/material-color-utilities (QuantizerCelebi, HCT + роли темы),
//              ffmpeg (до 20 характерных кадров сырыми rgb24-пикселями).
//
// ── Почему CommonJS + dynamic import ──
// В корне проекта package.json БЕЗ "type":"module" (иначе сломается идущий
// remotion-рендер src/*.js как CommonJS). Поэтому этот файл — CommonJS, а
// ESM-only MCU грузим через await import().
//
// ── Почему loader-хук для MCU ──
// MCU 0.4.0 опубликован как type:module с внутренними import'ами без
// расширения .js, которые strict-ESM Node отклоняет. Чиним resolve-хуком
// scripts/mcu-loader.mjs, регистрируем его через module.register —
// без правки node_modules и без флагов запуска.

'use strict';

const { register } = require('node:module');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');

// Регистрируем resolve-хук ДО импорта MCU.
register('./scripts/mcu-loader.mjs', pathToFileURL(process.cwd() + '/').href);

// ────────────────────────────── CLI ──────────────────────────────

const clamp01 = (x) => Math.min(1, Math.max(0, isNaN(x) ? 0 : x));
const lerp = (a, b, t) => a + (b - a) * t;

// Не больше 20 кадров в рамке 320×320: объём сырых пикселей ограничен до разбора.
const FRAME_LIMIT = 20;
const FRAME_BOX = 320;
const MAX_PIXELS = FRAME_LIMIT * FRAME_BOX * FRAME_BOX;
const QUANTIZE_COLORS = 64;

function parseArgs(argv) {
  const a = { brandLock: 1.0, brandAccent: '#CC785C', video: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--brandLock') a.brandLock = clamp01(parseFloat(argv[++i]));
    else if (t === '--brandAccent') a.brandAccent = argv[++i];
    else if (!t.startsWith('--')) a.video = t;
  }
  return a;
}

// ───────────────────── WCAG контраст (свой расчёт) ─────────────────────

// sRGB-канал → линейный (гамма-развёртка)
function linearize(c) {
  c /= 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// #RRGGBB → [r,g,b] 0..255
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

// Относительная яркость по WCAG 2.x
function relLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(linearize);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Контраст-отношение пары цветов (1..21)
function contrastRatio(hexA, hexB) {
  const l1 = relLuminance(hexA);
  const l2 = relLuminance(hexB);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

// Выбор тёмного/светлого текста под фон — что даёт больший контраст
function pickText(bgHex, darkHex, lightHex) {
  return contrastRatio(bgHex, darkHex) >= contrastRatio(bgHex, lightHex)
    ? darkHex
    : lightHex;
}

// ───────────────────── main-обёртка (нужен await import) ─────────────────────

async function main() {
  // ESM-only пакеты — только через dynamic import.
  const mcu = await import('@material/material-color-utilities');
  const {
    argbFromHex, hexFromArgb, Hct, themeFromSourceColor, QuantizerCelebi, argbFromRgb,
  } = mcu;

  // ── HCT-помощники (замыкаются на mcu) ──
  const hexToHct = (hex) => Hct.fromInt(argbFromHex(hex));
  const hctToHex = (h, c, t) => hexFromArgb(Hct.from(h, c, t).toInt());
  const clampTone = (t) => Math.min(100, Math.max(0, t));

  // Циркулярная интерполяция hue по кратчайшей дуге
  function circularLerp(a, b, t) {
    const d = ((b - a + 540) % 360) - 180;
    const r = (a + d * t) % 360;
    return r < 0 ? r + 360 : r;
  }

  // Затемнить hex на N единиц тона (сохраняя hue/chroma)
  function darken(hex, dTone) {
    const h = hexToHct(hex);
    return hctToHex(h.hue, h.chroma, clampTone(h.tone - dTone));
  }

  // Двигаем ТОН (яркость) ФОНА до достижения нужного контраста с текстом.
  // Hue и chroma фона сохраняем. Направление подбираем автоматически.
  function ensureContrast(bgHex, textHex, target = 4.5) {
    if (contrastRatio(bgHex, textHex) >= target) return bgHex;
    const bg = hexToHct(bgHex);
    const textLum = relLuminance(textHex);
    // Тёмный текст → фон светлее (тон вверх), иначе темнее (тон вниз).
    const dir = textLum < 0.5 ? +1 : -1;
    let best = bgHex;
    for (let step = 1; step <= 100; step++) {
      const tone = clampTone(bg.tone + dir * step);
      const cand = hctToHex(bg.hue, bg.chroma, tone);
      best = cand;
      if (contrastRatio(cand, textHex) >= target) return cand;
      if (tone === 0 || tone === 100) break; // упёрлись в предел
    }
    return best; // максимум из возможного, если target недостижим
  }

  // Двигаем ТОН ТЕКСТА (не фона) до контраста с фиксированным фоном.
  // Используется для textSoft: фон карточки уже определён, подстраиваем текст.
  function ensureTextContrast(bgHex, textHex, target = 4.5) {
    if (contrastRatio(bgHex, textHex) >= target) return textHex;
    const t = hexToHct(textHex);
    const bgLum = relLuminance(bgHex);
    // Светлый фон → текст темнее (тон вниз), тёмный фон → текст светлее (вверх).
    const dir = bgLum >= 0.5 ? -1 : +1;
    let best = textHex;
    for (let step = 1; step <= 100; step++) {
      const tone = clampTone(t.tone + dir * step);
      const cand = hctToHex(t.hue, t.chroma, tone);
      best = cand;
      if (contrastRatio(bgHex, cand) >= target) return cand;
      if (tone === 0 || tone === 100) break;
    }
    return best;
  }

  // ───────────────────── Пиксели кадров ─────────────────────

  // thumbnail=100 – ffmpeg сам выбирает «характерные» кадры из окон по 100 фреймов.
  // Пиксели идут сразу в stdout: ни временных файлов, ни JS-декодера картинок.
  // -fps_mode passthrough: без него ffmpeg дублирует первый кадр вместо следующих thumbnail.
  function framePixels(video) {
    const raw = execFileSync('ffmpeg', [
      '-v', 'error', '-nostdin', '-i', video, '-an',
      '-vf', `thumbnail=100,scale=${FRAME_BOX}:${FRAME_BOX}:force_original_aspect_ratio=decrease`,
      '-fps_mode', 'passthrough',
      '-frames:v', String(FRAME_LIMIT), '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
    ], { maxBuffer: MAX_PIXELS * 3, stdio: ['ignore', 'pipe', 'pipe'] });
    if (raw.length < 3) throw new Error('ffmpeg не извлёк ни одного кадра из видео');
    const pixels = new Array(Math.floor(raw.length / 3));
    for (let i = 0; i < pixels.length; i += 1) {
      pixels[i] = argbFromRgb(raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2]);
    }
    return pixels;
  }

  // ───────────────────── Seed-цвет из видео ─────────────────────

  // Квантуем пиксели всех кадров (QuantizerCelebi) и усредняем цвета В ПЕРЦЕПТИВНОМ
  // пространстве HCT, взвешенно по числу пикселей, а не в сыром RGB.
  // Hue усредняем циркулярно (через синус/косинус).
  function seedFromPixels(pixels) {
    let sx = 0, sy = 0, sChroma = 0, sTone = 0, w = 0;
    for (const [argb, population] of QuantizerCelebi.quantize(pixels, QUANTIZE_COLORS)) {
      if (population <= 0) continue;
      const hct = Hct.fromInt(argb);
      // Приглушаем вклад почти-серых цветов: у них hue шумный.
      const weight = population * (0.3 + 0.7 * Math.min(1, hct.chroma / 40));
      const rad = (hct.hue * Math.PI) / 180;
      sx += Math.cos(rad) * weight;
      sy += Math.sin(rad) * weight;
      sChroma += hct.chroma * weight;
      sTone += hct.tone * weight;
      w += weight;
    }
    if (w === 0) {
      return { hue: 40, chroma: 8, tone: 50, hex: hctToHex(40, 8, 50) };
    }
    let hue = (Math.atan2(sy, sx) * 180) / Math.PI;
    if (hue < 0) hue += 360;
    const chroma = sChroma / w;
    const tone = sTone / w;
    return { hue, chroma, tone, hex: hctToHex(hue, chroma, tone) };
  }

  // ───────────────────── Сборка токенов темы ─────────────────────

  // Базовая тема craft — эталон структуры, шрифтов и motion (копируем как есть).
  const CRAFT_BASE = {
    fonts: { display: 'Oswald', mono: 'JetBrains Mono', body: 'Onest' },
    radius: 26,
    cardShadow: '0 20px 50px rgba(61,46,36,.28)',
    cardBorder: '2px solid rgba(61,46,36,.14)',
    motion: { spring: { damping: 14, mass: 0.9 }, glow: false },
  };

  function buildTheme(seed, brandLock, brandAccent) {
    const seedHue = seed.hue;
    const brand = hexToHct(brandAccent);

    // Роли из MCU по seed видео — источник «видео-варианта» акцента.
    const theme = themeFromSourceColor(argbFromHex(seed.hex));
    const light = theme.schemes.light;
    const videoAccentHex = hexFromArgb(light.primary);

    // ── АКЦЕНТ ──
    // brandLock=1 → чистый бренд-терракот; 0 → акцент из видео; между — HCT-интерполяция.
    const va = hexToHct(videoAccentHex);
    const accHue = circularLerp(va.hue, brand.hue, brandLock);
    const accChroma = lerp(va.chroma, brand.chroma, brandLock);
    const accTone = lerp(va.tone, brand.tone, brandLock);
    const accent =
      brandLock >= 0.999 ? brandAccent : hctToHex(accHue, accChroma, accTone);
    const accentDark = darken(accent, 8); // тон −8 для hover/тени

    // ── НЕЙТРАЛИ / ФОН ──
    // Тянем hue фона к температуре видео (seedHue), хрому держим низкой.
    // brandLock подмешивает нейтральный hue бренда (тёплый крафтовый при 1.0).
    const bgHue = circularLerp(seedHue, brand.hue, brandLock);
    // Хрома фона: чуть выше при видео-режиме, ниже при бренде (молочно).
    const bgChroma = lerp(6, 4, brandLock);

    // Светлые «карточные» поверхности (высокий тон) + «молоко» + тёмный фон сцены.
    const cardBg = hctToHex(bgHue, bgChroma, 92);
    const milk = hctToHex(bgHue, bgChroma * 0.6, 97);
    const bg = hctToHex(bgHue, Math.min(bgChroma, 4), 4);

    // ── ТЕКСТ ──
    const darkText = hctToHex(bgHue, Math.min(bgChroma + 4, 12), 22);
    const lightText = hctToHex(bgHue, Math.min(bgChroma, 4), 96);

    // Авто-выбор текста под карточку и гарантия контраста ≥4.5.
    const text = pickText(cardBg, darkText, lightText);
    const cardBgFixed = ensureContrast(cardBg, text, 4.5);

    // textSoft — тот же оттенок, тон ближе к фону, но всё ещё контрастный.
    // Фон карточки уже зафиксирован → подстраиваем ТОН ТЕКСТА, не фона.
    const textSoftRaw = hctToHex(bgHue, Math.min(bgChroma + 3, 10), 38);
    const textSoft = ensureTextContrast(cardBgFixed, textSoftRaw, 4.5);

    // Если фон пришлось сдвинуть — синхронизируем cardBg2/milk по тому же тону.
    const toneDelta = hexToHct(cardBgFixed).tone - hexToHct(cardBg).tone;
    const cardBg2Fixed = hctToHex(bgHue, bgChroma, clampTone(89 + toneDelta));
    const milkFixed = hctToHex(bgHue, bgChroma * 0.6, clampTone(97 + toneDelta * 0.5));

    return {
      name: brandLock >= 0.999 ? 'craft' : `craft-video-${brandLock}`,
      colors: {
        bg,
        cardBg: cardBgFixed,
        cardBg2: cardBg2Fixed,
        milk: milkFixed,
        accent,
        accentDark,
        text,
        textSoft,
      },
      fonts: CRAFT_BASE.fonts,
      radius: CRAFT_BASE.radius,
      cardShadow: CRAFT_BASE.cardShadow,
      cardBorder: CRAFT_BASE.cardBorder,
      motion: CRAFT_BASE.motion,
    };
  }

  // ───────────────────── прогон ─────────────────────

  const args = parseArgs(process.argv.slice(2));
  if (!args.video) {
    console.error('Usage: node scripts/palette.js <video> [--brandLock 0..1] [--brandAccent #HEX]');
    process.exit(1);
  }

  const pixels = framePixels(args.video);
  const seed = seedFromPixels(pixels);
  const theme = buildTheme(seed, args.brandLock, args.brandAccent);

  // Контроль ключевых пар.
  const crText = contrastRatio(theme.colors.text, theme.colors.cardBg);
  const crSoft = contrastRatio(theme.colors.textSoft, theme.colors.cardBg);
  const crMilkOnAccent = contrastRatio(theme.colors.milk, theme.colors.accent);

  console.log(JSON.stringify(theme, null, 2));
  console.log('\n// ── diagnostics ──');
  console.log(`// seed(video): hue=${seed.hue.toFixed(1)} chroma=${seed.chroma.toFixed(1)} tone=${seed.tone.toFixed(1)} hex=${seed.hex}`);
  console.log(`// pixels: ${pixels.length} from ffmpeg rgb24 frames (limit ${MAX_PIXELS})`);
  console.log(`// brandLock=${args.brandLock}  brandAccent=${args.brandAccent}`);
  console.log(`// contrast text  on cardBg : ${crText.toFixed(2)}:1  ${crText >= 4.5 ? 'OK' : 'FAIL'}`);
  console.log(`// contrast soft  on cardBg : ${crSoft.toFixed(2)}:1  ${crSoft >= 4.5 ? 'OK' : 'FAIL'}`);
  console.log(`// contrast milk  on accent : ${crMilkOnAccent.toFixed(2)}:1`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
