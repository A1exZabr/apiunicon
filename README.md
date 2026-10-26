<p align="center">
  <a href="https://apiunicon.online"><img src="docs/assets/apiunicon-banner.svg" alt="APIUniCon: ask ChatGPT or Claude about your own business" width="100%"></a>
</p>

<p align="center">
  <sub>Powered by</sub><br>
  <a href="https://zabsoft.com">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/assets/zabsoft-logo-light.svg">
      <img src="docs/assets/zabsoft-logo-dark.svg" alt="ZabSoft" height="28">
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://github.com/A1exZabr/apiunicon/actions/workflows/ci.yml"><img src="https://github.com/A1exZabr/apiunicon/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-PolyForm%20Shield%201.0-00D6B4" alt="License: PolyForm Shield 1.0"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522.19-339933" alt="Node.js 22.19 or later">
  <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-server-05070F" alt="MCP server"></a>
</p>

<p align="center">
  <a href="https://apiunicon.online"><b>Website</b></a> ·
  <a href="https://apiunicon.online/pricing"><b>Cloud and pricing</b></a> ·
  <a href="https://apiunicon.online/blog">Blog</a> ·
  <a href="#по-русски">По-русски</a>
</p>

APIUniCon connects your AI assistant (Claude, ChatGPT, Codex, or another MCP client) to the API of a service you use. You give the assistant a link to the service's API documentation. APIUniCon turns it into a small, checked adapter, keeps your keys encrypted on your computer, and sends requests only to the addresses you approved. The assistant never sees your keys, and it cannot change your data without your confirmation unless you allow it.

> [!TIP]
> **Don't want to run it yourself?** [APIUniCon Cloud](https://apiunicon.online) is the same product, already running: nothing to install or keep up to date, and it works in Claude and ChatGPT on any device, your phone included. One service is free, and Pro is $10 a month. [See pricing →](https://apiunicon.online/pricing)

This repository is the local version: it runs on your own computer, and your keys stay there. The same product also runs as a cloud service, see [Cloud version](#cloud-version).

## Who it is for

- People who want their assistant to work with their own data in a service that has an API (a marketplace seller account, a CRM, an accounting system) without writing code or handing keys to the chat.
- Developers who want an MCP server that reaches HTTP APIs only through constrained adapters, with keys out of the model's reach.

## How it works

1. You ask your assistant, in plain words: `Connect my Wildberries account: https://dev.wildberries.ru/docs/openapi/api-information`.
2. APIUniCon looks for an adapter you already have for that service, then in the [shared catalog](#shared-adapter-catalog), and only then reads the documentation. When a site blocks automated readers, your assistant finds the official files (through its browser, web search, or public SDK repositories) and passes their links.
3. The assistant shows you a one-time link to a key-entry page on this computer. There you check where requests will go and paste your keys.
4. The assistant writes an [adapter](#adapters) for the operations you need, tests the read operations, and from then on calls them for you.
5. Anything that changes your data waits for your confirmation, see [Changes to your data](#changes-to-your-data).

## Install on macOS

You need Node.js 22.19 or later and npm.

```bash
git clone https://github.com/A1exZabr/apiunicon.git
cd apiunicon
npm ci
npm run service:install
```

`npm run service:install` builds the project and installs it as a per-user launchd service named `online.apiunicon.connector`. It starts at login and restarts after a failure. `npm run service:status` shows its state; `npm run service:uninstall` stops and removes it. Your data and the service logs stay in `~/.apiunicon`.

The installer ends with a one-time setup link, `http://127.0.0.1:3210/setup?t=…`. Open it and create the local administrator password. That is all the setup there is: no `.env` file, database setup, or encryption-key command. APIUniCon creates `~/.apiunicon` with a master key, the access token of its MCP endpoint (both file mode `0600`), and a SQLite database.

If you skip the link, the first link from your assistant that needs the password (a change to confirm, new keys, a deletion) takes you through the same setup and back. `npm run --silent setup-link` prints the setup link again; once the password exists, there is none.

To run it without the service, on macOS or Linux: `npm run dev`. It prints the setup link when it starts.

## Connect your assistant

### Claude Code

Register the running service once, from the project folder:

```bash
eval "$(npm run --silent mcp:claude)"
```

`npm run --silent mcp:claude` prints the `claude mcp add --transport http … --header "Authorization: Bearer …"` command with this computer's access token, and `eval` runs it. The endpoint answers no client without that token.

Then ask in plain words with the documentation link. `/mcp__apiunicon__connect <link>` is an optional shortcut for the same request.

Claude Code also runs commands and reads files as your user, so keep it out of `~/.apiunicon`, see [Security model](#security-model).

### ChatGPT

ChatGPT reaches the local version through OpenAI's Secure MCP Tunnel, which is available in developer mode. APIUniCon stays on the loopback address; the `tunnel-client` only makes an outbound HTTPS connection to `api.openai.com`, and no inbound port is opened.

1. In OpenAI Platform, open **Tunnels**, create a tunnel, and associate it with your ChatGPT workspace. Keep the tunnel ID and the runtime API key on screen: the key may be shown only once. Download `tunnel-client` from the same page.
2. In APIUniCon, open **Configure Secure MCP Tunnel**, upload `tunnel-client`, enter the tunnel ID and the runtime key, and select **Seal key and initialize**. Then **Run doctor** and **Start tunnel**, and wait until the status is healthy. APIUniCon gives the `tunnel-client` the endpoint's access token itself, in the `MCP_EXTRA_HEADERS` variable of its environment.
3. In ChatGPT, turn on developer mode in the settings, add a plugin, choose **Tunnel** as its connection, and select your tunnel.
4. In a new conversation with the plugin enabled, ask: `Use APIUniCon to list configured connections.` An empty list is a correct first answer.

Never paste the runtime key or any API key into the chat.

### Other MCP clients

The service speaks Streamable HTTP at `http://127.0.0.1:3210/mcp`. Every request needs the header `Authorization: Bearer <token>`, with the token from `~/.apiunicon/mcp.token`. For clients that start a local process, `npm run --silent mcp` runs the same tools over stdio from the project folder, without a token; after `npm run build`, `node dist/src/cli.js mcp` does the same without npm. Both write nothing to standard output before the protocol (plain `npm run mcp` prints npm's own header lines first, which a strict client rejects). The stdio process serves no pages itself: the key-entry, confirmation and approval links it gives open only while the HTTP service runs (`npm run service:install` or `npm run dev`).

## Keys

- You enter keys only on a one-time key-entry page at `http://127.0.0.1:3210/connect/…`, never in the chat. The page lists the API addresses the adapter may call; requests go only to the ones you keep selected. An address on a different domain from the documentation link is offered only when the official documentation names it, and it starts unselected. On a host that gives every customer a subdomain for its documentation, such as `acme.readme.io`, the domain is the whole host name, so another customer's site there counts as a different domain.
- Each key is encrypted separately with AES-256-GCM under the master key in `~/.apiunicon`. The assistant can see key names and whether they are filled in, never their values: keys are decrypted only inside APIUniCon when a request needs them, and no tool returns them.
- To replace a key, for example after you issue a new token, ask your assistant: it gives you a new one-time link for the same connection.
- To delete a connection, ask your assistant: it gives you a one-time link, and nothing is deleted until you confirm on that page.
- The key-entry page of a new connection opens without the administrator password, but only from this computer: it answers only on the loopback address. Replacing keys and deleting a connection need the password, like a change: the link alone, which the assistant also has, does neither.

## Changes to your data

Reading is the default. `call_adapter` runs only operations that read. An operation that changes data goes through `request_change`, and it runs only under these rules:

- **Changing data is off for every new connection.** You turn it on, per connection, on the connection's page in the local workspace. No tool of the assistant can turn it on.
- **Confirmation page.** For each change the assistant gets a one-time link, valid for 15 minutes, to a page on this computer that shows exactly what will be sent. The page asks you to sign in with the administrator password first: the link alone, which the assistant also has, confirms nothing. The change runs once, with the values shown, after you select **Run**. A deletion asks twice.
- **Changes without confirmation.** You can stop being asked, for one connection on its page or for every connection on the start page. Both go through a warning and an "I understand" tick, and one button turns confirmation back on. Even then an action runs at once only if you have already confirmed it once on the page, on that connection, in its current form; from then on it runs with any values. A new action, or one the assistant has changed since, comes as a link the first time. Deletions always come as a link. The **Recent changes** list on the connection's page marks every change made without confirmation.
- **Card in the chat.** A client that shows MCP Apps cards also shows the change as a card in the chat: Claude and ChatGPT through the cloud version, or a client that runs `npm run --silent mcp` over stdio and declares the MCP Apps UI extension when it connects. An ordinary change can be confirmed there with the card's **Run** button. It needs no sign-in: the card carries its own one-time token for that change, which the assistant never sees. A **Run** in the card confirms that one change only and never lets the action run at once later. A deletion or any other `destructive` operation, and the first confirmation of an action while confirmation is off, always go through the confirmation page, and the card only opens it. The local HTTP endpoint shows no card: there, and in every other client, the link is the only way to confirm.

A connection holds at most 10 waiting changes and 30 change requests per hour.

**Reads sent with POST.** Some services, such as Wildberries and Ozon, read through POST, so an operation sent with POST may be labelled as a read. Nothing about POST shows that the request changes nothing: only the label says so, and the assistant or a catalog author wrote it. So `call_adapter` and `test_adapter_operation` run such a read only after you approve it for that connection. The assistant gives you a one-time link, valid for 15 minutes, to a page on this computer that lists every such read of the adapter with its address, description and inputs, and asks you to sign in first. The approval covers any values the assistant chooses for those inputs, so the page marks each input that takes any text or data: through one, a single address such as a GraphQL or JSON-RPC endpoint can be asked anything, a change included. **Allow as reads** lets the assistant call them without asking you; **Don't allow** leaves them blocked. If the assistant changes one of them later, its label or description included, it waits for your approval again. Reads of an adapter copied from the shared catalog come approved by the catalog's moderation, exactly as the entry publishes them; one changed after copying needs your approval. The approval does not depend on your plan or on **Changing data**: it lets the assistant read, not change.

## Adapters

An adapter is a constrained JSON description of a service's API. The assistant writes it from the documentation; APIUniCon validates it and runs nothing outside it:

```json
{
  "schemaVersion": 1,
  "baseOrigins": ["https://api.example.com"],
  "credentialBindings": [{ "fieldName": "Authorization", "target": "header", "headerName": "Authorization" }],
  "operations": [
    {
      "id": "list_orders",
      "description": "Orders created since a date",
      "risk": "read",
      "method": "GET",
      "path": "/v1/orders",
      "input": { "dateFrom": { "type": "string", "location": "query", "required": true } },
      "response": { "select": ["orders.id", "orders.status"] },
      "documentationRefs": ["https://example.com/docs/orders"]
    }
  ]
}
```

- `baseOrigins` are HTTPS origins only, with no path, credentials, or query. An operation's `path` must be a safe relative path; dot segments and full URLs are refused.
- Keys go only into the request headers named in `credentialBindings`.
- Every operation is labelled `read`, `write`, or `destructive`, and the method overrides a wrong label: a `DELETE` is always destructive, and a `PUT` or `PATCH` is never treated as a read. A `GET` keeps its label, and labelled `read` it runs at once: the code takes a `GET` as a read by its method. A `POST` keeps its label. A `POST` labelled `read` runs only after you approve it, see [Reads sent with POST](#changes-to-your-data). A deletion sent with `POST` is recognized only by its label: labelled `write`, it is confirmed like any other write, once on the confirmation page or in the card, where you see exactly what will be sent, and with confirmation off it then runs at once.
- `response.select` keeps only the fields the assistant needs from a large answer.

When an adapter works, the assistant can ask you to make it reusable. You review a sanitized preview on the adapter's page (no keys, connection names, account data, API answers, or conversation content) and select **Confirm reusable adapter**. A second connection to the same service then reuses it at once, without reading the documentation again. The assistant never changes a reusable adapter, or one that several connections share, in place: a fix gives the connection it is working on a private copy, which keeps what was learned about the original, and every other connection keeps the version you reviewed. An adapter copied from the catalog belongs to the one connection it was copied for, so a fix changes it in place, and from then on it is no longer the catalog's: its reads sent with POST that did not change keep the catalog's approval, and a changed one waits for yours. Nothing is erased either way: the connection's history of calls and the adapter's tests and learnings stay.

## Shared adapter catalog

The cloud version keeps a shared catalog of ready-made adapters, so a service someone has already connected can be connected without reading its documentation. The local version uses it by default.

- **Nothing about your connections is sent until you sign in.** The first time, the assistant shows you `http://127.0.0.1:3210/catalog/connect`, which signs this computer in with a free cloud account (OAuth with PKCE). It asks for the administrator password first, and the cloud's answer is taken only in the browser that started the sign-in. Opening it registers this computer with the cloud as a client: a client name and the local callback address.
- **After sign-in the cloud learns only** the documentation link without its query string or fragment, and the id of the catalog entry the assistant chose. Keys, connections, and API results are never sent. The catalog key is stored encrypted, like service keys, and goes only to the cloud that issued it.
- **Catalog entries are untrusted.** An entry is copied as a private adapter only when every address is on the documentation link's domain and every operation that changes data is labelled for what it does, with each input described. A copied adapter starts with changing data off, and the key-entry page still shows every address for you to approve. Its reads sent with POST come approved by the catalog's moderation, which checks their labels, exactly as the entry publishes them.
- [http://127.0.0.1:3210/catalog](http://127.0.0.1:3210/catalog), after the administrator password, shows whether this computer is signed in, signs it out (the key is revoked in the cloud and erased locally), and has **Don't use the catalog**.

The cloud follows the language of the system: a Russian locale (`LC_ALL`, `LC_MESSAGES`, or `LANG`, in that order) uses `https://apiunicon.ru`, anything else `https://apiunicon.online`. A launchd service starts without a locale, so the installer writes `LANG` into it: the locale of the shell that ran it or, when that shell has none, the macOS system locale. `APIUNICON_CATALOG_ORIGIN` names another cloud (HTTPS origins only).

## Cloud version

APIUniCon also runs as a hosted service at [apiunicon.online](https://apiunicon.online) and, for Russia, [apiunicon.ru](https://apiunicon.ru). You add it to Claude or ChatGPT as a remote connector, and key-entry and confirmation links open on any device, including a phone. The cloud's own code is not in this repository.

One service with 1,000 calls a month is free. Pro is $10 a month ($84 a year) for 10 services, and Business is $35 a month ($300 a year) for 50. See [pricing](https://apiunicon.online/pricing).

## Configuration

None of this is needed for normal use. Export a variable before `npm run dev`, or use `.env.example` as a template for your shell:

- `APIUNICON_HOME`: the data folder (default `~/.apiunicon`). APIUniCon makes it readable by you alone, so it takes only a new or empty folder, or one of its own: one that holds its master key, whatever else is in it, or only its own files. It refuses any other folder with files in it.
- `APIUNICON_MASTER_KEY`: an existing base64-encoded 32-byte master key.
- `APIUNICON_DB_PATH`: the database file.
- `APIUNICON_HTTP_HOST`, `APIUNICON_HTTP_PORT`: where the service listens (default `127.0.0.1:3210`). Only a loopback address is accepted: `127.0.0.1`, `::1`, or `localhost`.
- `APIUNICON_CATALOG_ORIGIN`: the cloud of the shared catalog.
- Limits on response size, request time, and documentation crawling, listed in `.env.example`.

The macOS service does not carry these over; set them in the environment of `npm run dev` or `npm run --silent mcp`.

## Development

```bash
npm ci
npm run check                  # strict TypeScript
npm test -- --maxWorkers=2     # the full suite; each test file gets its own temporary home folder
npm run build
npx tsx src/cli.ts verify-secrets   # then paste a distinctive part of a key
```

`verify-secrets` checks that a key is not stored readable. It reads a part of the key you know from standard input: it asks you to paste it and does not show it, or takes it from a pipe, and refuses it as an argument, which the shell history would keep. It fails if any column of the database holds that text, and names each column with the number of rows. It searches every table, the full-text index of the documentation included, and every column except the encrypted key values and the digests and salts of tokens, passwords and documents. A value stored as JSON is searched both as stored and decoded, so a part with a quote or a backslash is found too. It checks only the database, not the service logs in `~/.apiunicon/logs`.

See [CONTRIBUTING.md](CONTRIBUTING.md): for now we accept issues, not pull requests.

## Security model

- **The protection boundary is the MCP interface.** Every guarantee in this README (the assistant never sees your keys, changes and reads sent with POST wait for you, links need your sign-in) holds for an assistant that reaches APIUniCon only through its tools. An assistant that can run commands or read files as your user, such as Claude Code or Codex CLI, can read `~/.apiunicon` instead: the master key and the database, so every key, and the MCP token. It can then call services itself, open the links it gets, or change settings in the database. Do not give such an assistant access to that folder: exclude `~/.apiunicon` in its sandbox or permission settings, or run it as another user. A rule that only matches the text of shell commands does not reliably keep a shell out. An assistant that controls a browser or the screen (a browser extension, computer use, Playwright MCP) can open its own links in a browser where you are signed in and press the buttons there itself, so do not give such tools access to the workspace at `http://127.0.0.1:3210`.
- APIUniCon is for this computer only. It refuses to listen on anything but a loopback address, answers only connections from this computer, and answers every page except `/health` only when the `Host` header is a loopback name with its own port, so a site that points its DNS name at `127.0.0.1` (DNS rebinding) gets nothing.
- The administrator password is created only through the one-time setup link. Its token is kept in `~/.apiunicon/setup.token` (mode `0600`) until the password exists, and only the setup link and the assistant's links carry it, so no web page can create the password first.
- The web workspace needs the administrator password, a session cookie, and a CSRF token. A request that changes something is refused when the browser says it comes from another site or another program on this computer (`Origin`, `Sec-Fetch-Site`). After 5 wrong passwords the sign-in is locked for a minute, and each further wrong password doubles the lock, up to an hour. **Lock workspace** ends every session.
- The pages that confirm a change, approve reads, replace keys, or delete a connection open only after the sign-in, and so do the catalog page and the start of a catalog sign-in. The cloud's answer to that sign-in comes back without the workspace's cookie, so it is taken only with a cookie of its own that the browser which started the sign-in received.
- The MCP endpoint answers only a client that sends the access token from `~/.apiunicon/mcp.token` (mode `0600`). Any program running as your user can read that folder, as it can the master key.
- An error page never shows file paths or database messages; the details go to the service log.
- Requests go only to an adapter's approved origins plus safe relative paths. Loopback, private, link-local, multicast, and reserved addresses are refused, and the address checked is the one each connection is opened to, so a DNS answer that changes after the first check cannot reach them. Redirects are refused.
- Documentation, API answers, and catalog entries are treated as untrusted data.
- Operation labels are the assistant's or a catalog author's words, so the code holds what the method shows: a `DELETE` is always a deletion, and a `PUT` or `PATCH` always a change. A `GET` labelled `read` runs at once, without your approval: the code trusts a `GET` to be a read by its method alone. An API that changes data through `GET` gets no protection from that, so such an operation is safe only when it is labelled `write` or `destructive`. A `POST` can do either, and only its label says which. A `POST` labelled as a read runs only after you approve it for the connection in its current form, or when it comes unchanged from the moderated catalog. A deletion sent with `POST` is recognized only by its label: labelled `write`, it is confirmed once, as a write, not twice as a deletion.
- The `tunnel-client` gets a narrow environment and fixed arguments without a shell, and its diagnostics are capped and redacted.

Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## License

The code is available under the [PolyForm Shield License 1.0.0](LICENSE). In plain words, and not as legal advice:

- You may use, copy, and change APIUniCon for any purpose, including inside a business, for free.
- You may not use it to offer a product that competes with APIUniCon or with a product Zabsoft LLC provides using it, such as the cloud version.
- If you pass on a copy, include the license and its `Required Notice` line.
- It comes without warranty.

This is a source-available license, not an OSI-approved open-source one. The APIUniCon name and logo are trademarks of Zabsoft LLC and are not licensed with the code, see [TRADEMARKS.md](TRADEMARKS.md).

---

## По-русски

APIUniCon подключает вашего ИИ-ассистента (Claude, ChatGPT, Codex или другой MCP-клиент) к API сервиса, которым вы пользуетесь. Вы даёте ассистенту ссылку на документацию API. APIUniCon превращает её в небольшой проверенный адаптер, хранит ваши ключи зашифрованными на вашем компьютере и отправляет запросы только на адреса, которые вы одобрили. Ассистент никогда не видит ключей и не может изменить ваши данные без вашего подтверждения, если вы сами этого не разрешили.

> [!TIP]
> **Не хотите ставить у себя?** [Облачная версия](https://apiunicon.ru) — тот же APIUniCon, уже запущенный: ничего не нужно устанавливать и обновлять, и он работает в Claude и ChatGPT на любом устройстве, включая телефон. Один сервис бесплатно, Pro — 590 ₽ в месяц. [Тарифы →](https://apiunicon.ru/pricing)

Этот репозиторий — локальная версия: она работает на вашем компьютере, и ключи остаются на нём. Есть и облачная версия, см. [Облачная версия](#облачная-версия).

### Для кого

- Для тех, кто хочет, чтобы ассистент работал с их собственными данными в сервисе с API (кабинет продавца на маркетплейсе, CRM, учётная система), без программирования и без передачи ключей в чат.
- Для разработчиков, которым нужен MCP-сервер, который ходит в HTTP API только через ограниченные адаптеры и не даёт модели доступа к ключам.

### Как это работает

1. Вы пишете ассистенту обычными словами: `Подключи мой кабинет Wildberries: https://dev.wildberries.ru/docs/openapi/api-information`.
2. APIUniCon ищет уже готовый ваш адаптер для этого сервиса, затем в общем каталоге, и только потом читает документацию. Если сайт не пускает автоматических читателей, ассистент сам находит официальные файлы (через свой браузер, поиск или публичные репозитории SDK) и передаёт ссылки на них.
3. Ассистент показывает одноразовую ссылку на страницу ввода ключей на этом компьютере. Там вы проверяете, куда пойдут запросы, и вставляете ключи.
4. Ассистент пишет адаптер для нужных операций, проверяет операции чтения и дальше вызывает их за вас.
5. Всё, что меняет ваши данные, ждёт вашего подтверждения.

### Установка на macOS

Нужны Node.js 22.19 или новее и npm.

```bash
git clone https://github.com/A1exZabr/apiunicon.git
cd apiunicon
npm ci
npm run service:install
```

`npm run service:install` собирает проект и ставит его службой launchd текущего пользователя с именем `online.apiunicon.connector`: она запускается при входе в систему и перезапускается после сбоя. `npm run service:status` показывает её состояние, `npm run service:uninstall` останавливает и удаляет. Данные и журналы службы остаются в `~/.apiunicon`.

Установщик в конце печатает одноразовую ссылку настройки `http://127.0.0.1:3210/setup?t=…`. Откройте её и задайте пароль локального администратора. Больше ничего настраивать не нужно: ни `.env`, ни базы данных, ни ключа шифрования. APIUniCon сам создаёт `~/.apiunicon` с мастер-ключом, токеном доступа к своему MCP-адресу (оба с правами `0600`) и базой SQLite.

Если пропустить ссылку, первая ссылка от ассистента, для которой нужен пароль (подтвердить изменение, заменить ключи, удалить подключение), проведёт через ту же настройку и вернёт обратно. `npm run --silent setup-link` печатает ссылку настройки ещё раз; когда пароль уже задан, её нет.

Без службы, на macOS или Linux: `npm run dev`. При запуске он печатает ссылку настройки.

### Подключение ассистента

**Claude Code.** Один раз зарегистрируйте сервис, из папки проекта:

```bash
eval "$(npm run --silent mcp:claude)"
```

`npm run --silent mcp:claude` печатает команду `claude mcp add --transport http … --header "Authorization: Bearer …"` с токеном доступа этого компьютера, а `eval` её выполняет. Без этого токена MCP-адрес не отвечает ни одному клиенту.

Дальше просите обычными словами со ссылкой на документацию. `/mcp__apiunicon__connect <ссылка>` — необязательное сокращение для того же.

Claude Code ещё и выполняет команды и читает файлы от вашего пользователя, поэтому не пускайте его в `~/.apiunicon`, см. раздел о безопасности ниже.

**ChatGPT.** ChatGPT достаёт до локальной версии через Secure MCP Tunnel от OpenAI в режиме разработчика. APIUniCon остаётся на адресе loopback; `tunnel-client` сам открывает исходящее HTTPS-соединение с `api.openai.com`, входящих портов не нужно.

1. В OpenAI Platform откройте **Tunnels**, создайте туннель и свяжите его со своим рабочим пространством ChatGPT. Не закрывайте экран с ID туннеля и runtime API key: ключ может показываться только один раз. Там же скачайте `tunnel-client`.
2. В APIUniCon откройте **Configure Secure MCP Tunnel**, загрузите `tunnel-client`, введите ID туннеля и ключ и нажмите **Seal key and initialize**. Затем **Run doctor** и **Start tunnel** и дождитесь состояния healthy. Токен доступа к MCP-адресу APIUniCon сам передаёт `tunnel-client` в переменной окружения `MCP_EXTRA_HEADERS`.
3. В ChatGPT включите режим разработчика в настройках, добавьте плагин, выберите подключение **Tunnel** и свой туннель.
4. В новом разговоре с включённым плагином спросите: `Use APIUniCon to list configured connections.` Пустой список — правильный первый ответ.

Никогда не вставляйте runtime key или ключи API в чат.

**Другие MCP-клиенты.** Сервис отвечает по Streamable HTTP на `http://127.0.0.1:3210/mcp`. Каждому запросу нужен заголовок `Authorization: Bearer <токен>` с токеном из `~/.apiunicon/mcp.token`. Клиентам, которые сами запускают локальный процесс, подходит `npm run --silent mcp` из папки проекта: те же инструменты через stdio, без токена; после `npm run build` то же делает `node dist/src/cli.js mcp`, без npm. Обе команды ничего не пишут в стандартный вывод до протокола (просто `npm run mcp` сначала печатает строки npm, и строгий клиент на них спотыкается). Сам процесс stdio страниц не отдаёт: ссылки на ввод ключей, подтверждение и одобрение открываются, только пока работает HTTP-служба (`npm run service:install` или `npm run dev`).

### Ключи

- Ключи вводятся только на одноразовой странице `http://127.0.0.1:3210/connect/…`, никогда в чате. Страница показывает адреса, к которым может обращаться адаптер; запросы пойдут только на те, что останутся отмеченными. Адрес на другом домене, чем ссылка на документацию, предлагается, только если его называет официальная документация, и он не отмечен заранее. На хостинге, который даёт каждому клиенту поддомен для документации, например `acme.readme.io`, домен — всё имя хоста, так что сайт другого клиента там считается другим доменом.
- Каждый ключ шифруется отдельно (AES-256-GCM) мастер-ключом из `~/.apiunicon`. Ассистент видит названия ключей и то, заполнены ли они, но не значения: ключи расшифровываются только внутри APIUniCon, когда они нужны запросу, и ни один инструмент их не возвращает.
- Чтобы заменить ключ, например после выпуска нового токена, попросите ассистента: он даст новую одноразовую ссылку для того же подключения.
- Чтобы удалить подключение, попросите ассистента: он даст одноразовую ссылку, и ничего не удаляется, пока вы не подтвердите на странице.
- Страница ввода ключей нового подключения открывается без пароля администратора, но только с этого компьютера: она отвечает только на адресе loopback. Замена ключей и удаление подключения, как и изменение, требуют пароля: одна ссылка, которая есть и у ассистента, ни того ни другого не делает.

### Изменение данных

По умолчанию — только чтение. `call_adapter` выполняет лишь операции чтения. Операция, которая меняет данные, идёт через `request_change` и выполняется только по этим правилам:

- **Изменение данных выключено у каждого нового подключения.** Включаете его вы, для каждого подключения отдельно, на странице подключения в локальном кабинете. Ни один инструмент ассистента включить его не может.
- **Страница подтверждения.** На каждое изменение ассистент получает одноразовую ссылку на 15 минут на страницу на этом компьютере, где видно, что именно будет отправлено. Страница сначала просит войти с паролем администратора: одна ссылка, которая есть и у ассистента, ничего не подтверждает. Изменение выполняется один раз, с показанными значениями, после кнопки **Run**. Удаление спрашивает дважды.
- **Изменения без подтверждения.** Можно перестать подтверждать: для одного подключения на его странице или для всех на стартовой. И то и другое — через предупреждение и галочку **I understand**; вернуть подтверждение можно одной кнопкой. Но и тогда действие выполняется сразу, только если вы уже один раз подтвердили его на странице, на этом подключении, в нынешнем виде; дальше оно выполняется с любыми значениями. Новое действие или изменённое ассистентом после этого приходит ссылкой в первый раз. Удаление всегда приходит ссылкой. В списке **Recent changes** на странице подключения отмечено каждое изменение без подтверждения.
- **Карточка в чате.** Клиент, который показывает карточки MCP Apps, показывает изменение и карточкой в чате: Claude и ChatGPT через облачную версию или клиент, который запускает `npm run --silent mcp` по stdio и при подключении объявляет расширение интерфейса MCP Apps. Обычное изменение можно подтвердить кнопкой **Run** в карточке (в облаке на русском — **Выполнить**). Вход для этого не нужен: у карточки свой одноразовый токен для этого изменения, и ассистент его не видит. Такое подтверждение касается только этого изменения и не разрешает выполнять действие сразу в будущем. Удаление и любая другая операция с меткой `destructive`, а также первое подтверждение действия при выключенном подтверждении всегда проходят через страницу подтверждения, и карточка только открывает её. Локальный HTTP-адрес карточку не показывает: там и во всех остальных клиентах подтвердить можно только по ссылке.

У подключения не больше 10 ожидающих изменений и 30 запросов на изменение в час.

**Чтение через POST.** Некоторые сервисы, например Wildberries и Ozon, читают через POST, поэтому операция с методом POST может быть помечена как чтение. По методу POST не видно, что запрос ничего не меняет: об этом говорит только метка, а её написал ассистент или автор записи каталога. Поэтому `call_adapter` и `test_adapter_operation` выполняют такое чтение только после вашего одобрения для этого подключения. Ассистент даёт одноразовую ссылку на 15 минут на страницу на этом компьютере, где перечислены все такие чтения адаптера с адресом, описанием и параметрами; страница сначала просит войти. Одобрение действует для любых значений параметров, которые выберет ассистент, поэтому страница отмечает каждый параметр, который принимает любой текст или данные: через такой параметр у одного адреса, например GraphQL или JSON-RPC, можно попросить что угодно, в том числе изменение. **Allow as reads** разрешает ассистенту вызывать их без вашего подтверждения, **Don't allow** оставляет их закрытыми. Если ассистент потом изменит какое-то из них, в том числе метку или описание, оно снова ждёт одобрения. Чтения адаптера, скопированного из общего каталога, приходят одобренными модерацией каталога ровно в том виде, в каком они в записи; изменённое после копирования требует вашего одобрения. Одобрение не зависит от тарифа и от **Changing data**: оно разрешает чтение, а не изменение.

### Адаптеры и каталог

Адаптер — ограниченное JSON-описание API сервиса (пример выше, в английской части). Ассистент пишет его по документации, APIUniCon проверяет и не выполняет ничего за его пределами: только HTTPS-адреса без пути, безопасные относительные пути, ключи только в названных заголовках. Каждая операция помечена как `read`, `write` или `destructive`, и метод исправляет неверную метку: `DELETE` всегда удаление, `PUT` и `PATCH` никогда не чтение. `GET` с меткой `read` выполняется сразу, без вашего одобрения: код считает `GET` чтением по одному методу, поэтому операцию API, которая меняет данные через `GET`, защищает только метка `write` или `destructive`. `POST` сохраняет метку: чтение через `POST` выполняется только после вашего одобрения (см. выше), а удаление через `POST` узнаётся только по метке. Если оно помечено как `write`, его подтверждают как обычное изменение, один раз на странице подтверждения или в карточке, где видно, что именно будет отправлено, а при выключенном подтверждении после этого оно выполняется сразу.

Рабочий адаптер можно сделать повторно используемым: вы смотрите очищенный предпросмотр на странице адаптера (без ключей, названий подключений, данных аккаунта, ответов API и переписки) и нажимаете **Confirm reusable adapter**. Второе подключение к тому же сервису сразу берёт его, без чтения документации. Ассистент никогда не правит на месте повторно используемый адаптер или адаптер нескольких подключений: исправление получает подключение, с которым он работает, в виде своей частной копии, в которой сохраняются знания об оригинале, а остальные подключения остаются на просмотренной вами версии. Копия из каталога принадлежит одному подключению, для которого её сделали, поэтому исправление меняет её на месте, и после этого она уже не копия записи каталога: её неизменённые чтения через POST сохраняют одобрение каталога, а изменённое ждёт вашего. В обоих случаях ничего не стирается: журнал вызовов подключения, тесты и знания адаптера остаются.

Общий каталог готовых адаптеров ведёт облачная версия; локальная пользуется им по умолчанию. **Пока вы не вошли, о ваших подключениях ничего не отправляется.** В первый раз ассистент покажет `http://127.0.0.1:3210/catalog/connect` — вход этого компьютера с бесплатным облачным аккаунтом (OAuth с PKCE). Страница сначала просит пароль администратора, а ответ облака принимается только в том браузере, где вход начат; открытие ссылки регистрирует компьютер в облаке как клиента (имя клиента и локальный адрес возврата). После входа облако узнаёт только ссылку на документацию без запроса и якоря и id выбранной записи каталога. Ключи, подключения и ответы API туда не уходят. Записи каталога — недоверенные данные: запись копируется, только если все адреса на домене ссылки и каждая операция изменения помечена честно и с описанными параметрами; у копии изменение данных выключено, а её чтения через POST приходят одобренными модерацией каталога, которая проверяет их метки, ровно в том виде, в каком они в записи. На [http://127.0.0.1:3210/catalog](http://127.0.0.1:3210/catalog), тоже после пароля администратора, можно выйти из каталога или выбрать **Don't use the catalog**.

Облако выбирается по языку системы: русская локаль (`LC_ALL`, `LC_MESSAGES` или `LANG`) — `https://apiunicon.ru`, иначе `https://apiunicon.online`. Установщик службы записывает в неё `LANG` оболочки, а если в оболочке его нет — локаль macOS. `APIUNICON_CATALOG_ORIGIN` задаёт другое облако.

### Облачная версия

APIUniCon работает и как облачный сервис: [apiunicon.online](https://apiunicon.online) и для России [apiunicon.ru](https://apiunicon.ru). Его добавляют в Claude или ChatGPT как удалённый коннектор, и ссылки для ключей и подтверждений открываются на любом устройстве, в том числе на телефоне. Код самого облака в этот репозиторий не входит.

Один сервис и 1 000 запросов в месяц бесплатно. Pro — 590 ₽ в месяц (4 990 ₽ за год) за 10 сервисов, Business — 2 490 ₽ в месяц (20 990 ₽ за год) за 50. [Тарифы](https://apiunicon.ru/pricing).

### Разработка и безопасность

Команды для разработки и подробная модель безопасности — в английской части. Коротко: граница защиты — MCP-интерфейс. Все гарантии здесь (ассистент не видит ключей, изменения и чтение через POST ждут вас, ссылкам нужен вход) действуют для ассистента, который работает с APIUniCon только через его инструменты. Ассистент с доступом к командам или файлам от вашего пользователя, например Claude Code или Codex CLI, может прочитать `~/.apiunicon` — мастер-ключ, базу, а значит и все ключи, и токен MCP — и обойти их. Не давайте такому ассистенту доступ к этой папке: закройте `~/.apiunicon` в его песочнице или настройках разрешений либо запускайте его от другого пользователя; правило, которое лишь сверяет текст команд оболочки, надёжно не защищает. Ассистент, который управляет браузером или экраном (расширение браузера, computer use, Playwright MCP), может сам открыть свои ссылки в браузере, где вы вошли, и нажать там кнопки, поэтому не давайте таким инструментам доступа к рабочему месту на `http://127.0.0.1:3210`. Дальше: APIUniCon слушает только адрес loopback и отвечает только этому компьютеру и только на заголовок `Host` с адресом loopback и своим портом; пароль администратора задаётся только по одноразовой ссылке настройки; запросы, которые что-то меняют, с другого сайта отклоняются; после 5 неверных паролей вход блокируется на минуту, и каждая следующая ошибка удваивает блокировку, до часа; **Lock workspace** завершает все сеансы. Правки (pull requests) пока не принимаем, только issues, см. [CONTRIBUTING.md](CONTRIBUTING.md). Об уязвимостях сообщайте закрыто, как описано в [SECURITY.md](SECURITY.md): через Private vulnerability reporting на GitHub или письмом на support@apiunicon.online с темой «Security».

### Лицензия

Код доступен по лицензии [PolyForm Shield 1.0.0](LICENSE). Простыми словами, без юридической силы:

- APIUniCon можно бесплатно использовать, копировать и изменять для любых целей, в том числе в бизнесе.
- Нельзя использовать его, чтобы предлагать продукт, который конкурирует с APIUniCon или с продуктом, который Zabsoft LLC делает на его основе, например с облачной версией.
- Передавая копию, приложите лицензию и строку `Required Notice`.
- Гарантий нет.

Это лицензия с открытым кодом, но не open source в смысле OSI. Название и логотип APIUniCon — знаки Zabsoft LLC, лицензия на код их не передаёт, см. [TRADEMARKS.md](TRADEMARKS.md).
