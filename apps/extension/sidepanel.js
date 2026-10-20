// Side panel: talks to the ProxyDeal proxy (plans, drafts, privacy checks) and to the page (read listing, read chat,
// put a draft in the message box). The active plan and the last chat are kept in chrome.storage so they survive the
// panel closing or the tab changing from the listing to the conversation.
const $ = (id) => document.getElementById(id);
const money = (n) => (n == null ? '—' : `$${Number(n).toLocaleString()}`);
const DEFAULT_PROXY = 'http://localhost:4001';
let state = { proxyUrl: DEFAULT_PROXY, plan: null, listing: '', notes: '', queries: [], chat: [], draft: null };

const save = () => chrome.storage.local.set({ copilot: { ...state, draft: null } });
const show = (el, on) => $(el).classList.toggle('hidden', !on);
function fail(e) {
  $('error').textContent = e instanceof Error ? e.message : String(e);
  show('error', true);
}
const clearError = () => show('error', false);

async function api(path, body) {
  let res;
  try {
    res = await fetch(state.proxyUrl + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  } catch {
    throw new Error(`Can't reach the proxy at ${state.proxyUrl}. Is it running?`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `${res.status} ${res.statusText}`);
  return data;
}

/** Ask the page's content script; inject it first if this tab was open before the extension loaded. */
async function askPage(msg) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab');
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    return chrome.tabs.sendMessage(tab.id, msg);
  }
}

async function busy(btn, flag, fn) {
  $(btn).disabled = true;
  if (flag) show(flag, true);
  clearError();
  try { await fn(); } catch (e) { fail(e); } finally { $(btn).disabled = false; if (flag) show(flag, false); }
}

function renderPlan() {
  const p = state.plan;
  show('planEmpty', !p);
  show('planView', Boolean(p));
  $('listing').value = state.listing;
  $('notes').value = state.notes;
  if (!p) return;
  $('planTitle').textContent = state.listing.split('\n').find((l) => l.trim())?.slice(0, 80) || 'Your plan';
  $('pOpen').textContent = money(p.prices.open);
  $('pTarget').textContent = money(p.prices.target);
  $('pHappy').textContent = money(p.prices.happy);
  $('pLimit').textContent = money(p.prices.limit);
  $('marketRead').textContent = p.marketRead.split(/(?<=\.)\s/).slice(0, 2).join(' ');
  $('queries').replaceChildren(...state.queries.map((q) => Object.assign(document.createElement('span'), { className: 'chip', textContent: `🔍 ${q}` })));
  $('ladder').replaceChildren(...p.ladder.map((s) => Object.assign(document.createElement('li'), { textContent: `${money(s.amount)}: ${s.reason}` })));
  $('comps').replaceChildren(...p.comps.map((c) => {
    const li = document.createElement('li');
    li.append(Object.assign(document.createElement('span'), { textContent: c.label }), Object.assign(document.createElement('b'), { textContent: money(c.price) }));
    return li;
  }));
}

function renderChat() {
  $('chat').replaceChildren(...state.chat.map((l) => Object.assign(document.createElement('div'), { className: `bubble ${l.from}`, textContent: l.text })));
  $('chat').scrollTop = $('chat').scrollHeight;
}

function renderDraft() {
  const d = state.draft;
  show('result', Boolean(d));
  if (!d) return;
  show('blocked', Boolean(d.blocked));
  $('blocked').textContent = d.blocked || '';
  show('decide', Boolean(d.ownerDecision));
  $('decideText').textContent = d.ownerDecision ? `You decide: ${d.ownerDecision}` : '';
  $('decideOk').checked = false;
  $('tactic').textContent = d.tactic || '';
  $('offer').textContent = d.offerAmount != null ? `offers ${money(d.offerAmount)}` : d.theirPrice != null ? `they're at ${money(d.theirPrice)}` : '';
  show('checked', Boolean(d.checked));
  $('reply').value = d.reply || '';
  $('why').textContent = d.why || '';
  syncInsert();
}

/** A draft that needs the owner's decision can't go in the box until they tick it. */
function syncInsert() {
  const d = state.draft;
  $('insert').disabled = !d?.reply || Boolean(d.blocked) || (Boolean(d.ownerDecision) && !$('decideOk').checked);
}

async function health() {
  try {
    const h = await api('/api/health');
    $('dot').className = 'dot on';
    $('who').textContent = `${h.owner} (${h.role})`;
  } catch {
    $('dot').className = 'dot off';
    $('who').textContent = 'proxy offline';
  }
}

$('gear').onclick = () => show('settings', $('settings').classList.contains('hidden'));
$('saveSettings').onclick = () => {
  state.proxyUrl = $('proxyUrl').value.trim().replace(/\/$/, '') || DEFAULT_PROXY;
  save();
  show('settings', false);
  health();
};
$('listing').oninput = () => { state.listing = $('listing').value; save(); };
$('notes').oninput = () => { state.notes = $('notes').value; save(); };
$('decideOk').onchange = syncInsert;
$('reply').oninput = () => { if (state.draft) state.draft.reply = $('reply').value; syncInsert(); };

$('readListing').onclick = () => busy('readListing', null, async () => {
  const r = await askPage({ type: 'read-listing' });
  if (!r?.ok) throw new Error(r?.error || 'Open a Marketplace listing first');
  state.listing = r.text;
  save();
  renderPlan();
});

$('makePlan').onclick = () => busy('makePlan', 'planBusy', async () => {
  if (!state.listing.trim()) throw new Error('Read or paste the listing first');
  const r = await api('/api/plans/generate', { listing: state.listing, notes: state.notes });
  state.plan = r.plan;
  state.queries = r.queries || [];
  save();
  renderPlan();
});

$('newPlan').onclick = () => {
  state.plan = null;
  state.queries = [];
  state.draft = null;
  save();
  renderPlan();
  renderDraft();
};

$('readChat').onclick = () => busy('readChat', null, async () => {
  const r = await askPage({ type: 'read-chat' });
  if (!r?.ok) throw new Error(r?.error || 'Open the Marketplace conversation first');
  if (!r.lines.length) throw new Error("Couldn't find any messages here. Open the conversation so the messages are on screen.");
  state.chat = r.lines;
  save();
  renderChat();
});

$('draft').onclick = () => busy('draft', 'draftBusy', async () => {
  if (!state.plan) throw new Error('Generate a game plan first');
  state.draft = await api('/api/copilot/next', { plan: state.plan, listing: state.listing, chat: state.chat, note: $('note').value.trim() || undefined });
  renderDraft();
});

$('insert').onclick = () => busy('insert', null, async () => {
  const r = await askPage({ type: 'insert', text: $('reply').value });
  if (!r?.ok) throw new Error(r?.error || "Couldn't reach the message box");
  // Assume it gets sent; the next "Read this chat" corrects it either way.
  state.chat = [...state.chat, { from: 'me', text: $('reply').value }];
  save();
  renderChat();
});

$('copy').onclick = () => navigator.clipboard.writeText($('reply').value);

chrome.storage.local.get('copilot').then(({ copilot }) => {
  if (copilot) state = { ...state, ...copilot, draft: null };
  $('proxyUrl').value = state.proxyUrl;
  renderPlan();
  renderChat();
  renderDraft();
  health();
});
