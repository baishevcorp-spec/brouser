/**
 * Smoke-тест этапа 2 (чистые модули, без electron): fallback-парсер,
 * разрешение профиля, генерация JSON Schema из Zod-схем.
 * Запуск: node tests/smoke-stage2.cjs (после npm run build).
 */
const { parseToolCallsFromContent } = require('../dist/main/ai/tools/fallbackParse');
const { resolveProfileArg } = require('../dist/main/ai/tools/resolve');
const { z } = require('zod');
const schemas = require('../dist/main/ai/tools/schemas');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`ok   ${name}`);
  else {
    failures++;
    console.log(`FAIL ${name}${extra ? ` :: ${JSON.stringify(extra)}` : ''}`);
  }
}

// --- fallback-парсер: сырой JSON в content ---
{
  const r = parseToolCallsFromContent('Сейчас покажу.\n{"name":"list_profiles","arguments":{}}');
  check('fallback: inline JSON + проза', r && r.calls.length === 1 && r.calls[0].name === 'list_profiles' && r.cleaned === 'Сейчас покажу.', r);
}
{
  const r = parseToolCallsFromContent('```json\n{"name":"log_tail","arguments":{"profileName":"avito1","lines":30,"level":"warn"}}\n```');
  check('fallback: fenced JSON', r && r.calls[0].name === 'log_tail' && r.calls[0].args.lines === 30 && r.calls[0].args.profileName === 'avito1' && r.cleaned === '', r);
}
{
  const r = parseToolCallsFromContent('Держи: {"name":"profile_details","arguments":"{\\"profile\\":\\"avito1\\"}"} и дальше текст');
  check('fallback: arguments строкой', r && r.calls[0].args.profile === 'avito1' && r.cleaned === 'Держи: и дальше текст', r);
}
{
  const r = parseToolCallsFromContent('Обычный ответ без тулов: {\"скорость\": 5} — тут просто фигурные скобки');
  check('fallback: обычный JSON не тул', r === null, r);
}
{
  const r = parseToolCallsFromContent('Просто текст без скобок');
  check('fallback: без скобок', r === null);
}
{
  const r = parseToolCallsFromContent('Секунду\n\n```json\n{"name":"set_layout","arguments":{"layout":"2x2"}}\n```\n\nДостаю список');
  check('fallback: JSON с текстом до и после', r && r.calls[0].name === 'set_layout' && r.calls[0].args.layout === '2x2', r);
}

// --- разрешение профиля ---
const profiles = [
  { id: 'avito1', name: 'Avito №1' },
  { id: 'shop2', name: 'Shop' },
  { id: 'main', name: 'Main' },
  { id: 'dup', name: 'shop' },
];
check('resolve: точный id', resolveProfileArg('avito1', profiles, null).ok === true);
check('resolve: имя уникальное (регистр)', (() => { const r = resolveProfileArg('main', profiles, null); return r.ok && r.profile.id === 'main'; })());
{
  // 'shop' vs 'Shop' — два разных профиля, id не совпадает: неоднозначность.
  const r = resolveProfileArg('shop', profiles, null);
  check('resolve: неоднозначное имя → отказ', !r.ok && /неоднозначн/i.test(r.reason), r);
}
check('resolve: active → выделенный', resolveProfileArg('active', profiles, 'shop2').profile?.id === 'shop2');
check('resolve: active без выделения → отказ', !resolveProfileArg('active', profiles, null).ok);
{
  const r = resolveProfileArg('nope', profiles, null);
  check('resolve: промах без деталей', !r.ok && r.reason === 'профиль не найден', r);
}

// --- Zod → JSON Schema (как их увидит модель: через санитайзер реестра) ---
{
  const js = schemas.toJsonSchemaForModel(schemas.logTailSchema);
  const req = js.required || [];
  check('schema: defaults не в required', !req.includes('lines') && !req.includes('level') && !req.includes('profileName'), js);
  check('schema: $schema убран', js.$schema === undefined, js);
  check('schema: enum присутствует', JSON.stringify(js).includes('"enum"'));
}
{
  const js = schemas.toJsonSchemaForModel(schemas.setLayoutSchema);
  check('schema: layout обязателен', (js.required || []).includes('layout'), js);
}
{
  // Валидация входа модели: пропущенные defaults подставляются (этап 3: 30 строк,
  // profileName опционален).
  const parsed = schemas.logTailSchema.parse({});
  check('zod: defaults применяются', parsed.lines === 30 && parsed.level === 'all' && parsed.profileName === undefined, parsed);
}
{
  let threw = false;
  try { schemas.setLayoutSchema.parse({ layout: '5x5' }); } catch { threw = true; }
  check('zod: неверная раскладка отвергается', threw);
}
{
  let threw = false;
  try { schemas.searchFaqSchema.parse({ query: '' }); } catch { threw = true; }
  check('zod: пустой запрос отвергается', threw);
}

// --- системный промпт: версия 4 (фиксы обратной связи: правило 11, правило 4) ---
{
  const { SYSTEM_PROMPT_VERSION, buildSystemPrompt } = require('../dist/main/ai/system-prompt');
  check('prompt: версия поднята до 4', SYSTEM_PROMPT_VERSION === 4);
  const prompt = buildSystemPrompt({
    state: { profiles: [], layout: '1x1', inputSync: false },
    activeProfileId: null,
    appVersion: '1.0.0-test',
    electronVersion: '33.4.11',
    chromiumVersion: '120',
    platform: 'linux x64',
    toolLines: ['- test — тестовый тул'],
  });
  check(
    'prompt: правило 11 обязывает search_faq',
    prompt.includes('11.') && prompt.includes('ОБЯЗАН сначала вызвать тул search_faq'),
  );
  check('prompt: правило 11 запрещает выдумывать', prompt.includes('НИКОГДА не выдумывай шаги, кнопки или настройки'));
  check('prompt: правило 4 — одно слово после успеха', prompt.includes('ИЗ ОДНОГО СЛОВА'));
  check('prompt: правило 4 — запрет дублей карточки', prompt.includes('КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО дублировать'));
  check('prompt: 11 правил в структуре', prompt.includes('11. КРИТИЧЕСКОЕ ПРАВИЛО ПОИСКА'));
}

console.log(failures === 0 ? '\nSMOKE: все проверки пройдены' : `\nSMOKE: провалено ${failures}`);
process.exit(failures === 0 ? 0 : 1);
