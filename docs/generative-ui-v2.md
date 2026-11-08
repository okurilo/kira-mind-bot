# Генеративный интерфейс: каталог v2

Дополнение к [точному v1-контракту](generative-ui.md). Источники истины: [типы](../generative-ui/contracts.ts), [v2 JSON Schema](generative-ui.v2.schema.json), [OpenAPI](../api/openapi.json), [общие примеры](../generative-ui/examples/v2). Все запросы используют прежнюю авторизацию аккаунта; мутации требуют `Idempotency-Key` 8–128 ASCII букв/цифр/`_`/`-`. Действия и TTS сохраняют прежний путь.

## Согласование

`GET /api/v1/capabilities` содержит `generativeUi.catalogs` и `catalogDefinitions[ID]`. Каталог v2 — `urn:kira:ui:catalog:2`: девять прежних компонентов, шесть новых представлений, четыре поля ввода, четыре вида действий. Отдельные возможности объявлены `metadata`, `feedback`, `forms`, `updates`, `proactive`. Полный descriptor — [capabilities.json](../generative-ui/examples/capabilities.json). Клиент выбирает один каталог на каждый ход:

```json
{"text":"Покажи план","ui":{"enabled":true,"catalogId":"urn:kira:ui:catalog:2"}}
```

V2 использует прежние `protocol:a2ui`, `version:1.0`, а также обязательную положительную `revision`. Новый снимок имеет `revision:1` и одно `createSurface`; восстановленный снимок может иметь большую revision. Все общие пределы v1 действуют. Никаких `null`, произвольных полей, вычислений, сетевых bindings или кода. Весь виджет валидируется до монтирования.

V1 без дополнительных флагов получает прежний снимок. Опциональный `ui.metadata:true` включает только `meta` по [отдельной схеме v1](generative-ui.metadata.schema.json); этот флаг сервер объявляет в `generativeUi.metadata.requestFlag`. Новые компоненты в v1 никогда не добавляются.

## Метаданные

```json
{"title":"Учебный прогноз","asOf":"2041-04-12T19:00:00Z","sources":[{"label":"Источник","url":"https://example.org/weather"}]}
```

Это значение необязательного `ui.meta`. Поля необязательны, но объект содержит хотя бы одно. `title` ≤80, sources 1–8, label ≤160, URL ≤2048. HTTPS без credentials; compositor принимает только точные ссылки готового ответа/его кнопок. `asOf` — время **данных**, не генерации: копируется из готового ответа, иначе опускается. UTC `YYYY-MM-DDTHH:mm:ssZ` или с тремя знаками миллисекунд; календарь проверяется. Клиент показывает источник, дату данных и при необходимости собственный признак устаревания.

## Дополнительные компоненты

Кроме перечисленных полей у компонента обязательны `id` и `component`. Все подписи ≤160, detail/alt ≤500. Общие ограничения строк, дерева и ID — как в v1.

| Компонент | Поля и ограничения |
|---|---|
| Progress | `label`, `value:number` 0…1, `detail?` |
| Steps | `items` 1–16: `{label,detail?,state:done/current/todo}` |
| Map | `pins` 1–10: `{lat:-90…90,lon:-180…180,label}`; необязательный `region:{lat,lon,latitudeDelta:>0…180,longitudeDelta:>0…360}`; WGS84, карту рисует клиент |
| Image | `fileId` UUID v4, `alt`; только уже выданный файл этого API-ответа, загрузка через авторизованный `/api/v1/files/{fileId}`, без внешних URL |
| Countdown | `until` UTC, `label`; until дословно присутствует в ответе; обратный отсчёт считает клиент |
| Checklist | `items` 1–24: `{id,label,checked:boolean,actionToken?}`; уникальные item ID; без токена строка read-only |

Image наследует TTL существующего файлового транспорта (24 часа): `404` — штатный placeholder с alt, не повтор бизнес-действия. `Checklist.actionToken` отправляется в обычный `/actions` по нажатию; checked не меняется на сервере лишь от локального переключения. Итоговое состояние приходит в ответе или новом снимке. Эти токены не подтверждают произвольные сторонние действия.

## Формы

| Ввод | Поля |
|---|---|
| Choice | `label`, `options:[{value,label}]` 1–6, уникальные value ≤80; необязательный `value` — только из вариантов |
| Slider | `label,min,max,step,value`: конечные числа, `abs` ≤1e15, `max>min`, `step>0`, ≤1e6 шагов; value в диапазоне на сетке `min+n*step` |
| Toggle | `label,value:boolean` |
| DateTime | `label,min?,max?,value?`: UTC как в meta; min≤max, value в диапазоне |

Поля хранятся локально до явного нажатия Button. Его действие:

```json
{"event":{"name":"kira.submit","context":{"actionToken":"OPAQUE_TOKEN","fields":["choice","minutes"]}}}
```

`fields` содержит 1–8 уникальных ID видимых компонентов ввода этого дерева. Клиент отправляет все и только эти поля:

```json
{"actionToken":"OPAQUE_TOKEN","values":{"choice":"reading","minutes":25},"ui":{"enabled":true,"catalogId":"urn:kira:ui:catalog:2"}}
```

Никаких объектов/массивов/tool JSON внутри values. Сервер подписывает определения полей и понятную реплику формы, сверяет типы/границы/варианты **до записи квитанции**. Ошибка — `400 invalid_ui_values`, тот же ключ можно использовать для исправленной формы, если выполнение ещё не началось. Успех превращается в обычную реплику с подписями и выбранными значениями, проходит общий диалог, политику и подтверждения. Формы не дают прав внешней отправки и не заменяют чужое подтверждение «Да/Нет».

После выполнения повторяется точный body/ключ, включая values и UI-флаги. Изменённые values с использованным ключом/токеном →409. Точная успешная квитанция воспроизводится и после истечения токена. Новый невыполненный токен живёт 15 минут/до нового хода, как v1. При утрате сети нельзя менять ключ ради повторного исполнения.

## Поверхности и ревизии

Для осмысленного обновления уже показанной карточки клиент посылает новый вопрос с `ui.target:{surfaceId,revision}`. V2 compositor строит полный новый набор компонентов. Сервер проверяет владельца, текущую revision, источник данных `meta.asOf`, отсутствие более старых данных и интервал ≥60000 мс с предыдущего создания/обновления. Это обновление по запросу или отложенному ответу, не автоматический polling внешних источников.

Изменение доставляется через существующий канал `GET /api/v1/dialogue-jobs?uiAfter=0`:

```json
{"protocol":"a2ui","version":"1.0","catalogId":"urn:kira:ui:catalog:2","revision":2,"meta":{"asOf":"2041-04-12T20:00:00Z"},"messages":[{"version":"1.0","updateComponents":{"surfaceId":"kira_11111111111141118111111111111111","components":[{"id":"root","component":"Text","text":"Обновлённые учебные данные"}]}}]}
```

`updateComponents` в этом профиле содержит **полное дерево** от root: клиент проверяет его целиком, затем атомарно заменяет и удаляет прежние недостижимые узлы. Это не частичный patch. Revision ожидается предыдущая+1. Дубликаты/старые изменения игнорируются, при разрыве следует пересинхронизация, без частичного применения. Ограничение минуты относится к обновлениям данных; пользовательское удаление немедленное.

`DELETE /api/v1/ui/surfaces/{surfaceId}?expectedRevision=N` (ключ обязателен) публикует одно `deleteSurface:{surfaceId}` с revision N+1, без обязательного meta. Конфликт revision →409 `ui_revision_conflict`, частота →429 `ui_update_rate_limited`, устаревшие данные →409 `ui_data_stale`. Ошибка optional-обновления при ответе бота сохраняет его текст.

Polling возвращает прежние `jobs` и дополнительно `uiEvents:[{seq,kind,createdAt,deviceId?,bindingId?,messages:[{id,type,text?,ui}]}]`, `uiNextCursor` (строка). За страницу ≤50 событий, retention 500 событий на владельца. Сохраняй cursor **после** успешного применения всей страницы. `409 ui_cursor_expired` требует `GET /ui/surfaces` (≤128 последних, в том числе tombstone) и `/history`, затем нового cursor. `/history` возвращает текущий снимок, удалённый UI опускается. Старые текстовые сообщения сохраняются.

V2 поддерживает `Prefer: respond-async`. Отложенная задача сохраняет исходный opt-in/preset/версию хода; её готовый результат `/dialogue-jobs` имеет `ui` и `uiMessageId`. Для update этот результат и uiEvents могут дублировать одну revision — применяй один раз. Новая реплика, отмена и отзыв device binding подавляют поздний результат. V1 по-прежнему синхронен.

## Устройства, фоновые карточки и диагностика

Постоянный opt-in отличается от разрешения на один ход. После отдельного согласия владельца зарегистрируй случайный UUID устройства:

```http
PUT /api/v1/ui/devices/11111111-1111-4111-8111-111111111111
Idempotency-Key: device-register-001
```

```json
{"catalogId":"urn:kira:ui:catalog:2","proactive":true,"diagnostics":false}
```

Ответ `device:{id,bindingId,revision,catalogId,proactive,diagnostics,enabled}`. При изменении настроек передавай `expectedRevision` из последнего ответа; конкурентное изменение →409. Первичная регистрация без expectedRevision. Не более 32 записей устройств. После отзыва повторная регистрация требует текущую revision и выдаёт новый bindingId. `GET /ui/devices` читает настройки; `DELETE /ui/devices/{id}` отзывает binding и оба разрешения. При выходе из аккаунта отзови регистрацию и очисти local UI/token cache.

Запросы можно привязать к устройству через `ui.device:{id,bindingId}`. Для приватных фоновых карточек poll:
`GET /dialogue-jobs?uiAfter=0&uiDeviceId=<id>&uiBindingId=<bindingId>`.
Парные параметры обязательны, binding сверяется перед выдачей. Legacy poll без них не получает device-targeted notes. Изменение binding →409 `ui_device_binding_changed`, нужно перечитать настройки.

После успешной штатной доставки утренней сводки, напоминания, результата recurring task или proactive-сообщения сервер может создать `kind:widget-note` с обычным `messages[]` (текст+снимок). Это отдельная фоновая AI-задача под квотой и preset приложения; режим экономии, согласие AI и актуальные настройки устройства продолжают действовать. Один sourceKey/устройство доставляется один раз; отзыв согласия во время inference блокирует позднюю карточку. Генерация общая для подходящих устройств, surfaceId у каждого свой. Фоновые карточки статические: capability `proactive.actions:false`, без форм/кнопок. Они доступны через inbox polling; APNs и фоновые iOS wakeups этот серверный контракт не добавляет. Короткое сообщение может остаться без виджета.

## Обратная связь

`POST /api/v1/ui-feedback` с ключом:

```json
{"surfaceId":"kira_11111111111141118111111111111111","messageId":-1001,"verdict":"not_shown","reason":"unknownField:messages[0].createSurface.theme","device":{"id":"11111111-1111-4111-8111-111111111111","bindingId":"22222222-2222-4222-8222-222222222222"}}
```

`verdict`: useful/not_useful/not_shown. Первые два — явные оценки владельца, без reason. `not_shown` требует reason и включённой диагностики указанного действующего устройства (иначе403). `reason` ≤200: один из `unknownField,unknownComponent,unknownVersion,invalidGraph,tooLarge,limitExceeded,invalidValue,invalidAction,unsupportedCatalog,rendererError`, необязательный суффикс после `:` содержит только ASCII буквы/цифры/`_.[]-`. Текст, URL, exception stack и содержимое карточки не отправляются. Неизвестная чужая/сокращённая поверхность или неверный messageId →404. Квота 60 новых отзывов/минуту на владельца, повторы ключа не расходуют её.

`GET /ui/feedback-metrics` возвращает счётчики по последним ≤1000 отзывам. `shownOnDevice` — число useful+not_useful, а не предположение о всех выпущенных карточках; `rejectedOnDevice` и `rejectionReasons` учитывают not_shown; `unknownUnreported:true` сохраняет неизвестность остальных показов. `npm run eval:generative-ui -- --live --catalog=v2 --feedback-file=/path/to/metrics.json` добавляет эти наблюдения к синтетическому eval (сам файл — только ответ endpoint со счётчиками).

## AR-размещение

`GET /scene` объявляет `widgetPlacement:true`. Только исполняемый v2 `/scene/turns` может вернуть соседнее с messages поле `widgetPlacement:{surfaceId,objectId,side:front/top/wall}`. objectId — существующий present-объект **этой** scene.objects, не прежней комнаты. Передаётся отдельно от UI и avatar actions, без координат и воздействия на тело. Телефон повторно проверяет SceneActionGate, наличие объекта и согласие пользователя; вправе проигнорировать рекомендацию. Обычный текстовый запрос не передаёт compositor-у объекты сцены.

## Приёмка P0–P2

P0: точные ответы и переносимые fixtures в репозитории. P1: negotiated meta, owner-bound feedback, opt-in диагностики и метрики eval. P2: отдельный каталог, компоненты, формы, полные атомарные обновления, scene placement, persistent device opt-in и widget-note inbox. Всё покрыто offline-тестами; PostgreSQL-сценарий включается `KIRA_PLATFORM_TEST_PG_PORT` на отдельной синтетической БД. Публикация Git и фактическая версия запущенного сервера проверяются отдельно от наличия файлов. Если перед API установлен VPS gateway, ему нужен актуальный allowlist из `scripts/ops/api-gateway/http.conf.template`; этот документ не означает, что внешний gateway уже обновлён.
