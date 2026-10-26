// The page of the chat card: one HTML document with the ext-apps bridge inlined, so it loads nothing from anywhere, and
// a small view that draws what request_change put in the result's _meta. Every text goes in with textContent: the
// server wrote the words, and what came from the assistant or an adapter is already spelled out by it.

// The view, run after the bridge (App). It declares no tools of its own and never talks to the model, so the host has
// no way to press its buttons for the model: only a click calls confirm_change. The handlers are set before connect(),
// or the first result could arrive before them. Its only DOM members are getElementById, createElement,
// documentElement.lang, append, replaceChildren, textContent, className, disabled and addEventListener.
export const CARD_VIEW_SCRIPT = String.raw`{
  // Only for a result that came without the card's data: the server's words are in the data, these are the view's own.
  const FALLBACK = {
    ru: {
      text: "Подтвердите изменение на странице по ссылке из ответа ассистента.",
      open: "Открыть страницу подтверждения",
      none: "Подробности — в ответе ассистента.",
    },
    en: {
      text: "Confirm the change on the page from your assistant's answer.",
      open: "Open the confirmation page",
      none: "See your assistant's answer.",
    },
  };
  const WEB_LINK = /^https?:\/\//u;
  const ANSWERS = ["decided", "page_only", "rejected"];
  const root = document.getElementById("card");
  const app = new App({ name: "APIUniCon change card", version: "1.0.0" });
  // The last tool result, what the card shows ("card" stays; "fallback" gives way to the card's data when it comes),
  // and whether a press got its answer: after that, nothing draws the card anew.
  let result = null;
  let drawn = null;
  let answered = false;

  const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
  const text = (value) => (typeof value === "string" ? value : "");
  const list = (value) => (Array.isArray(value) ? value : []);
  const make = (tag, className, words) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (words !== undefined) element.textContent = text(words);
    return element;
  };
  const firstText = (value) => {
    const block = isObject(value) ? list(value.content).find((part) => isObject(part) && part.type === "text") : undefined;
    return block && typeof block.text === "string" ? block.text : null;
  };
  const parsed = (words) => {
    if (words === null) return null;
    try {
      return JSON.parse(words);
    } catch (error) {
      return null;
    }
  };
  const cardIn = (meta) => {
    const card = isObject(meta) && isObject(meta.apiunicon) ? meta.apiunicon.card : null;
    return isObject(card) && (card.kind === "confirm" || card.kind === "outcome") ? card : null;
  };
  // The result's own _meta first; ChatGPT also keeps it in window.openai.toolResponseMetadata.
  const cardData = () => {
    const own = result === null ? null : cardIn(result._meta);
    if (own !== null) return own;
    const openai = isObject(window.openai) ? window.openai : null;
    return openai === null ? null : cardIn(openai.toolResponseMetadata);
  };
  const hostLocale = () => {
    let context;
    try {
      context = app.getHostContext();
    } catch (error) {
      context = undefined;
    }
    return isObject(context) && text(context.locale).toLowerCase().startsWith("ru") ? "ru" : "en";
  };
  const openLink = (url, onFailure) => {
    if (typeof url !== "string" || !WEB_LINK.test(url)) {
      onFailure();
      return;
    }
    app.openLink({ url }).then((answer) => {
      if (isObject(answer) && answer.isError) onFailure();
    }, onFailure);
  };
  // What confirm_change answered: its structuredContent, or the JSON of its text when a host keeps only that.
  const answerOf = (reply) => {
    if (!isObject(reply) || reply.isError) return null;
    const value = isObject(reply.structuredContent) && reply.structuredContent.result !== undefined
      ? reply.structuredContent.result
      : parsed(firstText(reply));
    const known = isObject(value) && ANSWERS.includes(value.result) && typeof value.title === "string"
      && typeof value.text === "string" && (value.note === null || value.note === undefined || typeof value.note === "string");
    return known ? value : null;
  };

  const drawOutcome = (card) => {
    const nodes = [make("h1", "", card.title), make("p", "", card.text)];
    if (typeof card.note === "string") nodes.push(make("p", "muted", card.note));
    root.replaceChildren(...nodes);
  };

  const drawConfirm = (card) => {
    const labels = isObject(card.labels) ? card.labels : {};
    const words = FALLBACK[card.locale === "ru" ? "ru" : "en"];
    const facts = make("div", "facts");
    for (const fact of list(card.facts)) {
      if (!isObject(fact)) continue;
      const row = make("div", "fact");
      row.append(make("span", "label", fact.label), make("code", "", fact.value));
      facts.append(row);
    }
    const nodes = [make("h1", "", card.heading), make("p", "lede", card.lede), facts, make("h2", "", card.valuesTitle)];
    const values = list(card.values).filter(isObject);
    if (values.length === 0) nodes.push(make("p", "muted", card.noValues));
    else {
      const terms = make("dl");
      for (const row of values) {
        const term = make("dt");
        if (text(row.label) !== text(row.name)) term.append(make("span", "label", row.label));
        term.append(make("code", "", row.name));
        const value = make("dd");
        value.append(row.block === true ? make("pre", "", row.value) : make("span", "", row.value));
        terms.append(term, value);
      }
      nodes.push(terms);
    }
    nodes.push(make("blockquote", "", card.assistant), make("p", "muted", card.assistantNote));
    for (const warning of list(card.warnings)) nodes.push(make("p", "warning", warning));
    nodes.push(make("p", "muted", card.expires));

    const footer = make("div", "footer");
    const actions = make("div", "actions");
    const status = make("p", "status");
    const buttons = [];
    let pressed = false;
    const button = (label, className, onClick) => {
      const element = make("button", className, label);
      element.addEventListener("click", onClick);
      buttons.push(element);
      return element;
    };
    // The link from the card's data, the one the assistant was given. When the host does not open it, the person
    // still has it in the assistant's answer.
    const openPage = () => openLink(card.url, () => {
      status.textContent = words.text;
    });
    const offerPage = () => {
      const open = make("button", "primary", labels.openPage);
      open.addEventListener("click", openPage);
      return open;
    };
    const failed = () => {
      status.textContent = text(labels.callFailed);
      actions.replaceChildren(offerPage());
    };
    const press = (decision) => {
      if (pressed) return;
      pressed = true;
      for (const element of buttons) element.disabled = true;
      status.textContent = text(labels.pressing);
      app.callServerTool({ name: "confirm_change", arguments: { changeId: card.changeId, cardToken: card.cardToken, decision, step: card.step } })
        .then((reply) => {
          const answer = answerOf(reply);
          if (answer === null) {
            failed();
            return;
          }
          answered = true;
          const shown = [make("h2", "", answer.title), make("p", "", answer.text)];
          if (typeof answer.note === "string") shown.push(make("p", "muted", answer.note));
          // A deletion, or a write the page alone may let through: the way there stays on the card, and so does the
          // line that says where the link is when the host does not open it.
          if (answer.result === "page_only") shown.push(offerPage());
          status.textContent = "";
          footer.replaceChildren(...shown, status);
        }, failed);
    };
    // A deletion, and a write whose "Run" would let it run at once from then on, are confirmed on the page alone.
    if (typeof labels.run === "string") actions.append(button(labels.run, "primary", () => press("run")));
    else actions.append(button(labels.openPage, "primary", openPage));
    actions.append(button(labels.cancel, "secondary", () => press("cancel")));
    footer.append(actions, status);
    nodes.push(footer);
    root.replaceChildren(...nodes);
  };

  // Without the card's data: the link the assistant was given, when the result is a change that waits for one.
  const drawFallback = () => {
    const locale = hostLocale();
    const words = FALLBACK[locale];
    document.documentElement.lang = locale;
    const value = result !== null && !result.isError ? parsed(firstText(result)) : null;
    const url = isObject(value) && value.status === "pending" && isObject(value.confirmation) ? value.confirmation.url : null;
    if (typeof url !== "string" || !WEB_LINK.test(url)) {
      root.replaceChildren(make("p", "muted", words.none));
      return;
    }
    const open = make("button", "primary", words.open);
    const note = make("p", "status");
    open.addEventListener("click", () => openLink(url, () => {
      note.textContent = words.none;
    }));
    root.replaceChildren(make("p", "", words.text), open, note);
  };

  const render = () => {
    if (answered || drawn === "card") return;
    const card = cardData();
    if (card !== null) {
      document.documentElement.lang = card.locale === "ru" ? "ru" : "en";
      if (card.kind === "confirm") drawConfirm(card);
      else drawOutcome(card);
      drawn = "card";
      return;
    }
    if (result === null) return;
    drawFallback();
    drawn = "fallback";
  };

  app.ontoolresult = (params) => {
    result = isObject(params) ? params : null;
    render();
  };
  window.addEventListener("openai:set_globals", () => render());
  // A bridge that could not connect gets no result: the card says where the details are rather than stay blank, and
  // still gives way to the card's data if ChatGPT's globals bring it.
  app.connect().then(() => render(), () => {
    render();
    if (drawn !== null) return;
    drawFallback();
    drawn = "fallback";
  });
}`;

// Dark, in APIUniCon's colors: the teal main button, a quiet outlined second one. Nothing is loaded: no fonts, no images.
export const CARD_STYLE = `:root { color-scheme: dark; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
html, body { background: #05070f; color: #e9edf7; }
body { margin: 0; padding: 16px; }
main { max-width: 640px; overflow-wrap: anywhere; }
h1 { font-size: 17px; line-height: 1.35; margin: 0 0 6px; }
h2 { font-size: 13px; font-weight: 600; margin: 16px 0 6px; color: rgba(233,237,247,.72); }
p { margin: 6px 0; }
.lede { color: rgba(233,237,247,.85); }
.facts { margin-top: 12px; border: 1px solid rgba(233,237,247,.12); border-radius: 12px; }
.fact { display: grid; grid-template-columns: minmax(0, 12em) minmax(0, 1fr); gap: 4px 12px; padding: 8px 12px; }
.fact + .fact { border-top: 1px solid rgba(233,237,247,.08); }
.label { color: rgba(233,237,247,.65); }
code, pre { font: 12.5px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; color: #e9edf7; }
dl { margin: 0; }
dt { margin-top: 8px; }
dt .label { margin-right: 6px; }
dd { margin: 2px 0 0; }
pre { white-space: pre-wrap; margin: 0; padding: 8px 10px; background: rgba(233,237,247,.06); border-radius: 8px; }
blockquote { margin: 14px 0 4px; padding: 8px 12px; border-left: 3px solid rgba(0,214,180,.6); background: rgba(233,237,247,.04); border-radius: 0 8px 8px 0; }
.muted { color: rgba(233,237,247,.6); font-size: 13px; }
.warning { color: #ffd27a; }
.footer { margin-top: 14px; }
.footer h2 { color: #e9edf7; font-size: 15px; margin-top: 4px; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
button { font: inherit; font-weight: 600; padding: 9px 18px; border-radius: 12px; cursor: pointer; }
button.primary { background: #00d6b4; color: #05070f; border: 1px solid #00d6b4; }
button.secondary { background: transparent; color: #e9edf7; border: 1px solid rgba(233,237,247,.3); }
button:disabled { opacity: .5; cursor: default; }
button:focus-visible { outline: 2px solid #00d6b4; outline-offset: 2px; }
.status { min-height: 1.5em; color: rgba(233,237,247,.75); font-size: 13px; }`;

// The card's own policy, on top of the host's: its inline script and style run, and nothing at all is loaded or
// fetched. The bridge talks to the host with postMessage, which no policy limits.
export const CARD_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'";

// The bundle ends in one export statement. It runs inside a function of its own, so none of its names meets the view's,
// and gives back its App class.
const BUNDLE_EXPORTS = /export\s*\{([^}]*)\}\s*;?\s*$/u;

export function buildCardHtml(bundle: string): string {
  const exports = BUNDLE_EXPORTS.exec(bundle);
  const app = exports?.[1]?.split(",")
    .map((pair) => pair.trim().split(/\s+as\s+/u))
    .find(([local, name]) => (name ?? local) === "App")?.[0];
  // Inside a script element, "</script" would end it early, and "<!--" would change how it is read.
  if (!exports || !app || /<\/script|<!--/iu.test(bundle)) throw new Error("the ext-apps bundle does not have the expected shape");
  const bridge = `const App = (() => {\n${bundle.slice(0, exports.index)}\nreturn ${app};\n})();`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CARD_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>APIUniCon</title>
<style>${CARD_STYLE}</style>
</head>
<body>
<main id="card"></main>
<script type="module">
${bridge}
${CARD_VIEW_SCRIPT}
</script>
</body>
</html>
`;
}
