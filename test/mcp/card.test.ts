import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AdapterDsl } from "../../src/adapters/schema.js";
import { describeArguments } from "../../src/changes/describe.js";
import type { WriteRefusal } from "../../src/changes/policy.js";
import { localWritePolicy } from "../../src/changes/policy.js";
import type { ChangeRecord } from "../../src/changes/repository.js";
import type { RequestChangeAnswer } from "../../src/changes/service.js";
import type { AppConfig } from "../../src/config.js";
import { translate } from "../../src/i18n/messages.js";
import { buildApplication, type Application } from "../../src/index.js";
import { CHANGE_CARD_URI, cardAnswer, cardData, changeRequestResult } from "../../src/mcp/card.js";

const config: AppConfig = {
  stateDir: ".", binDir: ".", dbPath: ":memory:", masterKey: Buffer.alloc(32, 47),
  httpHost: "127.0.0.1", httpPort: 3210, maxResponseBytes: 32_768,
  requestTimeoutMs: 1_000, maxCrawlPages: 5,
};

const ORIGIN = "https://api.shop.test";

const dsl: AdapterDsl = {
  schemaVersion: 1,
  baseOrigins: [ORIGIN],
  credentialBindings: [{ fieldName: "Authorization", target: "header", headerName: "Authorization" }],
  operations: [
    {
      id: "set_price",
      description: "Set the price of a card",
      risk: "write",
      method: "POST",
      path: "/prices",
      input: {
        nmId: { type: "integer", location: "body", required: true, description: "Артикул" },
        price: { type: "integer", location: "body", required: true, description: "Цена, ₽" },
      },
      documentationRefs: [],
    },
    {
      id: "delete_card",
      description: "Delete a card",
      risk: "write",
      method: "DELETE",
      path: "/cards/{nmId}",
      input: { nmId: { type: "integer", location: "path", required: true } },
      documentationRefs: [],
    },
  ],
};

const SUMMARY = "Поставить цену 349 ₽ на артикул 123456789";

describe("chat card data", () => {
  let application: Application;
  let answer: () => Promise<Response>;
  let planRefusal: WriteRefusal | null;
  let sourceId: string;
  let adapterId: string;
  let connectionId: string;
  let credentials = 0;

  function connect(label: string): string {
    credentials += 1;
    application.vault.storeFields(`credentials-${credentials}`, { Authorization: "shop-secret-1" });
    const id = application.connections.createConnection({
      label, documentationSourceId: sourceId, allowedOrigins: [ORIGIN], credentialSetId: `credentials-${credentials}`, adapterId,
    }).id;
    application.changes.setWrites(id, true);
    return id;
  }

  function ask(
    operationId: string,
    args: Record<string, unknown>,
    options: { connectionId?: string; summary?: string } = {},
  ): Promise<RequestChangeAnswer> {
    return application.changes.requestWithCard({
      connectionId: options.connectionId ?? connectionId,
      operationId,
      args,
      summary: options.summary ?? SUMMARY,
      baseUrl: application.keyEntryBaseUrl,
      requestedVia: null,
    });
  }

  async function waiting(operationId = "set_price", args: Record<string, unknown> = { nmId: 123456789, price: 349 }) {
    const asked = await ask(operationId, args);
    if (asked.result.status !== "pending" || asked.card.kind !== "confirm") throw new Error("Expected a pending change");
    const token = new URL(asked.result.confirmation.url).searchParams.get("t") ?? "";
    return { asked, changeId: asked.result.changeId, cardToken: asked.card.cardToken, token };
  }

  const press = (change: { changeId: string; cardToken: string }, decision: "run" | "cancel" = "run") =>
    application.changes.confirmFromCard(change.changeId, change.cardToken, decision, 0);

  // The person confirms the operation once on its page, as the page does, so later ones may run at once.
  async function confirmOnPage(): Promise<void> {
    const change = await waiting();
    const decided = await application.changes.decide(change.changeId, change.token, "run", 0);
    if (decided?.kind !== "decided" || decided.record.status !== "succeeded") throw new Error("The page confirmation failed");
  }

  beforeEach(() => {
    answer = async () => new Response(JSON.stringify({ updated: true }), { status: 200 });
    planRefusal = null;
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async () => answer(),
      writes: { check: async () => planRefusal, settingsUrl: localWritePolicy.settingsUrl },
    });
    sourceId = application.connections.createDocumentationSource({
      rootUrl: "https://docs.shop.test/api", allowedOrigin: "https://docs.shop.test",
    }).id;
    const draft = application.adapters.create({ slug: "shop", displayName: "Shop", documentationSourceId: sourceId, dsl });
    adapterId = application.adapters.markWorking(draft.id, draft.version).id;
    connectionId = connect("Shop");
  });

  afterEach(() => {
    application.db.close();
  });

  it("names the card resource", () => {
    expect(CHANGE_CARD_URI).toBe("ui://apiunicon/change-card-v1");
  });

  it("describes a pending write as the page does, in the server's language", async () => {
    const { asked } = await waiting();
    if (asked.result.status !== "pending" || asked.card.kind !== "confirm") throw new Error("Expected a pending change");
    const { record } = asked.card.state;

    const card = cardData(asked, "ru");

    if (card.kind !== "confirm") throw new Error("Expected a confirmation card");
    expect(card.heading).toBe("Изменить данные в «Shop»?");
    expect(card.lede).toBe(translate("ru", "change.lede", { host: "api.shop.test" }));
    expect(card.facts).toEqual([
      { label: "Действие (так его описывает адаптер)", value: "Set the price of a card" },
      { label: "Куда", value: "POST https://api.shop.test/prices" },
    ]);
    expect(card.valuesTitle).toBe("Будет отправлено");
    expect(card.values).toEqual(describeArguments(record));
    expect(card.values.map(({ label, value }) => [label, value])).toEqual([["Артикул", "123456789"], ["Цена, ₽", "349"]]);
    expect(card.noValues).toBe(translate("ru", "change.noValues"));
    expect(card.assistant.startsWith("Ассистент пишет: «")).toBe(true);
    expect(card.assistant).toBe(`Ассистент пишет: «${SUMMARY}»`);
    expect(card.assistantNote).toBe(translate("ru", "change.assistantNote"));
    expect(card.expires).toBe("Кнопки действуют 15 минут с момента запроса ассистента.");
    expect(card.labels).toEqual({
      run: "Выполнить",
      cancel: "Отмена",
      openPage: "Открыть страницу подтверждения",
      pressing: "Выполняю…",
      callFailed: "Нажатие не дошло. Откройте страницу подтверждения.",
    });
    expect(card).toMatchObject({
      kind: "confirm",
      locale: "ru",
      changeId: asked.result.changeId,
      cardToken: asked.card.cardToken,
      step: 0,
      risk: "write",
      expiresAt: asked.result.confirmation.expiresAt,
      url: asked.result.confirmation.url,
    });
    // The page's first-time warning, as the page would show it: this action never ran before.
    expect(card.warnings).toEqual([translate("ru", "change.firstTime")]);
    // Only what the card shows: neither the change's record nor its stored args and operation as they are.
    expect(Object.keys(card).sort()).toEqual([
      "assistant", "assistantNote", "cardToken", "changeId", "expires", "expiresAt", "facts", "heading", "kind", "labels",
      "lede", "locale", "noValues", "risk", "step", "url", "values", "valuesTitle", "warnings",
    ].sort());
  });

  it("spells out invisible characters in the label and the summary", async () => {
    const hidden = connect("Shop‮");
    const asked = await ask("set_price", { nmId: 1, price: 2 }, { connectionId: hidden, summary: "Цена​ 2" });

    const card = cardData(asked, "ru");

    if (card.kind !== "confirm") throw new Error("Expected a confirmation card");
    expect(card.heading).toContain("\\u202e");
    expect(card.heading).not.toContain("‮");
    expect(card.assistant).toContain("Цена\\u200b 2");
  });

  it("offers only the page for a deletion", async () => {
    const asked = await ask("delete_card", { nmId: 1 });

    const card = cardData(asked, "ru");

    if (card.kind !== "confirm") throw new Error("Expected a confirmation card");
    expect(card.risk).toBe("destructive");
    expect(card.labels.run).toBeNull();
    expect(card.labels.openPage).toBe("Открыть страницу подтверждения");
    expect(card.lede).toBe(translate("ru", "card.deletion"));
    expect(card.lede).toBe("Удаление подтверждается только на странице: она спросит дважды.");
    expect(card.heading).toBe("Удалить данные в «Shop»?");
    expect(card.facts[1]?.value).toBe("DELETE https://api.shop.test/cards/1");
  });

  it("warns as the page does, and leaves to the page a write whose Run would let it run at once from then on", async () => {
    const first = cardData((await waiting()).asked, "ru");
    if (first.kind !== "confirm") throw new Error("Expected a confirmation card");
    expect(first.warnings).toEqual([translate("ru", "change.firstTime")]);

    application.changes.setConfirmChanges(connectionId, false);
    const standing = cardData((await waiting()).asked, "ru");
    if (standing.kind !== "confirm") throw new Error("Expected a confirmation card");
    expect(standing.warnings).toContain(translate("ru", "change.standing"));
    // The permission to run at once from then on is given on the page alone.
    expect(standing.labels.run).toBeNull();
    expect(standing.lede).toBe(
      "Первое подтверждение этого действия при выключенном подтверждении делается на странице: после него ассистент будет выполнять его сразу, с любыми значениями.",
    );
    expect(standing.risk).toBe("write");
  });

  it("tells the outcome when nothing waits", async () => {
    application.changes.setConfirmChanges(connectionId, false);
    await confirmOnPage();
    const ran = await ask("set_price", { nmId: 123456789, price: 349 });
    expect(ran.card.kind).toBe("ran");
    if (ran.card.kind !== "ran") return;

    expect(cardData(ran, "ru")).toEqual({
      kind: "outcome",
      locale: "ru",
      changeId: ran.card.record.id,
      title: "Готово",
      text: "Сервис ответил: 200.",
      note: translate("ru", "card.ranAtOnce"),
    });

    planRefusal = { reason: "plan", message: "No writes on this plan." };
    const refused = await ask("set_price", { nmId: 1, price: 2 });
    expect(cardData(refused, "ru")).toEqual({
      kind: "outcome", locale: "ru", changeId: null, title: "Не выполнено", text: translate("ru", "change.refused.plan"), note: null,
    });

    planRefusal = null;
    application.changes.setWrites(connectionId, false);
    const off = await ask("set_price", { nmId: 1, price: 2 });
    expect(cardData(off, "en")).toEqual({
      kind: "outcome", locale: "en", changeId: null, title: "Not done", text: translate("en", "change.refused.writes_off"), note: null,
    });
  });

  it("gives the assistant its answer even when the card's data cannot be built", async () => {
    // A write that already ran at once: if the card fails, the assistant must still see that it ran, not an error it
    // would retry.
    application.changes.setConfirmChanges(connectionId, false);
    await confirmOnPage();
    const ran = await ask("set_price", { nmId: 123456789, price: 349 });
    if (ran.result.status !== "succeeded" || ran.card.kind !== "ran") throw new Error("Expected a write that ran at once");
    const forced: RequestChangeAnswer = {
      result: ran.result,
      // A card that waits, with a result that does not: building it throws.
      card: { kind: "confirm", cardToken: "AbCdEfGhIjKlMnOpQrStUv", state: { record: ran.card.record, blocked: null, firstTime: false, grantsStanding: false } },
    };
    expect(() => cardData(forced, "en")).toThrow();

    const answered = changeRequestResult(forced, "en");

    expect(answered).toEqual({ content: [{ type: "text", text: JSON.stringify(ran.result) }] });
    expect(answered.isError).toBeUndefined();

    // A change that waits, whose record cannot be shown: the link stays, the card's token goes nowhere.
    application.changes.setConfirmChanges(connectionId, true);
    const { asked, cardToken } = await waiting("set_price", { nmId: 1, price: 2 });
    if (asked.card.kind !== "confirm") throw new Error("Expected a card");
    const broken: RequestChangeAnswer = {
      ...asked,
      card: { ...asked.card, state: { ...asked.card.state, record: { ...asked.card.state.record, targetUrl: "not a url" } } },
    };
    const linked = changeRequestResult(broken, "en");
    expect(linked).toEqual({ content: [{ type: "text", text: JSON.stringify(asked.result) }] });
    expect(JSON.stringify(linked)).not.toContain(cardToken);
    // And a card that builds is given with the answer.
    expect(changeRequestResult(asked, "en")._meta).toEqual({ apiunicon: { card: cardData(asked, "en") } });
  });

  it("answers the card in the server's language", async () => {
    const TELL = "Напишите ассистенту, что нажали кнопку: он проверит итог.";

    const done = await waiting();
    expect(cardAnswer(await press(done), "ru")).toEqual({
      result: "decided", changeStatus: "succeeded", title: "Готово", text: "Сервис ответил: 200.", note: TELL,
    });
    // The same card pressed again: the change already ended, so the card tells how, and nothing runs twice.
    expect(cardAnswer(await press(done), "ru")).toEqual({
      result: "rejected", changeStatus: "succeeded", title: "Готово", text: "Сервис ответил: 200.", note: TELL,
    });

    answer = async () => new Response(JSON.stringify({ error: "price too low" }), { status: 400 });
    expect(cardAnswer(await press(await waiting()), "ru")).toMatchObject({
      result: "decided", changeStatus: "failed", title: "Сервис ответил ошибкой",
      text: "Сервис ответил: 400. Скорее всего, ничего не изменилось.", note: TELL,
    });

    answer = async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    expect(cardAnswer(await press(await waiting()), "ru")).toMatchObject({
      result: "decided", changeStatus: "unknown", title: "Сервис не ответил",
    });

    answer = async () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    };
    expect(cardAnswer(await press(await waiting()), "ru")).toMatchObject({
      result: "decided", changeStatus: "failed", title: "Не выполнено", text: "Запрос не дошёл до сервиса, ничего не изменилось.",
    });

    expect(cardAnswer(await press(await waiting(), "cancel"), "ru")).toEqual({
      result: "decided", changeStatus: "cancelled", title: "Отменено", text: "Ничего не изменилось.", note: TELL,
    });

    const deletion = await waiting("delete_card", { nmId: 1 });
    expect(cardAnswer(await press(deletion), "ru")).toEqual({
      result: "page_only", changeStatus: "pending", title: "Не выполнено", text: translate("ru", "card.deletion"), note: null,
    });

    const invalid = { result: "rejected", title: "Карточка больше не действует", text: translate("ru", "card.invalid.text"), note: null };
    expect(cardAnswer({ kind: "rejected", record: null }, "ru")).toEqual({ ...invalid, changeStatus: null });
    const pendingOne = await waiting();
    const wrong = await application.changes.confirmFromCard(pendingOne.changeId, "A".repeat(22), "run", 0);
    expect(wrong).toMatchObject({ kind: "rejected", record: { status: "pending" } });
    expect(cardAnswer(wrong, "ru")).toEqual({ ...invalid, changeStatus: "pending" });
    const expired: ChangeRecord = { ...(application.changes.list({ connectionId, limit: 1 })[0] as ChangeRecord), status: "expired" };
    expect(cardAnswer({ kind: "rejected", record: expired }, "ru")).toEqual({ ...invalid, changeStatus: "expired" });
  });

  it("sends a write that would grant the standing permission to the page, in words of its own", async () => {
    application.changes.setConfirmChanges(connectionId, false);
    const change = await waiting();

    expect(cardAnswer(await press(change), "ru")).toEqual({
      result: "page_only",
      changeStatus: "pending",
      title: "Не выполнено",
      text: "Первое подтверждение этого действия при выключенном подтверждении делается на странице: после него ассистент будет выполнять его сразу, с любыми значениями.",
      note: null,
    });
    expect(cardAnswer(await press(change), "en").text).toBe(
      "With confirmation off, this action is confirmed the first time on the page: after that, your assistant will run it at once, with any values.",
    );
  });

  it("says why a change stopped after too many wrong presses", async () => {
    const change = await waiting();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await application.changes.confirmFromCard(change.changeId, "B".repeat(22), "run", 0);
    }

    expect(cardAnswer(await press(change), "ru")).toEqual({
      result: "rejected",
      changeStatus: "refused",
      title: "Не выполнено",
      text: translate("ru", "change.refused.card_attempts"),
      note: "Напишите ассистенту, что нажали кнопку: он проверит итог.",
    });
  });

  it("speaks English when the server does", async () => {
    const decided = await press(await waiting());

    expect(cardAnswer(decided, "en")).toEqual({
      result: "decided",
      changeStatus: "succeeded",
      title: "Done",
      text: "The service answered 200.",
      note: "Tell your assistant you pressed the button: it will check the result.",
    });
    const card = cardData((await waiting()).asked, "en");
    if (card.kind !== "confirm") throw new Error("Expected a confirmation card");
    expect(card.heading).toBe("Change data in “Shop”?");
    expect(card.labels.run).toBe("Run");
    expect(card.expires).toBe("The buttons work for 15 minutes from when your assistant asked.");
  });
});
