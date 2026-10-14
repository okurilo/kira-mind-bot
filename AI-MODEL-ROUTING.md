# Модели и стоимость API

Проверено по официальным тарифам и документации на 2026-10-14. Единый источник маршрутов — `admin-panel/src/ai-model-presets.json`; его читают runtime и админ-панель. Активный пресет выбирается из `bot_settings.AI_MODEL_PRESET`, затем ENV; default — `gpt-balanced`. Оба production-бота на момент аудита использовали `gpt-lean`. Эта правка обновляет локальный реестр и документацию; настройки production-БД не менялись.

## Вывод по расходу двух ботов

За пять суток в таблицах usage двух ботов около $4.45 расчётной стоимости текстовых вызовов до скидок за кэш. Ещё около $0.08 приходится на восемь вызовов web search по тарифу OpenAI; изображения и длительность транскрибации в token-логах не представлены. Поэтому расчёт близок к наблюдаемым $5, но не является точной сверкой биллинга.

| Маршрут | Вызовы | Вход / выход, токенов | Расчёт по тарифу |
| --- | ---: | ---: | ---: |
| GPT-5.4 `complexReasoning` | 245 | 298 260 / 118 301 | $2.52 |
| GPT-5.4 mini | — | 1 154 164 / 224 563 | $1.88 |
| GPT-5.4 nano | — | 181 794 / 8 752 | $0.05 |
| Embeddings | — | 166 494 | около $0.004 |

Сильное рассуждение было дорогой частью: 245 вызовов GPT-5.4 дали примерно 57% стоимости текста. Вызовы коротких проверок и embeddings почти не повлияли на сумму. После исчерпания баланса Кира ещё писала много ошибок `credit_balance_exhausted` с нулевыми токенами; это засорило журнал, но не создало сопоставимого платного usage. Повторный retry/fallback при исчерпанном балансе следует считать эксплуатационным шумом, а не объяснением $5.

Для оценки нового маршрута пересчитаны те же 1.63 млн входных и 352 тыс. выходных токенов по GPT-6 Luna: около $0.34 вместо $4.45 за текст. Вместе с восемью web search это около $0.42 за те же пять суток, до учёта кэша, изображений, аудио и расхождений между локальными логами и provider invoice. Это тарифная оценка, а не гарантированный будущий счёт. Luna оставлена даже на `complexReasoning` в `gpt-lean`: OpenAI указывает reasoning по умолчанию `medium`; если качество сложных ответов не устроит, переключить этот один маршрут на Gemini 3.8 Flash (сейчас $0.75/$3.75) или GPT-6.1 Sol ($2/$10).

## Тарифы, USD за 1 млн токенов

Стандартная обработка без учёта скидки cached input, специальных тарифов, лимитов контекста и tool calls. Указаны цены, релевантные этим пресетам. Проверять тарифы нужно снова перед плановым изменением после дат, где действует временная цена.

| Модель / API | Вход | Кэш-вход | Выход / стоимость | Применение и ограничения |
| --- | ---: | ---: | ---: | --- |
| GPT-6 Luna | $0.10 | $0.01 | $0.50 | Дешёвый GPT-6 для частых задач; reasoning по умолчанию medium; text и vision; Responses API и web search |
| GPT-6.1 Sol | $2.00 | $0.10 | $10.00 | Баланс качества и цены; Responses для встроенных инструментов |
| GPT-6 Astra | $10.00 | $1.00 | $50.00 | Премиум только для самых сложных задач |
| Gemini 3.8 Flash, Standard | $0.75 | $0.075 | $3.75 | Цена до 2026-12-31; с 2027-01-01 — $1.50/$0.15/$7.50; Search: 5 000 запросов в месяц бесплатно, затем $14/1 000 |
| Gemini 3.5 Flash-Lite, Standard | $0.30 | $0.03 | $2.50 | Высокочастотные простые задачи; Google Search включён в общую месячную квоту моделей Gemini 3+ |
| GLM-5.3 | $1.40 | $0.26 | $4.40 | Стоит столько же, сколько GLM-5.2; новая версия, reasoning нельзя отключить |
| GLM-4.7-FlashX | $0.07 | $0.01 | $0.40 | Самые дешёвые текстовые проверки среди выбранных платных маршрутов |
| GLM-4.6V-FlashX | $0.04 | $0.004 | $0.40 | Дешёвый vision; текущий тариф явно указан Z.ai |
| OpenAI text-embedding-3-small | $0.02 | — | — | Embeddings; по умолчанию 1 536 измерений, столько же, сколько у ada-002 |
| Gemini Embedding 2 | $0.20 | — | — | Текстовые embeddings; десятикратная цена OpenAI small, но сохраняет Gemini-only профиль |
| OpenAI gpt-4o-mini-transcribe | — | — | $0.003/минута | Половина цены Whisper-1 ($0.006/минута) |
| Z.AI GLM-ASR-2512 | — | — | около $0.0024/минута | Транскрибация для GLM-only |
| Gemini 3.8 Flash для транскрибации | По обычным тарифам модели | — | По фактическим input/output tokens | Отдельный тариф за минуту для этой общей модели не указан; не приравнивать к выделенному STT |
| OpenRouter Auto | динамический | — | тариф выбранной модели | Auto сейчас по умолчанию использует низкий ценовой tier, но биллинг определяется фактически выбранной моделью |

Тарифы GPT-6 удваиваются по входу и увеличивают выход в 1.5 раза для запросов свыше 272K входных токенов; у Luna cache writes стоят $0.125/MTok. Все эти цены и отдельная плата за инструменты сверены по [OpenAI Pricing](https://developers.openai.com/api/docs/pricing) и [модели GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna). Gemini 3.8 Flash удваивает стандартные ставки 1 января 2027; у Z.ai GLM-5.3-Flash стоит $0.15/$0.50, но reasoning нельзя выключить. [Google Gemini Pricing](https://ai.google.dev/gemini-api/docs/pricing), [Gemini deprecations](https://ai.google.dev/gemini-api/docs/deprecations), [Z.AI Pricing](https://docs.z.ai/guides/overview/pricing), [GLM-5.3-Flash vision/API](https://docs.z.ai/guides/vlm/glm-5.3-flash).

Стоимость OpenAI web search — $10 за 1 000 tool calls плюс модельные токены; тариф Z.AI web search — $0.01 за использование. OpenRouter Auto не устанавливает фиксированную верхнюю цену модели, поэтому `hybrid-openrouter-gpt` остаётся экспериментальным и не рекомендуется как бюджетный профиль без отдельного лимита на стороне OpenRouter. [OpenAI Pricing](https://developers.openai.com/api/docs/pricing), [OpenRouter Auto Router](https://openrouter.ai/docs/guides/routing/routers/auto-router).

## Новая сетка пресетов

Обозначения столбцов: `обычный` — `defaultText`; `короткий` — `lightweightText`, `intentDedup`, `browserPlanning`; `intent` — `intentClassification`; `память` — `memoryExtraction` и `memoryConsolidation`; `vision` — `browserVision`. В ячейке с несколькими моделями задачи перечислены явно.

| Пресет | Обычный / короткий / intent | Сложный ответ | Диалог | Память | Анализ / web search | Vision | Embedding / transcription |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `gpt-max` | Sol / Luna / Sol | Astra | Sol | Sol | Sol / Sol | Sol | OpenAI small / gpt-4o-mini-transcribe |
| `gpt-balanced` | Luna / Luna / Luna | Sol | Sol | Luna | Luna / Sol | Luna | OpenAI small / gpt-4o-mini-transcribe |
| `gpt-lean` | Luna / Luna / Luna | Luna | Luna | Luna | Luna / Luna | Luna | OpenAI small / gpt-4o-mini-transcribe |
| `hybrid-openrouter-gpt` | Auto / Luna / Luna | Sol | Auto | extraction Luna; consolidation Auto | analysis Auto / Luna | GPT Luna | OpenAI small / gpt-4o-mini-transcribe |
| `hybrid-gemini-gpt` | Gemini Lite / Luna / Luna | Gemini Flash | Gemini Flash | GPT Luna / Gemini Lite | Gemini Lite / GPT Luna | Gemini Flash | OpenAI small / gpt-4o-mini-transcribe |
| `gemini-full` | Gemini Lite / Gemini Lite / Flash | Gemini Flash | Gemini Flash | Gemini Lite | Gemini Lite / Gemini Flash | Gemini Flash | Gemini Embedding 2 / Gemini Flash |
| `glm-full` | GLM FlashX / GLM FlashX / GLM-5.3 | GLM-5.3 | GLM-5.3 | GLM-5.3 | GLM-5.3 / GLM-5.3 | GLM-4.6V-FlashX | OpenAI small / GLM-ASR-2512 |
| `glm-balanced` | GPT Luna / GPT Luna / GPT Luna | GLM-5.3 | GLM-5.3 | GLM-5.3 | GLM-5.3 / GPT Luna | GPT Luna | OpenAI small / gpt-4o-mini-transcribe |

Это полный runtime-реестр по состоянию на дату аудита; точные model IDs и provider для каждой задачи задаются только в JSON выше. В `gpt-max` Astra используется на одном дорогостоящем маршруте, Sol — на ежедневных важных задачах. В `gpt-balanced` частая работа идёт на Luna, сильные Sol оставлены для диалога, сложного рассуждения и поиска. В `gpt-lean` все GPT-текстовые вызовы используют Luna. Gemini и GLM-only пресеты сохраняют основного провайдера для генерации. Embedding/transcription маршруты отражают реальные возможности адаптеров: GLM-only для embeddings по-прежнему использует отдельный OpenAI API.

## Совместимость и эксплуатационные замечания

- GPT-6 Luna поддерживает Chat Completions и Responses; встроенные инструменты, в том числе web search, используют Responses. При `reasoning_effort` отличном от `none` нельзя отправлять `temperature` и `top_p`; текущий OpenAI adapter этих параметров не добавляет.
- Gemini 3.1 Flash-Lite deprecated с 7 мая 2026, официальный shutdown запланирован на 7 мая 2027; её убрал из degradation chain. Цепочка текущего Gemini runtime: 3.8 Flash → 3.5 Flash-Lite → 2.5 Flash-Lite. Доступ к 2.5 Flash-Lite зависит от истории аккаунта Google; если модель недоступна аккаунту, останется предыдущая успешная Flash-Lite ступень.
- Z.AI GLM-5.3 заменяет GLM-5.2 по той же цене; FlashX оставлен для utility задач. GLM-5.3-Flash не выбран основным маршрутом, потому что его thinking нельзя отключить, а GLM-4.7-FlashX дешевле для проверок. Для vision выбран тарифицируемый GLM-4.6V-FlashX вместо прежнего ID `glm-5v-turbo` с неясной применимостью к текущей цене.
- В GPT-6 Luna image input supported; audio input not supported. Для дешёвой транскрибации выбран отдельный `gpt-4o-mini-transcribe`; в Gemini-only используется мультимодальный Gemini 3.8 Flash, а в GLM-only — GLM-ASR-2512.
- Скидка на OpenAI cached input, фактическая цена image tokens, reasoning tokens в ответах, запросы Gemini Search, инструменты Z.AI, выбранная OpenRouter модель, тарифные tier/region uplifts и биллинг аккаунта меняют итоговую сумму. Usage logs не содержат всех billing-полей. Платные API-бенчмарки не запускались, поэтому сохранение качества новых маршрутов не заявляется.
- Production-БД и deployment Raspberry Pi этой правкой репозитория не менялись. Выбор активного пресета в production — отдельная настройка эксплуатации.

## Ранее принятые правила маршрутизации

Классификатор возвращает `details.responseComplexity` в одном запросе и не запускает отдельный платный вызов определения сложности. Сложные рассуждения, расчёты, код, сравнения с ограничениями и решения с серьёзными последствиями получают `complex`. Обычные сообщения и старые классификации без нового поля остаются на `conversation`. Размер истории сам по себе не выбирает дорогую модель.

Приветствия, реакции, извлечение оценки дискомфорта и технические проверки имеют ограниченные выходные токены. Обычный анализ сообщений не запускает планировщик, чей результат ранее заменялся фиксированным планом. Provider retry, same-provider degradation и fallback выполняются существующим runtime; скрытые повторы SDK OpenAI, OpenRouter и Z.AI отключены. Ошибки `credit_balance_exhausted` не должны запускать повторные вызовы, которые не могут восстановить баланс.
