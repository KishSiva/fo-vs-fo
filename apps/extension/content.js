// Runs on Facebook Marketplace and Messenger pages. It only reads what's on screen and, when asked, types a draft
// into the message box. It never presses Send: the owner reviews and sends every message themselves.
(() => {
  if (window.__proxydealCopilot) return;
  window.__proxydealCopilot = true;

  const clean = (s) => (s || '').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  // Facebook renders timestamps, "Seen", reactions and system notes as rows too; none of those are messages.
  const NOISE = /^(\d{1,2}:\d{2}\s?(am|pm)?|today at .*|yesterday at .*|seen.*|sent|delivered|you sent .*|.* sent an attachment\.?|enter|you can now .*|.* started this chat.*)$/i;

  /** Listing page: title, price and description as plain text (the plan step copes with leftover page text). */
  function readListing() {
    const main = document.querySelector('[role="main"]') || document.body;
    const title = main.querySelector('h1')?.innerText || document.title;
    return { url: location.href, title: clean(title), text: clean(main.innerText).slice(0, 4000) };
  }

  /** The open conversation: the chat panel if one is open, else the page's main area. */
  function chatRoot() {
    const panels = [...document.querySelectorAll('[aria-label^="Messages in conversation"], [role="dialog"] [role="grid"], [role="main"] [role="grid"]')];
    return panels.at(-1) || document.querySelector('[role="main"]') || document.body;
  }

  /**
   * Messages as {from, text}. Facebook doesn't label who sent what, but your own bubbles sit on the right half of the
   * conversation and theirs on the left, so the bubble's position decides.
   */
  function readChat() {
    const root = chatRoot();
    const box = root.getBoundingClientRect();
    const mid = box.left + box.width / 2;
    const lines = [];
    const rows = root.querySelectorAll('[role="row"]');
    const units = rows.length ? rows : root.querySelectorAll('[dir="auto"]');
    for (const row of units) {
      const bubble = row.matches('[dir="auto"]') ? row : row.querySelector('[dir="auto"]');
      const text = clean(bubble?.innerText);
      if (!text || NOISE.test(text)) continue;
      const r = bubble.getBoundingClientRect();
      if (!r.width) continue;
      const from = r.left + r.width / 2 > mid ? 'me' : 'them';
      const last = lines.at(-1);
      if (last && last.from === from && last.text === text) continue;
      lines.push({ from, text });
    }
    const title = document.querySelector('[role="main"] h2, [role="dialog"] h2, [role="main"] [role="heading"]')?.innerText || document.title;
    return { url: location.href, title: clean(title), lines: lines.slice(-80) };
  }

  /** Put the draft in the message box (cursor at the end). The owner presses Enter. */
  function insertDraft(text) {
    const boxes = [...chatRoot().closest('[role="dialog"], [role="main"]')?.querySelectorAll('[contenteditable="true"][role="textbox"]') ?? []];
    const box = boxes.at(-1) || [...document.querySelectorAll('[contenteditable="true"][role="textbox"]')].at(-1);
    if (!box) return { ok: false, error: 'No message box found. Open the conversation first.' };
    box.focus();
    document.execCommand('selectAll', false);
    document.execCommand('insertText', false, text);
    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, send) => {
    try {
      if (msg?.type === 'read-listing') send({ ok: true, ...readListing() });
      else if (msg?.type === 'read-chat') send({ ok: true, ...readChat() });
      else if (msg?.type === 'insert') send(insertDraft(String(msg.text || '')));
      else send({ ok: false, error: 'unknown request' });
    } catch (e) {
      send({ ok: false, error: String(e?.message || e) });
    }
  });
})();
