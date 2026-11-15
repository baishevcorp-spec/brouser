# Backlog

План работ по приоритетам. Пометка `[x]` — выполнено (см. коммиты `feat(antidetect)`,
`feat(layout)`, `fix(compat)`, `fix(lifecycle)`, `feat(profiles)`,
`feat(antidetect-surfaces)`, `feat(cookies)`, `feat(sync)`).

## P0 — Блокеры продакшена
- [x] Canvas/WebGL/Audio fingerprint noise per-profile (P0.1) — `src/main/fingerprint.ts`,
      `src/main/fingerprint-preload.js`; seed из `fingerprintSeed` или хеша id;
      инъекция двойная (preload + CDP), идемпотентная.
- [x] Client Hints заголовки в синхроне с UA (P0.2) — `sec-ch-ua`/`sec-ch-ua-mobile`/
      `sec-ch-ua-platform` из UA; `Accept-CH` вырезается из ответов (high-entropy leak).

## P1 — Архитектура
- [x] Расчёт layout в main-процессе (P1.1) — `src/main/layout.ts`,
      `computeCells`/`UI_GEOMETRY`; resize -> throttle 16мс -> recompute;
      renderer не шлёт координаты (канал `view:set-bounds` удалён).
- [x] Handshake layout-ready (P1.2) — renderer шлёт `layout:ready` после первого
      рендера; views не позиционируются до сигнала.
- [x] Views не уничтожаются при смене раскладки (P1.3) — parking за пределами
      окна (x:-10000, 1x1, `backgroundThrottling: false`); уничтожение только
      при удалении профиля.

## P2 — Полировка
- [x] CDP vs DevTools конфликт (P2.1) — detach перед openDevTools, сброс
      `scriptAdded`, восстановление эмуляции на `devtools-closed`; плюс
      preload-путь патча продолжает работать во время DevTools.
- [x] macOS extensions path (P2.2) — `prepareExtensionForLoad`: копирование
      из бандла в `userData/extensions/<имя>-<хеш>` на darwin.
- [x] app.on('login') фильтрация по host (P2.3) — креды только при совпадении
      `authInfo.host` с хостом прокси профиля; расхождение логируется.
- [x] Логирование фингерпринта (P2.4) — строка
      `fingerprint: seed=…, canvas=patched, webgl=…, ch=…` при старте профиля.

## P2.5 — Горячие фиксы (регрессии)
- [x] **Краш при удалении профиля на Windows/Electron 33** (crashpad,
      `target closed while handling command`): порядок teardown
      `removeChildView -> debugger.detach -> webContents.close()`, после
      `close()` — ни одного обращения к webContents; флаг `closing` глушит
      отложенные обработчики (did-navigate, devtools-closed, in-flight
      CDP-эмуляция) и ранний выход из createView; preload-файл отпечатка
      (`fingerprint-preloads/<id>.js`) удаляется вместе с профилем.
- [x] Пустой конфиг (0 профилей): `recomputeLayout` — безопасный no-op
      (деление только на константы раскладки), модалка «Добавить» работает,
      новый профиль грузится в первую ячейку.

## P2.6 — UI поверх views (модалки и подсказки)
- [x] **Диалоги — отдельные BrowserWindow с parent** (`windows/dialogWindow.ts`):
      HTML-модалки renderer'а перекрывались нативным слоем WebContentsView
      (не двигались, уходили под сетку). Импорт cookies (640x560, свёрнутая
      инструкция «Как создать файл?» внутри), добавление профиля,
      подтверждение удаления (вместо «armed»-двойного клика) — модальные на
      Windows/Linux, frame: true (перетаскивание за системный заголовок),
      show после ready-to-show, sandbox: true + свой preload на диалог
      (`preload-cookie.ts` / `preload-profile-form.ts` / `preload-confirm.ts`,
      команды — только существующие IPC-каналы; данные — через query).
      Родитель `cookies:pick-file` — окно-отправитель (диалог файла выше
      активного окна).
- [x] **Rich-тултипы — прозрачное always-on-top окно** (`windows/tooltipWindow.ts`,
      `renderer/tooltips.ts`, `tooltip.ts`): контент подсказок (title +
      1–2 предложения «что делает и зачем») в реестре data-tip-id,
      динамические (сводка профиля, счётчик, sync on/off) — data-tip-title/
      tip-body; renderer главного окна шлёт anchor-рект + контент
      (tooltip:show), main позиционирует (кламп к workArea, переворот),
      окно тултипа меряет себя (tooltip:measured) и показывается через
      showInactive; focusable: false, setIgnoreMouseEvents(forward) —
      клики проходят сквозь; gen-счётчик против гонок; при blur/клике/
      перерисовке сетки — скрытие. CSS-тултипы `[data-tip]` остались
      только в диалоговых окнах (body.dialog) — там views нет.
- [x] README: раздел «Импорт cookies» дополнен инструкцией экспорта
      (Cookie-Editor / Netscape, «что важно», безопасность) + IPC-контракт
      (dialog:*, tooltip:*).

## P3 — Идеи на потом
- [ ] Профили как отдельные процессы (`--user-data-dir`) с сеткой через window-manager
      (полная изоляция GPU-процесса на профиль) — единственный путь к
      полноценному шрифт-листу на уровне ОС.
- [x] Синхронизатор действий (как в Dolphin): реплей кликов/ввода во все
      видимые профили. Захват — CDP Runtime.addBinding + capture-скрипт
      (pointerdown/up, wheel, keydown/up, clientX/Y), ретрансляция —
      Input.dispatchMouseEvent/KeyEvent с VK-кодами и text для печатаемых
      (как в Puppeteer); координаты 1:1 (ячейки равного размера); эхо
      подавляется 100-мс окном на ячейку-получателя. Тумблер в тулбаре;
      участники пересчитываются при изменениях сетки; переустановка после
      DevTools; forget ДО teardown (crash-безопасность P2.5). v1-границы:
      без drag&drop, без кросс-доменных iframe, без IME.
- [x] Импорт cookies из Opera GX / Chrome (P3): форматы Netscape cookies.txt
      и DevTools-JSON (EditThisCookie/CDP; авто-детект по содержимому).
      Кнопка «печенье» в шапке ячейки — диалог с файловым диалогом (≤ 10 МБ),
      textarea для вставки, фильтром домена (по умолчанию — хост URL профиля)
      и авто-перезагрузкой ячейки. Сохраняются host-only/domain, Secure,
      HttpOnly, SameSite (None форсирует Secure), expiry (истёкшие
      пропускаются). Установка — батчами по 200 в сессию профиля,
      работает и для невидимых профилей.
- [x] Mobile-прокси rotation: смена IP по расписанию/триггеру с сохранением
      гео (P3) — `proxyRotation` в config.json (`intervalMin` 1..1440 +
      опциональный `rotationUrl` провайдера, GET с таймаутом 20 с);
      цикл ротации = запрос провайдеру + перевзвод сессии на те же proxyRules
      (Chromium рвёт соединения, новые идут через новый IP); гео-эмуляция
      (таймзона/локаль/координаты/отпечаток) не трогается; работает и для
      паркованных профилей; ручной триггер — кнопка в «Настройках» (IPC
      `profile:rotate-proxy`), поля в форме «Добавить профиль»; дубликат
      наследует расписание; таймеры гасятся при удалении профиля/закрытии.
- [x] Шрифты/языки/геолокация/media devices/screen per-profile (следующие
      поверхности антидетекта после P0) — языки/Intl/Accept-Language из региона
      таймзоны (таблицы TZ_LOCALE/TZ_GEO в fingerprint.ts) или явные
      `locale`/`geolocation` в config.json; экран из пула по семейству
      (не меньше реального монитора); синтетические enumerateDevices;
      шрифты — JS-уровень (measureText-шум ±0.2% + маскировка редких шрифтов
      в document.fonts.check, только true->false). Полный шрифт-лист ОС —
      в пункте про отдельные процессы.
- [x] WebRTC IP leak: форсирование прокси-канала (`WebRTCIPHandlingPolicy`)
      — app-wide switch `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`
      (UDP только через прокси; у профилей без прокси WebRTC деградирует —
      осознанная цена отсутствия утечки IP).
- [x] Обновление GREASE-строк sec-ch-ua под свежие версии Chrome — больше не
      зашиты константой: бренд/версия/порядок вычисляются алгоритмом Chromium
      (components/embedder_support/user_agent_utils.cc: `Not{c[m%11]}A{c[(m+1)%11]}Brand`,
      `"8"/"99"/"24"[m%3]`, перестановка PERMS3[m%6]) по мажорной версии из UA;
      поддержаны дочерние бренды (Google Chrome/Opera/Edge/YaBrowser) и
      sec-ch-ua-mobile по мобильным UA.
- [x] MV3 `service_worker` background для расширений (ограничение Electron 33 —
      фоновый SW не запускается, полностью не поддерживается): сделан детект
      при подключении (extensionManifestNote) — предупреждение в журнал +
      жёлтый бейдж «⚠ MV3» в «Настройках» + раздел в README с практическим
      советом (для своих расширений держать `"background": {}` —
      content-скрипты работают без фонового контекста).
- [x] UI: drag-and-drop профилей между ячейками (P3) — перетаскивание за шапку
      ячейки, дроп на шапку другой ячейки или на пустую ячейку (тела заняты
      нативным WebContentsView, события туда не доходят); IPC `grid:reorder`
      → сдвиг в config.profiles + recomputeLayout — представления переносятся
      без пересоздания (сессии/логины/вкладки сохраняются); подсветка цели,
      порядок в config.json, пустая ячейка = «в конец списка».
- [x] Дублирование профиля кнопкой в шапке ячейки (P3): копируются URL/прокси/
      расширения/UA/таймзона/платформа/локаль/геолокация; id и fingerprintSeed — новые
      (дубликат стартует чистой сессией с другим стабильным отпечатком).

## P4 — AI-ассистент (Brouser Assistant)

Встроенный агент: «умный FAQ по проекту + пульт управления», голосовой
ввод-вывод — второй этап (не начинать голос, пока текстовый чат не прошёл
свои тест-кейсы). Правила работ: следующий этап — только после прохождения
тест-кейсов предыдущего; каждый этап — отдельный коммит
`feat(assistant): stage N — …`; архитектурная развилка — вопрос
пользователю (2 варианта + рекомендация), не решать молча.

Границы безопасности (неизменяемы): Zero-Trust к LLM — модель не имеет
доступа к session/WebContentsView/fs/profileManager, только тулы на
TypeScript с жёсткими Zod-схемами (.max/.default/.enum, ответ тула
≤ 4–8 КБ); модель не передаёт profileId — main подставляет активный
профиль сам (имя → поиск в конфиге + проверка существования); никаких
eval/executeJavaScript/session.fromPartition по запросу модели.
Запрещённые операции (тулов не существует): удаление профиля, смена
прокси, выполнение JS в view, чтение произвольных файлов (только
документация проекта), возврат паролей/cookies/токенов, чтение config.json
целиком — всё это только через UI Brouser. Логи `[assistant]` не содержат
API-ключ, cookies, пароли; сообщения пользователя — только длина.

- [ ] Этап 0. Ревизия и согласование тулов — по текущему коду
      (profileManager, IPC-каналы, config, логи) составить полный список
      тулов (имя + одна строка описания) сверх ориентиров из ТЗ; проверить
      зависимости (zod, пересечения панель-ассистента с существующим UI);
      список — на согласование пользователю ДО первой строки кода.
- [ ] Этап 1. Каркас + LLM-провайдер — `src/main/ai/assistant.ts`,
      `system-prompt.ts` (версионируемый, 9 правил из ТЗ); Ollama Cloud
      (https://ollama.com, OpenAI-совместимый endpoint, Bearer
      $OLLAMA_API_KEY, пакет `ollama`, модель с надёжным tool calling —
      выбрать из актуальных cloud-моделей) + fallback local Ollama
      (localhost:11434, qwen2.5:7b); режим Cloud/Local/Auto в настройках;
      таймаут 30 с, 1 ретрай, ошибка — сообщение в UI без падения; ключ —
      safeStorage.encryptString → base64 в `userData/assistant-config.json`
      (НЕ в config.json); логирование `[assistant]` (chat started,
      llm error); UI: сворачиваемая панель справа (не перекрывает сетку),
      тема Brouser (glass), история с прокруткой / ввод / отправка /
      «Очистить историю», индикатор «Cloud / Local / Недоступен», история
      не персистится по умолчанию; без микрофона. Критерий: «привет» →
      ответ от LLM.
- [ ] Этап 2. Тулы + Zod — `src/main/ai/tools/`; ориентиры покрытия:
      список профилей и статусов; прокси профиля (только хост, не креды);
      смена раскладки сетки; перезагрузка профиля / открытие DevTools;
      хвост логов app.log (20–50 строк); FAQ-поиск (реализация — этап 3).
      Каждый тул: Zod-схема параметров, возвращает
      `{ok:true, data}|{ok:false, reason}`, не кидает исключений, лог
      `[assistant][tool=<name>]` (args + size результата); при вызове тула
      — индикатор «⏳ …» и компактная карточка результата в чате (не сырой
      JSON). Критерий: тест-кейсы 1–3 ТЗ.
- [ ] Этап 3. RAG + FAQ — `src/main/ai/faq.ts`: searchFAQ(query, topK=3)
      по README.md / BACKLOG.md / ROADMAP.md / docs/*.md; разбиение по
      заголовкам `##`, чанк ≤ 800 симв.; keyword-score (lowercase, слова
      запроса по заголовку и телу); top-3 чанка, каждый обрезан до
      500 симв.; ничего не найдено → `{ok:true, data:{found:false,
      suggestions:[заголовки]}}`; переиндексация на каждый запрос (без
      кэша — документация меняется на ходу); тул searchFAQ;
      docs/assistant-tools.md — таблица всех тулов (имя, параметры, что
      возвращает, что НЕ делает, пример вызова). Критерий: тест-кейс 4
      (ответ на основе README со ссылкой на раздел).
- [ ] Этап 4. Безопасность и отказы — fallback-парсер tool calls: если
      message.tool_calls пуст, но в content есть JSON с name/arguments —
      распарсить и выполнить как тул, лог `[assistant] fallback-parser`:
      parsed tool from content, name=…; обработка ошибок LLM (timeout
      30 с, offline) → «Ассистент временно недоступен, проверьте
      соединение»; корректные отказы на запрещённые операции («удаление
      доступно только через интерфейс Brouser») + предупреждение о
      небезопасности, если пользователь прислал секрет. Критерий:
      тест-кейсы 5–8 ТЗ (включая offline и одинаковые результаты на
      local-fallback).
- [ ] Этап 5. Голосовой ввод — wake word (openWakeWord ONNX
      onnxruntime-node / sherpa-onnx open-vocabulary; «hey Jarvis», фреймы
      80 мс, порог 0.5; русский wake word — только если sherpa-onnx
      оправдает сложность) → VAD Silero ONNX (фреймы 32 мс, стоп — 800 мс
      тишины) → STT @kutalia/whisper-node-addon (whisper.cpp потоковый
      PCM, ggml-base.bin / ggml-small.bin, язык ru; модели скачиваются при
      первом включении голоса в userData/models/); тумблер в UI (по
      умолчанию выключен); приватность: до срабатывания wake word аудио
      обрабатывается локально, не сохраняется и никуда не отправляется;
      аудио не пишется на диск, кроме явного debug-режима
      (userData/debug-audio/); нет микрофона → понятная ошибка в UI.
      docs/assistant-voice.md (пайплайн, модели, скачивание,
      troubleshooting). Критерий: голосовые тест-кейсы 1–3.
- [ ] Этап 6. Голосовой вывод (TTS) + полировка — Piper через
      child_process.spawn (голос ru_RU-irina-medium или аналог) +
      fallback системный TTS; опция «отключить голосовой ответ»;
      README-раздел «AI-ассистент» (умения, включение, настройка
      Ollama Cloud/Local, голос) + раздел «Приватность» с предупреждением:
      в cloud-режиме голосовые команды распознаются локально, но текст
      уходит в Ollama Cloud; цель задержки ≤ 3 с от конца речи до начала
      ответа (whisper base + cloud LLM); обновление ROADMAP. Критерий:
      голосовые тест-кейсы 4–5, полноценный голосовой диалог end-to-end
      на Windows; регрессия — сетка/профили/антидетект/логи/DevTools
      работают без изменений.
