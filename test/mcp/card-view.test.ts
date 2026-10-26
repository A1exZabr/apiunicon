import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { runInNewContext, Script } from "node:vm";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AdapterDsl } from "../../src/adapters/schema.js";
import type { AppConfig } from "../../src/config.js";
import { buildApplication, type Application } from "../../src/index.js";
import { CHANGE_CARD_URI, changeCardHtml, registerChangeCard, type CardAnswer, type ChangeCardData } from "../../src/mcp/card.js";
import { buildCardHtml, CARD_CSP, CARD_STYLE, CARD_VIEW_SCRIPT } from "../../src/mcp/card-view.js";
import { createMcpServer } from "../../src/mcp/server.js";

type ConfirmCard = Extract<ChangeCardData, { kind: "confirm" }>;

const WRITE: ConfirmCard = {
  kind: "confirm",
  locale: "ru",
  changeId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  cardToken: "AbCdEfGhIjKlMnOpQrStUv",
  step: 0,
  risk: "write",
  expiresAt: "2026-10-26T10:15:00.000Z",
  url: "https://apiunicon.ru/confirm/change/7c9e6679-7425-40de-944b-e07fc1f90ae7?t=link-token",
  heading: "Изменить данные в «Shop»?",
  lede: "Ваш ИИ-ассистент просит сделать это в api.shop.test. Пока вы не нажмёте «Выполнить», ничего не изменится.",
  facts: [
    { label: "Действие (так его описывает адаптер)", value: "Set the price of a card" },
    { label: "Куда", value: "POST https://api.shop.test/prices" },
  ],
  valuesTitle: "Будет отправлено",
  values: [
    { label: "Цена, ₽", name: "price", value: "349", block: false },
    { label: "card", name: "card", value: "{\n  \"title\": \"Шарф\"\n}", block: true },
  ],
  noValues: "Ничего, кроме адреса выше.",
  assistant: "Ассистент пишет: «Поставить цену 349 ₽»",
  assistantNote: "Это слова ассистента. Отправлены будут значения выше.",
  warnings: ["Это действие ещё ни разу не выполнялось через APIUniCon."],
  expires: "Кнопки действуют 15 минут с момента запроса ассистента.",
  labels: {
    run: "Выполнить",
    cancel: "Отмена",
    openPage: "Открыть страницу подтверждения",
    pressing: "Выполняю…",
    callFailed: "Нажатие не дошло. Откройте страницу подтверждения.",
  },
};

const DELETE: ConfirmCard = {
  ...WRITE,
  changeId: "0b8a2e43-2a6e-4d7b-9f3c-5d1e7a9c4b21",
  cardToken: "ZyXwVuTsRqPoNmLkJiHgFe",
  risk: "destructive",
  url: "https://apiunicon.ru/confirm/change/0b8a2e43-2a6e-4d7b-9f3c-5d1e7a9c4b21?t=other-token",
  heading: "Удалить данные в «Shop»?",
  lede: "Удаление подтверждается только на странице: она спросит дважды.",
  values: [],
  labels: { ...WRITE.labels, run: null },
};

const ANSWER: CardAnswer = {
  result: "decided",
  changeStatus: "succeeded",
  title: "Готово",
  text: "Сервис ответил: 200.",
  note: "Напишите ассистенту, что нажали кнопку: он проверит итог.",
};

const FALLBACK_RU = "Подтвердите изменение на странице по ссылке из ответа ассистента.";
const NONE_RU = "Подробности — в ответе ассистента.";

// The members a real DOM has that the view may use; anything else it touches fails the test.
const ELEMENT_READS = new Set(["append", "replaceChildren", "addEventListener", "textContent", "className", "disabled"]);
const ELEMENT_WRITES = new Set(["textContent", "className", "disabled"]);

class FakeElement {
  children: FakeElement[] = [];
  className = "";
  disabled = false;
  readonly listeners: Array<[string, (event: unknown) => void]> = [];
  private ownText = "";

  constructor(readonly tagName: string) {}

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: unknown) {
    this.ownText = value === null || value === undefined ? "" : String(value);
    this.children = [];
  }

  append(...nodes: unknown[]): void {
    for (const node of nodes) {
      if (typeof node === "string") {
        const text = new FakeElement("#text");
        text.textContent = node;
        this.children.push(text);
      } else {
        const element = RAW.get(node as object);
        if (!element) throw new Error("append got something that is not an element of this document");
        this.children.push(element);
      }
    }
  }

  replaceChildren(...nodes: unknown[]): void {
    this.ownText = "";
    this.children = [];
    this.append(...nodes);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.push([type, listener]);
  }

  click(): void {
    for (const [type, listener] of this.listeners) if (type === "click") listener({});
  }
}

const RAW = new WeakMap<object, FakeElement>();

// The element as the view sees it: only the members it may use.
function guarded(element: FakeElement): object {
  const proxy = new Proxy(element, {
    get(target, key) {
      // Promise resolution looks for then on whatever a callback returns.
      if (key === "then") return undefined;
      if (typeof key !== "string" || !ELEMENT_READS.has(key)) throw new Error(`The view used element.${String(key)}`);
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, key, value) {
      if (typeof key !== "string" || !ELEMENT_WRITES.has(key)) throw new Error(`The view set element.${String(key)}`);
      return Reflect.set(target, key, value, target);
    },
  });
  RAW.set(proxy, element);
  return proxy;
}

function strict<T extends object>(name: string, value: T, allowed: readonly string[]): T {
  return new Proxy(value, {
    get(target, key) {
      if (key === "then") return undefined;
      if (typeof key !== "string" || !allowed.includes(key)) throw new Error(`The view used ${name}.${String(key)}`);
      return Reflect.get(target, key, target);
    },
    set(target, key, value) {
      if (typeof key !== "string" || !allowed.includes(key)) throw new Error(`The view set ${name}.${String(key)}`);
      return Reflect.set(target, key, value, target);
    },
  });
}

type CallParams = { name: string; arguments: Record<string, unknown> };

type ViewOptions = {
  locale?: string;
  openai?: unknown;
  call?: (params: CallParams) => Promise<unknown>;
  // How the host answers openLink and connect; by default it opens the link and connects.
  open?: (params: { url: string }) => Promise<{ isError?: boolean }>;
  connect?: () => Promise<void>;
};

function view(options: ViewOptions = {}) {
  const root = new FakeElement("main");
  const created: FakeElement[] = [];
  const documentElement = strict("document.documentElement", { lang: "" }, ["lang"]);
  const document = strict("document", {
    documentElement,
    getElementById: (id: string) => (id === "card" ? guarded(root) : null),
    createElement: (tag: string) => {
      const element = new FakeElement(tag);
      created.push(element);
      return guarded(element);
    },
  }, ["documentElement", "getElementById", "createElement"]);
  const windowListeners: Array<[string, () => void]> = [];
  const window = strict("window", {
    openai: options.openai,
    addEventListener: (type: string, listener: () => void) => {
      windowListeners.push([type, listener]);
    },
  }, ["openai", "addEventListener"]);
  const calls: CallParams[] = [];
  const links: Array<{ url: string }> = [];
  const order: string[] = [];
  let app: StubApp | undefined;

  class StubApp {
    ontoolresult: ((params: unknown) => void) | undefined;

    constructor(readonly info: unknown) {
      app = this;
    }

    connect(): Promise<void> {
      order.push(`connect: handler ${typeof this.ontoolresult}, window listeners ${windowListeners.length}`);
      return options.connect ? options.connect() : Promise.resolve();
    }

    getHostContext(): { locale?: string } {
      return options.locale === undefined ? {} : { locale: options.locale };
    }

    callServerTool(params: CallParams): Promise<unknown> {
      calls.push(params);
      return options.call ? options.call(params) : Promise.resolve({ structuredContent: { result: ANSWER } });
    }

    openLink(params: { url: string }): Promise<{ isError?: boolean }> {
      links.push(params);
      return options.open ? options.open(params) : Promise.resolve({});
    }
  }

  runInNewContext(CARD_VIEW_SCRIPT, { App: StubApp, document, window, JSON });
  if (!app) throw new Error("The view made no App");
  const made = app;
  const settle = async () => {
    for (let round = 0; round < 5; round += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    app: made,
    root,
    created,
    calls,
    links,
    order,
    lang: () => (documentElement as { lang: string }).lang,
    settle,
    // A tool result as the host sends it, after the view connected.
    async result(params: unknown): Promise<void> {
      await settle();
      made.ontoolresult?.(params);
      await settle();
    },
    async setGlobals(): Promise<void> {
      for (const [type, listener] of windowListeners) if (type === "openai:set_globals") listener();
      await settle();
    },
  };
}

function all(element: FakeElement): FakeElement[] {
  return element.children.flatMap((child) => [child, ...all(child)]);
}

const buttons = (root: FakeElement) => all(root).filter((element) => element.tagName === "button");
const labels = (root: FakeElement) => buttons(root).map((button) => button.textContent);
const tags = (root: FakeElement) => all(root).map((element) => element.tagName).filter((tag) => tag !== "#text");
const button = (root: FakeElement, label: string) => {
  const found = buttons(root).find((element) => element.textContent === label);
  if (!found) throw new Error(`No button ${label}: ${labels(root).join(", ")}`);
  return found;
};
const withCard = (card: ChangeCardData) => ({
  content: [{ type: "text", text: JSON.stringify({ status: "pending" }) }],
  _meta: { apiunicon: { card } },
});

describe("the change card's page", () => {
  it("builds the card with the ext-apps bridge inlined and nothing loaded from elsewhere", () => {
    const html = changeCardHtml();

    expect(html.startsWith("<!doctype html>")).toBe(true);
    // The bridge itself: its handshake method and the App class taken out of the bundle.
    expect(html).toContain("ui/initialize");
    expect(html).toContain("const App = (() => {");
    expect(html).not.toMatch(/<script[^>]*\ssrc\s*=/iu);
    expect(html).not.toMatch(/src\s*=\s*["']?https?:/iu);
    expect(html).not.toMatch(/<link[^>]*href/iu);
    for (const markup of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) expect(html).not.toContain(markup);
    // The bundle defines these methods; the card never calls them, so the host has no way to press its button for the
    // model, and the model is told nothing by the card.
    for (const call of ["registerTool(", "sendMessage(", "updateModelContext("]) {
      expect(CARD_VIEW_SCRIPT).not.toContain(call);
      expect(html).not.toContain(`app.${call}`);
    }
    expect(html).toContain('new App({ name: "APIUniCon change card", version: "1.0.0" })');
    expect(html).toContain('callServerTool({ name: "confirm_change"');
    // The handlers are set before connect(), or the first result could arrive before them.
    const script = html.slice(html.indexOf(CARD_VIEW_SCRIPT));
    expect(script.indexOf("app.ontoolresult =")).toBeGreaterThan(-1);
    expect(script.indexOf("app.ontoolresult =")).toBeLessThan(script.indexOf("app.connect()"));
    expect(script.indexOf('window.addEventListener("openai:set_globals"')).toBeLessThan(script.indexOf("app.connect()"));
    // The one script is whole: it parses.
    const scripts = html.match(/<script type="module">([\s\S]*?)<\/script>/gu) ?? [];
    expect(scripts).toHaveLength(1);
    expect(() => new Script(scripts[0]!.slice('<script type="module">'.length, -"</script>".length))).not.toThrow();
    expect(html.match(/<script/giu)).toHaveLength(1);
    expect(html).not.toContain("<!--");
    expect(html).toContain(`<style>${CARD_STYLE}</style>`);
    expect(html).toContain('<main id="card">');
    // The card's own policy, before the style and the script it governs: nothing is loaded or fetched.
    expect(CARD_CSP).toBe("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'");
    const policy = `<meta http-equiv="Content-Security-Policy" content="${CARD_CSP}">`;
    expect(html).toContain(policy);
    expect(html.indexOf(policy)).toBeLessThan(html.indexOf("<style>"));
    expect(html.indexOf(policy)).toBeLessThan(html.indexOf("<script"));
    // Built once and kept.
    expect(changeCardHtml()).toBe(html);
  });

  it("inlines the bridge of ext-apps 1.7.5 exactly", () => {
    const bundle = createRequire(import.meta.url).resolve("@modelcontextprotocol/ext-apps/app-with-deps");
    const installed = JSON.parse(readFileSync(new URL("../../package.json", pathToFileURL(bundle)), "utf8")) as Record<string, unknown>;
    expect(installed).toMatchObject({ name: "@modelcontextprotocol/ext-apps", version: "1.7.5" });
    const own = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
    expect(own.dependencies["@modelcontextprotocol/ext-apps"]).toBe("1.7.5");
  });

  it("is dark, with the teal button, and loads nothing for its style", () => {
    for (const rule of [
      "color-scheme: dark", "#05070f", "#e9edf7", "system-ui", "#00d6b4", "border-radius: 12px", "font-weight: 600",
      "rgba(233,237,247,.3)",
    ]) {
      expect(CARD_STYLE).toContain(rule);
    }
    expect(CARD_STYLE).not.toMatch(/url\(|@import/u);
  });

  it("refuses an ext-apps bundle of another shape", () => {
    expect(() => buildCardHtml("const a = 1;")).toThrow("the ext-apps bundle does not have the expected shape");
    expect(() => buildCardHtml("class B {}\nexport { B as Bridge };")).toThrow("the ext-apps bundle does not have the expected shape");
    expect(() => buildCardHtml('class A {}\nconst s = "</script>";\nexport { A as App };')).toThrow(
      "the ext-apps bundle does not have the expected shape",
    );
    expect(() => buildCardHtml('class A {}\nconst s = "<!--";\nexport { A as App };')).toThrow(
      "the ext-apps bundle does not have the expected shape",
    );
    const built = buildCardHtml("class A {}\nexport { A as App, A as Other };");
    expect(built).toContain("const App = (() => {\nclass A {}\n\nreturn A;\n})();");
  });

  it("serves the card resource with an empty CSP and a border", async () => {
    const server = new McpServer({ name: "card-test", version: "1.0.0" });
    registerChangeCard(server);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "card-test", version: "1.0.0" });
    await client.connect(clientSide);
    try {
      const read = await client.readResource({ uri: CHANGE_CARD_URI });
      expect(read.contents).toHaveLength(1);
      const [content] = read.contents;
      expect(content).toMatchObject({ uri: CHANGE_CARD_URI, mimeType: "text/html;profile=mcp-app" });
      expect(content?._meta).toEqual({ ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } });
      expect(content && "text" in content ? content.text : null).toBe(changeCardHtml());
      const listed = await client.listResources();
      expect(listed.resources.map(({ uri, name }) => [uri, name])).toEqual([[CHANGE_CARD_URI, "APIUniCon change confirmation"]]);
    } finally {
      await client.close();
    }
  });
});

describe("the change card's view", () => {
  it("renders a write from _meta and calls confirm_change with its token on Run", async () => {
    const card = view({ locale: "en-US" });
    expect(card.order).toEqual(["connect: handler function, window listeners 1"]);
    expect(card.app.info).toEqual({ name: "APIUniCon change card", version: "1.0.0" });

    await card.result(withCard(WRITE));

    expect(card.lang()).toBe("ru");
    const text = card.root.textContent;
    for (const shown of [
      WRITE.heading, WRITE.lede, ...WRITE.facts.flatMap(({ label, value }) => [label, value]), WRITE.valuesTitle, "Цена, ₽", "price",
      "349", WRITE.values[1]!.value, WRITE.assistant, WRITE.assistantNote, ...WRITE.warnings, WRITE.expires,
    ]) {
      expect(text).toContain(shown);
    }
    expect(text).not.toContain(WRITE.cardToken);
    expect(text).not.toContain(WRITE.noValues);
    expect(tags(card.root)).toEqual(expect.arrayContaining(["h1", "h2", "dl", "dt", "dd", "code", "pre", "blockquote"]));
    // A value whose label is its name is named once.
    const terms = all(card.root).filter((element) => element.tagName === "dt").map((term) => term.textContent);
    expect(terms).toEqual(["Цена, ₽price", "card"]);
    expect(all(card.root).find((element) => element.tagName === "pre")?.textContent).toBe(WRITE.values[1]!.value);
    expect(all(card.root).filter((element) => element.className === "warning").map((element) => element.textContent)).toEqual(WRITE.warnings);
    expect(labels(card.root)).toEqual([WRITE.labels.run, WRITE.labels.cancel]);

    button(card.root, "Выполнить").click();
    expect(card.calls).toEqual([{
      name: "confirm_change",
      arguments: { changeId: WRITE.changeId, cardToken: WRITE.cardToken, decision: "run", step: 0 },
    }]);
    expect(buttons(card.root).map((element) => element.disabled)).toEqual([true, true]);
    expect(card.root.textContent).toContain(WRITE.labels.pressing);
    // A second press while the first is on its way sends nothing.
    button(card.root, "Отмена").click();
    expect(card.calls).toHaveLength(1);

    await card.settle();
    const after = card.root.textContent;
    for (const shown of [ANSWER.title, ANSWER.text, ANSWER.note!]) expect(after).toContain(shown);
    expect(after).toContain(WRITE.heading);
    expect(after).not.toContain(WRITE.labels.pressing);
    expect(buttons(card.root)).toEqual([]);

    // The host gives the old result again: the card keeps the outcome and offers nothing to press.
    await card.result(withCard(WRITE));
    await card.setGlobals();
    expect(card.root.textContent).toContain(ANSWER.title);
    expect(buttons(card.root)).toEqual([]);
    expect(card.calls).toHaveLength(1);
  });

  it("reads the answer from the text when the host leaves out structuredContent", async () => {
    const card = view({ call: async () => ({ content: [{ type: "text", text: JSON.stringify(ANSWER) }] }) });
    await card.result(withCard(WRITE));

    button(card.root, "Выполнить").click();
    await card.settle();

    expect(card.root.textContent).toContain(ANSWER.text);
    expect(buttons(card.root)).toEqual([]);
  });

  it("reads the card from window.openai when _meta does not come", async () => {
    const card = view({ openai: { toolResponseMetadata: { apiunicon: { card: WRITE } } } });

    await card.result({ content: [{ type: "text", text: JSON.stringify({ status: "pending" }) }] });

    expect(card.root.textContent).toContain(WRITE.heading);
    expect(labels(card.root)).toEqual([WRITE.labels.run, WRITE.labels.cancel]);
  });

  it("draws the card from window.openai as soon as it connects, and once the globals arrive", async () => {
    const early = view({ openai: { toolResponseMetadata: { apiunicon: { card: WRITE } } } });
    await early.settle();
    expect(early.root.textContent).toContain(WRITE.heading);

    const openai: { toolResponseMetadata?: unknown } = {};
    const late = view({ openai });
    await late.settle();
    expect(late.root.children).toEqual([]);
    openai.toolResponseMetadata = { apiunicon: { card: WRITE } };
    await late.setGlobals();
    expect(late.root.textContent).toContain(WRITE.heading);
    // The globals again, mid-press: the card is not drawn anew, so its buttons stay pressed.
    button(late.root, "Выполнить").click();
    await late.setGlobals();
    expect(late.calls).toHaveLength(1);
    expect(late.root.textContent).toContain(ANSWER.title);
    expect(buttons(late.root)).toEqual([]);
  });

  it("offers only the page for a deletion", async () => {
    const card = view();
    await card.result(withCard(DELETE));

    expect(labels(card.root)).toEqual([DELETE.labels.openPage, DELETE.labels.cancel]);
    expect(card.root.textContent).toContain(DELETE.lede);
    expect(card.root.textContent).toContain(DELETE.noValues);

    button(card.root, DELETE.labels.openPage).click();
    expect(card.links).toEqual([{ url: DELETE.url }]);
    expect(card.calls).toEqual([]);

    button(card.root, DELETE.labels.cancel).click();
    expect(card.calls).toEqual([{
      name: "confirm_change",
      arguments: { changeId: DELETE.changeId, cardToken: DELETE.cardToken, decision: "cancel", step: 0 },
    }]);
  });

  it("offers the page again when a press is sent there", async () => {
    const pageOnly: CardAnswer = {
      result: "page_only", changeStatus: "pending", title: "Не выполнено", text: "Первое подтверждение — на странице.", note: null,
    };
    const card = view({ call: async () => ({ structuredContent: { result: pageOnly } }) });
    await card.result(withCard(WRITE));

    button(card.root, "Выполнить").click();
    await card.settle();

    expect(card.root.textContent).toContain(pageOnly.text);
    expect(labels(card.root)).toEqual([WRITE.labels.openPage]);
    button(card.root, WRITE.labels.openPage).click();
    expect(card.links).toEqual([{ url: WRITE.url }]);
  });

  it("keeps the line under the page button when the host does not open the page", async () => {
    const pageOnly: CardAnswer = {
      result: "page_only", changeStatus: "pending", title: "Не выполнено", text: "Удаление — только на странице.", note: null,
    };
    for (const open of [async () => ({ isError: true }), () => Promise.reject(new Error("blocked"))]) {
      const card = view({ call: async () => ({ structuredContent: { result: pageOnly } }), open });
      await card.result(withCard(WRITE));
      button(card.root, "Выполнить").click();
      await card.settle();
      expect(card.root.textContent).not.toContain(WRITE.labels.pressing);

      button(card.root, WRITE.labels.openPage).click();
      await card.settle();

      expect(card.links).toEqual([{ url: WRITE.url }]);
      expect(card.root.textContent).toContain(pageOnly.text);
      expect(card.root.textContent).toContain(FALLBACK_RU);
    }
  });

  it("says where the details are when the bridge cannot connect", async () => {
    const refused = () => Promise.reject(new Error("no host"));
    const card = view({ locale: "ru-RU", connect: refused });
    await card.settle();
    expect(card.lang()).toBe("ru");
    expect(card.root.textContent).toBe(NONE_RU);
    expect(buttons(card.root)).toEqual([]);

    // ChatGPT's globals still bring the card, then or later.
    const early = view({ connect: refused, openai: { toolResponseMetadata: { apiunicon: { card: WRITE } } } });
    await early.settle();
    expect(early.root.textContent).toContain(WRITE.heading);
    const openai: { toolResponseMetadata?: unknown } = {};
    const late = view({ connect: refused, openai });
    await late.settle();
    expect(late.root.textContent).toBe("See your assistant's answer.");
    openai.toolResponseMetadata = { apiunicon: { card: WRITE } };
    await late.setGlobals();
    expect(late.root.textContent).toContain(WRITE.heading);
    expect(labels(late.root)).toEqual([WRITE.labels.run, WRITE.labels.cancel]);
  });

  it("falls back to the link from the assistant's text when the card data is missing", async () => {
    const url = "https://apiunicon.ru/confirm/change/x?t=y";
    const card = view({ locale: "ru-RU" });

    await card.result({ content: [{ type: "text", text: JSON.stringify({ status: "pending", confirmation: { url } }) }] });

    expect(card.lang()).toBe("ru");
    expect(card.root.textContent).toContain(FALLBACK_RU);
    expect(labels(card.root)).toEqual(["Открыть страницу подтверждения"]);
    button(card.root, "Открыть страницу подтверждения").click();
    expect(card.links).toEqual([{ url }]);
    expect(card.calls).toEqual([]);

    const english = view({ locale: "en-GB" });
    await english.result({ content: [{ type: "text", text: JSON.stringify({ status: "pending", confirmation: { url } }) }] });
    expect(english.root.textContent).toContain("Confirm the change on the page from your assistant's answer.");
    expect(labels(english.root)).toEqual(["Open the confirmation page"]);

    const script = view({ locale: "ru" });
    await script.result({
      content: [{ type: "text", text: JSON.stringify({ status: "pending", confirmation: { url: "javascript:alert(1)" } }) }],
    });
    expect(buttons(script.root)).toEqual([]);
    expect(script.root.textContent).toBe(NONE_RU);
  });

  it("shows an outcome without buttons, and a refused or failed request without buttons", async () => {
    const outcome: ChangeCardData = {
      kind: "outcome", locale: "en", changeId: null, title: "Not done", text: "Changing data is turned off for this connection.", note: null,
    };
    const card = view();
    await card.result(withCard(outcome));
    expect(card.lang()).toBe("en");
    expect(card.root.textContent).toBe(`${outcome.title}${outcome.text}`);
    expect(buttons(card.root)).toEqual([]);

    const ran = view();
    await ran.result(withCard({ ...outcome, title: "Done", text: "The service answered 200.", note: "It ran at once." }));
    expect(ran.root.textContent).toBe("DoneThe service answered 200.It ran at once.");

    const failed = view({ locale: "ru" });
    await failed.result({ isError: true, content: [{ type: "text", text: "boom" }] });
    expect(failed.root.textContent).toBe(NONE_RU);
    expect(buttons(failed.root)).toEqual([]);

    // Data of another shape is no card.
    const strange = view({ locale: "ru" });
    await strange.result({ content: [{ type: "text", text: "{}" }], _meta: { apiunicon: { card: { kind: "unknown", heading: "x" } } } });
    expect(strange.root.textContent).toBe(NONE_RU);
  });

  it("says the press did not get through and offers the page", async () => {
    for (const call of [
      () => Promise.reject(new Error("host refused")),
      async () => ({ isError: true, content: [{ type: "text", text: "Error" }] }),
      async () => ({ structuredContent: { result: { something: "else" } } }),
    ]) {
      const card = view({ call });
      await card.result(withCard(WRITE));

      button(card.root, "Выполнить").click();
      await card.settle();

      expect(card.root.textContent).toContain(WRITE.labels.callFailed);
      expect(labels(card.root)).toEqual([WRITE.labels.openPage]);
      button(card.root, WRITE.labels.openPage).click();
      expect(card.links).toEqual([{ url: WRITE.url }]);
      expect(card.calls).toHaveLength(1);
    }
  });

  it("shows markup from the data as text", async () => {
    const markup = "<img src=x onerror=alert(1)>";
    const card = view();
    await card.result(withCard({
      ...WRITE,
      heading: markup,
      values: [{ label: markup, name: "<b>", value: "<script>alert(1)</script>", block: false }],
    }));

    const heading = all(card.root).find((element) => element.tagName === "h1");
    expect(heading?.textContent).toBe(markup);
    expect(card.root.textContent).toContain("<script>alert(1)</script>");
    expect(card.created.map(({ tagName }) => tagName)).not.toContain("img");
    expect(card.created.map(({ tagName }) => tagName)).not.toContain("script");
    expect(card.created.map(({ tagName }) => tagName)).not.toContain("b");
  });

  it("opens only a link of the web for the page", async () => {
    const card = view();
    await card.result(withCard({ ...DELETE, url: "javascript:alert(1)" }));

    button(card.root, DELETE.labels.openPage).click();

    expect(card.links).toEqual([]);
  });
});

const SERVER_CONFIG: AppConfig = {
  stateDir: ".", binDir: ".", dbPath: ":memory:", masterKey: Buffer.alloc(32, 59),
  httpHost: "127.0.0.1", httpPort: 3210, maxResponseBytes: 32_768,
  requestTimeoutMs: 1_000, maxCrawlPages: 5,
};

const SHOP_DSL: AdapterDsl = {
  schemaVersion: 1,
  baseOrigins: ["https://api.shop.test"],
  credentialBindings: [{ fieldName: "Authorization", target: "header", headerName: "Authorization" }],
  operations: [
    {
      id: "set_price",
      description: "Set the price of a card",
      risk: "write",
      method: "POST",
      path: "/prices",
      input: { price: { type: "integer", location: "body", required: true, description: "Price" } },
      documentationRefs: [],
    },
    {
      id: "delete_card",
      description: "Delete a card",
      risk: "destructive",
      method: "DELETE",
      path: "/cards/{nmId}",
      input: { nmId: { type: "integer", location: "path", required: true } },
      documentationRefs: [],
    },
  ],
};

// The view with the server's real answers: what request_change gives the host, and what confirm_change answers a press.
describe("the change card's view with the server's own answers", () => {
  let application: Application;
  let client: Client;
  let connectionId: string;
  let sent: string[];

  beforeEach(async () => {
    sent = [];
    application = buildApplication(SERVER_CONFIG, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async (input, init) => {
        sent.push(`${init?.method ?? "GET"} ${input.toString()}`);
        return new Response(JSON.stringify({ updated: true }), { status: 200 });
      },
    });
    const source = application.connections.createDocumentationSource({
      rootUrl: "https://docs.shop.test/api", allowedOrigin: "https://docs.shop.test",
    });
    application.vault.storeFields("credentials-1", { Authorization: "shop-secret-1" });
    const draft = application.adapters.create({ slug: "shop", displayName: "Shop", documentationSourceId: source.id, dsl: SHOP_DSL });
    const adapter = application.adapters.markWorking(draft.id, draft.version);
    connectionId = application.connections.createConnection({
      label: "Shop", documentationSourceId: source.id, allowedOrigins: ["https://api.shop.test"],
      credentialSetId: "credentials-1", adapterId: adapter.id,
    }).id;
    application.changes.setWrites(connectionId, true);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer(application.mcpDependencies, { cards: true }).connect(serverSide);
    client = new Client({ name: "card-view-test", version: "1.0.0" });
    await client.connect(clientSide);
  });

  afterEach(async () => {
    await client.close();
    application.db.close();
  });

  const requestChange = async (operationId: string, args: Record<string, unknown>) => client.callTool({
    name: "request_change", arguments: { connectionId, operationId, args, summary: "Asked for in the chat" },
  }) as Promise<CallToolResult>;

  // The host passes a press to the server and its answer back, as it is, or keeping only its text.
  function hosted(keep: (answer: CallToolResult) => unknown = (answer) => answer) {
    const pending: Array<Promise<unknown>> = [];
    const card = view({
      locale: "en-US",
      call: (params) => {
        const answer = (client.callTool(params) as Promise<CallToolResult>).then(keep);
        pending.push(answer);
        return answer;
      },
    });
    return { card, answered: async () => {
      await Promise.all(pending);
      await card.settle();
    } };
  }

  it("draws the card from request_change and shows what confirm_change answers", async () => {
    for (const keep of [(answer: CallToolResult) => answer, ({ content }: CallToolResult) => ({ content })]) {
      const { card, answered } = hosted(keep);
      await card.result(await requestChange("set_price", { price: sent.length + 349 }));
      expect(card.lang()).toBe("en");
      expect(card.root.textContent).toContain("Change data in “Shop”?");

      button(card.root, "Run").click();
      await answered();

      expect(card.calls).toHaveLength(1);
      const shown = card.root.textContent;
      for (const words of ["Done", "The service answered 200.", "Tell your assistant you pressed the button: it will check the result."]) {
        expect(shown).toContain(words);
      }
      expect(shown).not.toContain("The button did not get through");
      expect(buttons(card.root)).toEqual([]);
    }
    expect(sent).toHaveLength(2);
  });

  it("offers only the page for a deletion and shows why after a cancel, from the server's answers", async () => {
    const requested = await requestChange("delete_card", { nmId: 7 });
    const { card, answered } = hosted();
    await card.result(requested);
    expect(labels(card.root)).toEqual(["Open the confirmation page", "Cancel"]);

    button(card.root, "Cancel").click();
    await answered();

    expect(card.root.textContent).toContain("Cancelled");
    expect(card.root.textContent).not.toContain("The button did not get through");

    // The same card drawn again, as after a reload: its press runs nothing and tells how the change ended.
    const again = hosted();
    await again.card.result(requested);
    button(again.card.root, "Cancel").click();
    await again.answered();
    expect(again.card.root.textContent).toContain("Cancelled");
    expect(sent).toEqual([]);
  });
});
