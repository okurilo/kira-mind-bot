# Собственные покупательские MCP

Кира использует собственные MCP через существующее ядро инструментов. Пользователь поручает работу текстом или голосом: прочитать историю магазина, выбрать товары, предложить дополнения, подготовить корзину. Браузер может оставаться скрытым, пока приложение открыто. Вход, секретный ввод и оформление/оплата происходят на странице магазина в общем браузере iOS.

## Полнота реализации

| Сервис | MCP ID | Реализованные адаптеры | Незакрытая приёмка |
| --- | --- | --- | --- |
| Лавка | `kira_yandex_lavka` | Поиск, карточка, корзина/версия, история/детали заказов, draft и подтверждаемое обновление | Живой вход, адрес и реальные ответы текущего frontend |
| Купер | `kira_kuper` | Профиль, выбранный магазин, поиск/точный offer, корзина/позиции, история/детали, draft/обновление | Живой вход и формы ответов текущего frontend |
| Ozon | `kira_ozon` | Composer widgets каталога/карточки/корзины, список/детали заказов, draft/абсолютное количество | Подключение блокируется; пагинированная корзина отклоняется до подтверждения полноты |
| Маркет | `kira_yandex_market` | Поиск/точное предложение из `data-zone-data`, обычная цена отдельно от цены с картой | Личные корзина/заказы пока не автоматизированы и не объявляются в tools/list |
| Самокат | `kira_samokat` | Собственный общий браузер, отключение/очистка локальной истории | HTTP 403; private API не подтверждён, автоматические каталог/корзина/история не объявляются |

Это SDK MCP-серверы с initialize/tools/list/tools/call через локальные InMemoryTransport и operation-scoped Client/Server. Внешние stdio-пакеты не установлены; публичного удалённого MCP endpoint нет. Пять reserved ID добавляются в локальный каталог кодом: `mcp.json` не может подменить их или создать внутренний transport. Внешние MCP сохраняют прежний контракт.

Адаптер и синтетический тест не означают завершённой live-приёмки. Каталог API сохраняет maturity=experimental. HTTP 200 витрины не доказывает работу личного аккаунта/API.

## Задача и подтверждения

1. Планировщик использует реальные инструменты MCP, сохраняет ID и результаты между шагами. Уточнение ставит ту же задачу на паузу; ответ текстом/голосом продолжает её. Сохраняются runId, startedAt, analyticsTaskId, цель и квитанции.
2. purchase_history/get_order читают магазин; refresh=false явно возвращает сохранённую историю с временем наблюдения. Новый неполный список не затирает известный состав заказа; прежнее время наблюдения состава сохраняется отдельно. Отменённая позиция не становится полученной покупкой. Неизвестное количество не подменяется единицей.
3. preview_cart сохраняет локальный immutable draft: ID/revision, account binding, исходная ревизия корзины, срок 30 минут. Он не меняет магазин и не считается покупкой. merge сохраняет прочие позиции, replace заменяет состав по соответствующему поручению. Сумма товаров не выдаётся за итог с доставкой.
4. Канонический mcp.callTool запрашивает одно подтверждение точных draftId/revision с понятным составом/суммой. Модель не может передать confirmed=true, выбрать account identity или выдать разрешение. Перед записью перепроверяются аккаунт, корзина, цены и наличие; при изменении нужен новый итог.
5. До cart-write квитанция синхронизируется на диск. Передаются абсолютные количества, фактический результат проверяется. Частичный результат/потерянный ACK сохраняются как unknown; эта корзина не отправляется повторно под другим operation ID. Применения account/provider сериализованы.
6. checkout_preview читает корзину и передаёт страницу владельцу. Автоматической отправки/оплаты/отмены заказа и API платёжных средств нет. result.status=ok означает результат задачи, не покупку; её доказывает только магазин.

Подтверждение MCP пока принимает точный ответ «да»/«подтверждаю»/yes; произвольная утвердительная фраза не выдаёт разрешение. Для ручного оформления требуется страница магазина.

## Общий браузер iOS

Клиент использует `/messages` с `X-Kira-Browser-Session: v1`, существующий operation ID и browserSession.activePath. Секреты не передаются в `/messages` или voice utterance.

capabilities.browserSession.presentation объявляет modes=[background,visible], observerField=presentation, backgroundFrames=false. Регистрация observer допускает presentation; для нового observer default visible, отсутствие поля при повторе сохраняет режим. Background observer получает snapshot/state и поддерживает SSE/heartbeat без JPEG, даже при другом visible observer. Без видимого зрителя кадры не захватываются.

Скрытие sheet не останавливает задачу; фон ОС сохраняет прежнюю политику pause. Manual controller сначала освобождает lease через pause; попытка скрыть его без этого даёт 409 browser_control_required. take_control/humanInput требуют visible, иначе 409 browser_view_required. После visible асинхронно инициируется свежий frame; координатный ввод до него недопустим.

Snapshot.commerce={provider,manualCheckout:true,persistentLogin:boolean}. У собственного MCP persistentLogin=true означает сохранение своих cookies/origins/IndexedDB; магазин может потребовать повторный вход. У прежнего эфемерного browser-workflow false. Общий Chrome, Keychain и BrowserSessionStore не используются.

assistanceRequest.kind включает payment. Для login/otp/captcha/payment responseActions не содержит answer: только take_control/pause/stop. Открытие окна, загрузка CAPTCHA iframe и изменение viewport не сбрасывают ручной шаг и не возобновляют задачу; навигация основного документа инвалидирует прежний requestId. Кадры/ревизии при этом обновляются. Обычные уточнения доступны через observer/revision/requestId и существующий voice/text utterance.

Опциональный snapshot.result={id,text,status,createdAt} передаёт итог фонового продолжения в разговор при закрытом sheet. Клиент добавляет/озвучивает его один раз по ID с учётом аккаунта/операции/сессии; reconnect не должен повторять сообщение. Успешный общий результат не является чеком.

## Хранение и сеть

- Worker получает KIRA_COMMERCE_STORAGE_KEY, выведенный из master key с отдельным purpose=commerce и account UUID. Master key worker не наследует. В одиночном runtime без tenant ключ лениво создаётся в приватном commerce/storage.key (0600). Ключ и encrypted state нужно сохранять вместе при backup; выводить ключ в логи нельзя.
- Состояние: приватный runtime account/provider, AES-256-GCM и AAD account/provider/version, 0700/0600, лимит размера, NOFOLLOW файла, атомарная запись и fsync файла/директории. Повреждение/другой ключ/account дают отказ, не автоматический сброс.
- Cookies/storage/исходные ответы, адреса/телефоны/токены заказов не возвращаются модельным инструментом. Адаптеры выдают ограниченные DTO; история до 200 заказов. disconnect удаляет своё состояние входа, история остаётся; forget_history требует подтверждения. Смена merchant account обнаруживается, данные не сливаются. Самостоятельная перепривязка на другой merchant account пока не реализована.
- Перед Chromium устанавливается DNS-pinned public-network proxy с точными hostname. Ограничены private/link-local/metadata IP, plaintext HTTP, посторонние origin, QUIC/WebRTC bypass, service workers, WebSocket/downloads. Модель не задаёт URL, headers, cookie, JavaScript или endpoint.
- Неизвестные mutations запрещены. Native adapter имеет точный краткоживущий permit URL/method/body/generation только для известных cart-маршрутов и требует server-bound approval. Фоновые неизвестные POST блокируются без лишнего уточнения. Generic browser не получает native permit.
- Linux использует обычный Chromium с приватным Xvfb/Xauthority без TCP X11. Browser child получает минимальное окружение без DB/AI/storage secrets. Это не решатель CAPTCHA и не гарантия доступа.

Это защита от конкретных путей утечки/ошибок, не доказательство отсутствия всех уязвимостей. Оператор хоста и магазин остаются доверенными сторонами; видимые данные обрабатываются выбранной моделью по канонической политике согласия. Полный Chromium profile вне cookies/origins/IDB пока не сохраняется; OzonID device trust может потребовать повторного входа.

## Проверка подключения 4 ноября 2026

Гостевой headed Chromium через изолированный публичный proxy получил 200 у Маркета, Лавки и Купера. Реальный вызов собственного MCP поиска Маркета перевёл страницу на `/showcaptcha` (SmartCaptcha): это ручной шаг владельца, а не пустой результат. Ozon вернул 403 со страницей «Выключите VPN … подключитесь к другой сети», Самокат — защитный Forbidden. Современный официальный Playwright Chromium повторил эти два отказа: обновление браузера их не устранило. Вход и checkout не проверены.

Владелец сообщил, что подходящего собственного узла в РФ пока нет; его развёртывание отложено. Для магазинов важен выход браузерного узла в интернет, перенос AI-модели не обязателен. Сторонние proxy/решатели CAPTCHA и личные cookies не добавлялись.

Перед массовым выпуском нужны реальные вход/история/поиск/корзина каждого сайта, адрес/цены, истечение/отзыв входа, CAPTCHA/429, уточнение текстом/голосом и ручная передача страницы. CDN/SSO/3-D Secure domains добавляются после проверки назначения и регрессии; внешний банк не разрешается автоматически. Реальную покупку не использовать как smoke-тест.

## Проверки и референсы

tests/commerce-mcp.test.ts проверяет настоящий SDK, discovery без браузера/ключа, authority, encrypted state, draft/цены/конкуренцию/unknown и runtime continuation. tests/commerce-providers.test.ts проверяет синтетические source-ответы, условные цены, адрес/версию/idempotency, отменённые позиции и смену схемы; это не live-приёмка. tests/commerce-browser-host.test.ts проверяет proxy с замоканным Playwright, свой профиль/минимальное окружение, голосовое продолжение, checkpoint и cleanup. Остальные commerce/browser unit и HTTP-entry тесты сохраняют owner/API-only, сеть, прежние workflows, hidden observer и secret/result контракт.

scripts/testCommerceBrowser.cjs запускает настоящий headed Chromium/Xvfb с TLS-фикстурой в --network none: cookies двух контекстов, redirect/egress, POST и WebSocket. Только тест направляет public DNS в локальную фикстуру и отключает проверку одноразового сертификата; production этого не делает.

Изучены первичные исходники; чужие пакеты не установлены:

- [Ozon 5355103](https://github.com/Alexander-Zhukov/ozon-mcp/tree/5355103457475a75cb9682290221d4a697132f33): widgets, absolute quantities, статусы посылок, сеть/OzonID.
- [Маркет 92bb4df](https://github.com/SZhukovWork/yandex-market-mcp/tree/92bb4dfbc3b87d0c0f77aa7ede09faed7e661aa7): offer identity и условные цены.
- [Лавка 8ff40f5](https://github.com/Dudude-bit/yandex-lavka-mcp/tree/8ff40f5830daa9b7778912ddb364571992d905e8): POST-чтения, cartVersion/idempotency, history. Keychain и submit не перенесены.
- [kuper-api](https://github.com/inmyuse/kuper-api): source DTO, выбранный store, line-item API; не является зависимостью, completion не используется.
- [Официальный SmartCaptcha](https://yandex.cloud/ru/docs/smartcaptcha/quickstart): точный домен виджета/проверки разрешён для ручного шага. Автоматическая отправка CAPTCHA не разрешается.
