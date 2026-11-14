'use strict';
/**
 * Brouser — генератор антидетект-патча для main world страницы (P0.1).
 *
 * Файл CommonJS (не TS): он require-ится из dist/main/fingerprint.js
 * (копируется туда scripts/copy-assets.js) и используется ДВУМЯ способами:
 *   1) CDP Page.addScriptToEvaluateOnNewDocument — основной путь, скрипт
 *      выполняется до скриптов страницы на каждом новом документе;
 *   2) сгенерированный per-profile preload (session.setPreloads) — запуск
 *      через webFrame.executeJavaScript, страховка на случай конфликта
 *      debugger с DevTools.
 * Оба пути используют ОДИН источник. Каждый патч-сайт идемпотентен
 * (маркер __br на обёртке), поэтому двойная инъекция безопасна,
 * а отсутствие одного API не отключает остальные.
 *
 * Что патчится (все значения детерминированы seed профиля):
 *   - Canvas: getImageData / toDataURL / toBlob — пиксельный шум ±1/канал,
 *     стабильный по координатам (одна канва -> один и тот же шум);
 *   - WebGL: getParameter(UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL)
 *     -> реалистичная пара vendor/renderer из ANGLE-подобных строк;
 *   - AudioContext: AudioBuffer.getChannelData — микро-шум ±1e-5;
 *   - navigator: platform / hardwareConcurrency / deviceMemory;
 *   - Intl.DateTimeFormat.prototype.resolvedOptions — таймзона (JS-уровень,
 *     дублирует Emulation.setTimezoneOverride на уровне движка).
 */

/**
 * Строит текст патч-скрипта. spec — простые типы (значения «запекаются»
 * в исходник: env-переменные в preload не передаются — проверено, так не работает).
 */
function buildPatchSource(spec) {
  var SEED = spec.seed | 0;
  var TZ = spec.timezone ? JSON.stringify(spec.timezone) : 'null';
  var PLATFORM = spec.platform ? JSON.stringify(spec.platform) : 'null';
  var CORES = spec.hardwareConcurrency | 0;
  var MEM = spec.deviceMemory | 0;
  var GLV = JSON.stringify(spec.webglVendor);
  var GLR = JSON.stringify(spec.webglRenderer);

  return (
    '(function () {\n' +
    "  'use strict';\n" +
    '  var SEED = ' + SEED + ';\n' +
    '  var TZ = ' + TZ + ';\n' +
    '  var PLATFORM = ' + PLATFORM + ';\n' +
    '  var CORES = ' + CORES + ';\n' +
    '  var MEM = ' + MEM + ';\n' +
    '  var GLV = ' + GLV + ';\n' +
    '  var GLR = ' + GLR + ';\n' +
    '\n' +
    '  // --- Утилиты ---\n' +
    '  function fakeToString(fn, name) {\n' +
    '    try {\n' +
    '      Object.defineProperty(fn, "toString", {\n' +
    '        value: function () { return "function " + name + "() { [native code] }"; },\n' +
    '        writable: true, configurable: true, enumerable: false,\n' +
    '      });\n' +
    '    } catch (e) {}\n' +
    '  }\n' +
    '  function clamp8(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }\n' +
    '  // Детерминированный шум пикселя: зависит только от (SEED, x, y, channel).\n' +
    '  function noiseAt(x, y, ch) {\n' +
    '    var h = (SEED ^ Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(ch, 2246822519)) >>> 0;\n' +
    '    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;\n' +
    '    return (h % 3) - 1; // {-1, 0, +1}: амплитуда не более 1 на канал\n' +
    '  }\n' +
    '  // Наложить шум на пиксели; x0/y0 — абсолютные координаты региона в канве\n' +
    '  // (для согласованности toDataURL и getImageData на одной канве).\n' +
    '  function noisePixels(data, x0, y0, w) {\n' +
    '    if (!data || !w || w < 1) return;\n' +
    '    for (var i = 0; i < data.length; i += 4) {\n' +
    '      var p = i >> 2;\n' +
    '      var px = x0 + (p % w);\n' +
    '      var py = y0 + ((p / w) | 0);\n' +
    '      data[i] = clamp8(data[i] + noiseAt(px, py, 0));\n' +
    '      data[i + 1] = clamp8(data[i + 1] + noiseAt(px, py, 1));\n' +
    '      data[i + 2] = clamp8(data[i + 2] + noiseAt(px, py, 2));\n' +
    '      // альфу не трогаем: прозрачность должна остаться честной\n' +
    '    }\n' +
    '  }\n' +
    '\n' +
    '  // --- Захватываем оригиналы ДО патчей ---\n' +
    '  var C2P = null, HCE = null, ABP = null, DTF = null, GL1 = null, GL2 = null;\n' +
    '  try { C2P = window.CanvasRenderingContext2D && window.CanvasRenderingContext2D.prototype; } catch (e) {}\n' +
    '  try { HCE = window.HTMLCanvasElement && window.HTMLCanvasElement.prototype; } catch (e) {}\n' +
    '  try { ABP = window.AudioBuffer && window.AudioBuffer.prototype; } catch (e) {}\n' +
    '  try { DTF = window.Intl && window.Intl.DateTimeFormat && window.Intl.DateTimeFormat.prototype; } catch (e) {}\n' +
    '  try { GL1 = window.WebGLRenderingContext && window.WebGLRenderingContext.prototype; } catch (e) {}\n' +
    '  try { GL2 = window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype; } catch (e) {}\n' +
    '  var origGID = C2P && typeof C2P.getImageData === "function" ? C2P.getImageData : null;\n' +
    '\n' +
    '  // Идемпотентная установка: маркер __br на обёртке не даёт патчить дважды\n' +
    '  // (preload + CDP используют один источник).\n' +
    '  function install(site, name, make) {\n' +
    '    try {\n' +
    '      var cur = site ? site[name] : null;\n' +
    '      if (typeof cur !== "function" || cur.__br === SEED) return;\n' +
    '      var wrapped = make(cur);\n' +
    '      if (typeof wrapped !== "function") return;\n' +
    '      try {\n' +
    '        Object.defineProperty(wrapped, "__br", { value: SEED, enumerable: false, configurable: true, writable: true });\n' +
    '      } catch (e) { wrapped.__br = SEED; }\n' +
    '      site[name] = wrapped;\n' +
    '      fakeToString(wrapped, name);\n' +
    '    } catch (e) {}\n' +
    '  }\n' +
    '\n' +
    '  // --- Canvas: getImageData ---\n' +
    '  install(C2P, "getImageData", function (orig) {\n' +
    '    return function (sx, sy, sw, sh) {\n' +
    '      var r = orig.apply(this, arguments);\n' +
    '      try { noisePixels(r.data, sx | 0, sy | 0, sw | 0); } catch (e) {}\n' +
    '      return r;\n' +
    '    };\n' +
    '  });\n' +
    '\n' +
    '  // Клон канвы с шумом: исходный холст не меняется, вывод стабилен.\n' +
    '  function noisyClone(canvas) {\n' +
    '    var c = document.createElement("canvas");\n' +
    '    c.width = canvas.width; c.height = canvas.height;\n' +
    '    var ctx = c.getContext && c.getContext("2d");\n' +
    '    if (!ctx) return null;\n' +
    '    ctx.drawImage(canvas, 0, 0);\n' +
    '    if (origGID) {\n' +
    '      var img = origGID.call(ctx, 0, 0, c.width, c.height);\n' +
    '      noisePixels(img.data, 0, 0, c.width);\n' +
    '      ctx.putImageData(img, 0, 0);\n' +
    '    }\n' +
    '    return c;\n' +
    '  }\n' +
    '\n' +
    '  // --- Canvas: toDataURL / toBlob ---\n' +
    '  install(HCE, "toDataURL", function (orig) {\n' +
    '    return function () {\n' +
    '      try {\n' +
    '        if (this.width > 0 && this.height > 0) {\n' +
    '          var c = noisyClone(this);\n' +
    '          if (c) return orig.apply(c, arguments);\n' +
    '        }\n' +
    '      } catch (e) {}\n' +
    '      return orig.apply(this, arguments);\n' +
    '    };\n' +
    '  });\n' +
    '\n' +
    '  install(HCE, "toBlob", function (orig) {\n' +
    '    return function (cb) {\n' +
    '      try {\n' +
    '        if (this.width > 0 && this.height > 0 && typeof cb === "function") {\n' +
    '          var c = noisyClone(this);\n' +
    '          if (c) {\n' +
    '            var rest = Array.prototype.slice.call(arguments, 1);\n' +
    '            return orig.apply(c, [function (b) { cb(b); }].concat(rest));\n' +
    '          }\n' +
    '        }\n' +
    '      } catch (e) {}\n' +
    '      return orig.apply(this, arguments);\n' +
    '    };\n' +
    '  });\n' +
    '\n' +
    '  // --- AudioContext: AudioBuffer.getChannelData (микро-шум ±1e-5, один раз к буферу) ---\n' +
    '  install(ABP, "getChannelData", function (orig) {\n' +
    '    return function (ch) {\n' +
    '      var arr = orig.call(this, ch);\n' +
    '      try {\n' +
    '        if (arr && !arr.__bra) {\n' +
    '          try {\n' +
    '            Object.defineProperty(arr, "__bra", { value: 1, enumerable: false, configurable: true, writable: true });\n' +
    '          } catch (e2) { arr.__bra = 1; }\n' +
    '          // Идентификатор буфера — из его формы (sampleRate/length/канал):\n' +
    '          // одинаковые буферы -> одинаковый шум, разная форма -> разный шум.\n' +
    '          var bid = (((this.sampleRate | 0) * 31) + ((this.length | 0) * 7) + (ch | 0)) | 0;\n' +
    '          var s = (SEED ^ Math.imul(bid, 2654435761)) >>> 0;\n' +
    '          var rnd = function () {\n' +
    '            s = (s + 0x6D2B79F5) | 0;\n' +
    '            var t = Math.imul(s ^ (s >>> 15), 1 | s);\n' +
    '            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;\n' +
    '            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;\n' +
    '          };\n' +
    '          for (var i = 0; i < arr.length; i++) {\n' +
    '            arr[i] += (rnd() * 2e-5) - 1e-5; // неслышимо, но меняет хеш\n' +
    '          }\n' +
    '        }\n' +
    '      } catch (e) {}\n' +
    '      return arr;\n' +
    '    };\n' +
    '  });\n' +
    '\n' +
    '  // --- WebGL: UNMASKED_VENDOR (37445) / UNMASKED_RENDERER (37446) ---\n' +
    '  function glWrapper(orig) {\n' +
    '    return function (p) {\n' +
    '      if (p === 37445) return GLV;\n' +
    '      if (p === 37446) return GLR;\n' +
    '      return orig.apply(this, arguments);\n' +
    '    };\n' +
    '  }\n' +
    '  install(GL1, "getParameter", glWrapper);\n' +
    '  install(GL2, "getParameter", glWrapper);\n' +
    '\n' +
    '  // --- navigator: platform / hardwareConcurrency / deviceMemory ---\n' +
    '  // Идемпотентно через сравнение значений (геттеры уже возвращают нужное).\n' +
    '  try {\n' +
    '    if (PLATFORM && navigator.platform !== PLATFORM) {\n' +
    '      Object.defineProperty(navigator, "platform", { get: function () { return PLATFORM; }, configurable: true });\n' +
    '    }\n' +
    '    if (CORES > 0 && navigator.hardwareConcurrency !== CORES) {\n' +
    '      Object.defineProperty(navigator, "hardwareConcurrency", { get: function () { return CORES; }, configurable: true });\n' +
    '    }\n' +
    '    if (MEM > 0 && navigator.deviceMemory !== MEM) {\n' +
    '      Object.defineProperty(navigator, "deviceMemory", { get: function () { return MEM; }, configurable: true });\n' +
    '    }\n' +
    '  } catch (e) {}\n' +
    '\n' +
    '  // --- Intl: таймзона на JS-уровне (дубль CDP Emulation.setTimezoneOverride) ---\n' +
    '  if (TZ) {\n' +
    '    install(DTF, "resolvedOptions", function (orig) {\n' +
    '      return function () {\n' +
    '        var o = orig.call(this);\n' +
    '        if (o && o.timeZone) { try { o.timeZone = TZ; } catch (e) {} }\n' +
    '        return o;\n' +
    '      };\n' +
    '    });\n' +
    '  }\n' +
    '})();\n'
  );
}

exports.buildPatchSource = buildPatchSource;
