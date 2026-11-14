# Backlog

План работ по приоритетам. Пометка `[x]` — выполнено (см. коммиты `feat(antidetect)`,
`feat(layout)`, `fix(compat)`, `fix(lifecycle)`, `feat(profiles)`, `feat(antidetect-surfaces)`).

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

## P3 — Идеи на потом
- [ ] Профили как отдельные процессы (`--user-data-dir`) с сеткой через window-manager
      (полная изоляция GPU-процесса на профиль) — единственный путь к
      полноценному шрифт-листу на уровне ОС.
- [ ] Синхронизатор действий (как в Dolphin): реплей кликов/ввода во все видимые профили.
- [x] Импорт cookies из Opera GX / Chrome (P3): форматы Netscape cookies.txt
      и DevTools-JSON (EditThisCookie/CDP; авто-детект по содержимому).
      Кнопка «печенье» в шапке ячейки — диалог с файловым диалогом (≤ 10 МБ),
      textarea для вставки, фильтром домена (по умолчанию — хост URL профиля)
      и авто-перезагрузкой ячейки. Сохраняются host-only/domain, Secure,
      HttpOnly, SameSite (None форсирует Secure), expiry (истёкшие
      пропускаются). Установка — батчами по 200 в сессию профиля,
      работает и для невидимых профилей.
- [ ] Mobile-прокси rotation: смена IP по расписанию/триггеру с сохранением гео.
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
- [ ] MV3 `service_worker` background для расширений (ограничение Electron 33).
- [ ] UI: drag-and-drop профилей между ячейками.
- [x] Дублирование профиля кнопкой в шапке ячейки (P3): копируются URL/прокси/
      расширения/UA/таймзона/платформа/локаль/геолокация; id и fingerprintSeed — новые
      (дубликат стартует чистой сессией с другим стабильным отпечатком).
