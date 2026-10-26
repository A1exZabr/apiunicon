export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export type LayoutOptions = { csrfToken?: string; compact?: boolean };

export function layout(title: string, body: string, options: LayoutOptions = {}): string {
  const account = options.csrfToken
    ? `<form class="account" method="post" action="/logout"><input type="hidden" name="csrf" value="${escapeHtml(options.csrfToken)}"><button class="quiet" type="submit">Lock workspace</button></form>`
    : '<span class="edition">Local version</span>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · APIUniCon</title><style>
:root{--ink:#17211e;--muted:#68736f;--paper:#f2f0e9;--panel:#fbfaf5;--line:#cbc9bf;--signal:#2457d6;--vault:#08796e;--warn:#a94c2a}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 75% 5%,#e2e8f7 0,transparent 31%),linear-gradient(125deg,#e7ece7,var(--paper) 48%);color:var(--ink);font:16px/1.55 "Avenir Next",Avenir,"Segoe UI",sans-serif;min-height:100vh}
a{color:var(--signal);text-underline-offset:3px}main{width:min(${options.compact ? "720px" : "1120px"},calc(100% - 32px));margin:0 auto;padding:38px 0 72px}
header{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);padding-bottom:17px;margin-bottom:34px}.brand{font:750 20px/1 ui-monospace,SFMono-Regular,monospace;letter-spacing:-.05em;color:var(--ink);text-decoration:none}.edition{font:650 11px/1 ui-monospace,SFMono-Regular,monospace;color:var(--vault);text-transform:uppercase;letter-spacing:.12em}
h1,h2{font-family:Charter,"Iowan Old Style",Palatino,serif;letter-spacing:-.035em}h1{font-size:clamp(39px,6vw,72px);line-height:.98;max-width:820px;margin:0 0 18px}h2{font-size:27px;line-height:1.1;margin:0 0 14px}.lede{font-size:18px;color:var(--muted);max-width:700px;margin:0 0 32px}
.grid{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(270px,.85fr);gap:22px}.card{background:color-mix(in srgb,var(--panel) 95%,transparent);border:1px solid var(--line);border-radius:18px;padding:24px;box-shadow:0 18px 50px rgba(36,44,40,.07)}.auth-card{max-width:560px;margin:8vh auto 0}
label{display:block;font-weight:680;margin:15px 0 6px}input{width:100%;border:1px solid #b9bbb3;border-radius:9px;padding:11px 12px;background:#fffefa;color:var(--ink);font:inherit}input:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid color-mix(in srgb,var(--signal) 38%,transparent);outline-offset:2px}
.row-fields{display:grid;grid-template-columns:1fr 1fr;gap:12px}.row-fields label{margin-top:8px}
button,.button{display:inline-block;border:0;border-radius:999px;background:var(--ink);color:white;padding:12px 19px;font:730 14px/1 inherit;cursor:pointer;text-decoration:none;margin-top:18px}.quiet{background:transparent;color:var(--muted);border:1px solid var(--line);margin:0;padding:8px 12px}.account{margin:0}.error,.warning{border-left:4px solid var(--warn);background:#f7e9e2;padding:11px 14px;border-radius:4px;color:#702f18}
.secondary{background:transparent;color:var(--ink);border:1px solid var(--line)}.hero-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:-12px 0 34px}.hero-actions .button{margin-top:0}.dashboard-grid{align-items:start}.eyebrow{display:block;margin:0 0 14px;color:var(--vault);font:750 11px/1 ui-monospace,SFMono-Regular,monospace;letter-spacing:.13em;text-transform:uppercase}.start-card{max-width:680px}.section-gap{margin-top:30px}
.confirm{display:flex;align-items:flex-start;gap:10px}.confirm input{width:auto;margin-top:5px}pre{max-height:520px;overflow:auto;border:1px solid var(--line);border-radius:10px;background:#202825;color:#eef5f1;padding:16px;font:12px/1.55 ui-monospace,SFMono-Regular,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.change{overflow-wrap:anywhere}pre.value{max-height:none;overflow:visible}
.rail{display:grid;gap:2px}.rail-step{position:relative;padding:13px 12px 13px 42px;background:#e9eee9}.rail-step:first-child{border-radius:12px 12px 3px 3px}.rail-step:last-child{border-radius:3px 3px 12px 12px;background:#dbece7}.rail-step::before{content:"";position:absolute;left:17px;top:17px;width:9px;height:9px;border:2px solid var(--vault);border-radius:50%}.rail strong{display:block}.rail small{color:var(--muted)}
.status{display:inline-flex;border:1px solid var(--line);border-radius:999px;padding:4px 9px;font:650 12px/1.35 ui-monospace,SFMono-Regular,monospace;color:var(--vault);background:#eaf3ef}.rows{display:grid;gap:10px}.row{display:flex;justify-content:space-between;gap:16px;border-top:1px solid var(--line);padding-top:12px}.muted{color:var(--muted)}.danger{color:var(--warn)}code{font:13px/1.4 ui-monospace,SFMono-Regular,monospace;background:#e7e9e4;padding:2px 5px;border-radius:5px;overflow-wrap:anywhere}
.stage-list{display:grid;gap:8px;list-style:none;padding:0;margin:0 0 22px}.stage{display:grid;grid-template-columns:32px 1fr;align-items:center;gap:11px;padding:11px;border-radius:11px;color:var(--muted);background:#ecece6}.stage>span{display:grid;place-items:center;width:29px;height:29px;border:1px solid var(--line);border-radius:50%;font:700 12px/1 ui-monospace,SFMono-Regular,monospace}.stage[data-state=current]{color:var(--ink);background:#e5ecff}.stage[data-state=current]>span{color:white;background:var(--signal);border-color:var(--signal)}.stage[data-state=completed]>span{color:white;background:var(--vault);border-color:var(--vault)}.choices{display:grid;gap:10px}.choice-card{display:flex;align-items:flex-start;gap:13px;margin:0;padding:16px;border:1px solid var(--line);border-radius:13px;background:#fffefa;cursor:pointer}.choice-card input{width:auto;margin:5px 0 0}.choice-card span,.choice-card small{display:block}.domain{margin:3px 0;color:var(--vault);font:700 14px/1.4 ui-monospace,SFMono-Regular,monospace}.technical-detail{display:block;margin-top:4px;color:var(--muted);font:12px/1.4 ui-monospace,SFMono-Regular,monospace}.advanced{margin-top:20px;border-top:1px solid var(--line);padding-top:15px;color:var(--muted)}.advanced summary{font-weight:700;color:var(--ink);cursor:pointer}.advanced form{color:var(--ink)}
@media(max-width:760px){main{padding-top:24px;overflow-x:hidden}.grid,.row-fields{grid-template-columns:1fr}header{gap:14px}.card{padding:19px}.auth-card{margin-top:3vh}.quiet{font-size:12px}.row{align-items:flex-start;flex-direction:column}.hero-actions{align-items:stretch}.hero-actions .button{text-align:center}}
@media(prefers-reduced-motion:no-preference){.card{animation:arrive .32s ease-out both}@keyframes arrive{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}}
</style></head><body><main><header><a class="brand" href="/">APIUniCon</a>${account}</header>${body}</main>${options.csrfToken ? '<script defer src="/assets/app.js"></script>' : ""}</body></html>`;
}
