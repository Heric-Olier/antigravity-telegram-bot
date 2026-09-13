/**
 * DOM probes for driving the bot through Telegram Web (web.telegram.org/k/).
 *
 * These are NOT executed by Node. Each probe is a self-contained arrow function
 * meant to be pasted into the Playwright MCP `browser_evaluate` tool:
 *
 *   browser_evaluate({ function: "<paste probe source here>" })
 *
 * Rules that keep this working:
 *  - Never call `browser_snapshot` on a Telegram chat. The accessibility tree of
 *    a message list is hundreds of nodes and will flood the agent context. Use
 *    `probeState` for polling and `readChat` when you need detail.
 *  - Probes cannot reference anything outside their own body, so selectors are
 *    repeated inline on purpose. When Telegram Web changes its markup, run
 *    `discoverSelectors` and fix the constants in every probe.
 *  - Placeholders written as /* ARG *\/ must be replaced with a literal value
 *    before pasting, because `browser_evaluate` takes no arguments.
 *
 * Status markers come from src/i18n/en.ts and require BOT_LOCALE=en.
 *
 * Calibrated against Telegram Web K on 2026-07-27. Confirmed selectors:
 *   .bubbles                                       message list container
 *   .bubble[data-mid]                              a real message; plain
 *                                                  `.bubble` also matches the
 *                                                  "Today" date separators,
 *                                                  which have no data-mid
 *   .bubble.is-out                                 our own message
 *   .message                                       message body
 *   .input-message-input:not(.input-field-input-fake)   the real composer;
 *                                                  the `-fake` twin exists only
 *                                                  to measure height
 *   .pinned-message-content                        pinned state dashboard
 *
 * Synthetic `element.click()` does NOT work for Telegram Web navigation (the
 * chat list ignores it). Use the Playwright `browser_click` tool with a CSS
 * selector so a real pointer event is dispatched.
 *
 * Two findings that invalidate the naive approach:
 *  - Telegram Web renders emoji as <img class="emoji" alt="✅">, so `innerText`
 *    drops every status marker. All probes rebuild text from the alt attribute.
 *  - The "⏳ Working" / "✅ Finished Work" markers only exist when compact
 *    output mode is ON. With it off (the default) a run ends with the footer
 *    "{agent} · 🧠 {model} · 🕒 {duration}", so probeState treats both as done.
 */

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

/**
 * Run this ONCE against a live chat before the first scenario, and after any
 * Telegram Web update. It reports which selectors actually resolve so the
 * constants below can be corrected instead of silently matching nothing.
 */
const discoverSelectors = () => {
  const candidates = {
    bubbleContainer: [".bubbles", ".chat .scrollable", "[class*='bubbles']"],
    bubble: [".bubble", "[data-mid]", "[class*='bubble']"],
    messageText: [".message", ".bubble-content .message", "[class*='message']"],
    inlineButton: [".reply-markup-button", "[class*='reply-markup'] button", "button[class*='markup']"],
    composer: [".input-message-input[contenteditable]", "[contenteditable='true']"],
    pinned: [".pinned-message-content", "[class*='pinned-message']", "[class*='pinned']"],
    replyKeyboard: [".reply-keyboard", "[class*='reply-keyboard']"],
  };

  const result = {};
  for (const [name, list] of Object.entries(candidates)) {
    result[name] = list.map((selector) => ({
      selector,
      count: document.querySelectorAll(selector).length,
    }));
  }

  const lastBubble = document.querySelector(".bubble:last-of-type, [data-mid]:last-of-type");
  result.lastBubbleOuterHtml = lastBubble ? lastBubble.outerHTML.slice(0, 1500) : null;
  return result;
};

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

/**
 * Cheap run-state probe. This is the ONLY thing that should be called in a wait
 * loop. Returns a small object, roughly 100-200 tokens.
 *
 * status:
 *   finished           -> run complete, safe to read results
 *   waiting_permission -> bot needs an Allow/Reject answer
 *   waiting_question   -> bot needs a poll answer
 *   working            -> still running (thinking / writing / tool calls)
 *   retrying           -> provider error, bot is retrying
 *   busy_guard         -> we sent input too early; guard rejected it
 *   blocked_guard      -> guard expects a different input kind
 *   idle               -> no progress message in view
 */
const probeState = () => {
  // Telegram Web replaces emoji with <img class="emoji" alt="✅">, so innerText
  // silently drops every status marker. Restore them from the alt attribute.
  const readText = (el) => {
    if (!el) return "";
    const clone = el.cloneNode(true);
    clone.querySelectorAll("img.emoji").forEach((img) => {
      img.replaceWith(document.createTextNode(img.getAttribute("alt") || ""));
    });
    clone.querySelectorAll(".time").forEach((n) => n.remove());
    return (clone.textContent || "").trim();
  };

  const bubbles = [...document.querySelectorAll(".bubble[data-mid]")].slice(-10);
  const texts = bubbles.map((b) => readText(b.querySelector(".message") || b));
  const joined = texts.join("\n---\n");
  const last = texts[texts.length - 1] || "";

  const has = (needle) => joined.includes(needle);
  // Compact mode ends with "✅ Finished Work"; normal mode ends with the run
  // footer "{agent} · 🧠 {model} · 🕒 {duration}" (settings > Assistant footer).
  const footerDone = /·\s*🕒\s*\S+/.test(last);

  let status = "idle";
  if (has("✅ Finished Work") || footerDone) status = "finished";
  else if (has("🔐 Waiting for permission")) status = "waiting_permission";
  else if (has("❓ Waiting for your answer")) status = "waiting_question";
  else if (has("🔁 Retrying")) status = "retrying";
  else if (has("⏳ Working") || has("💭 Thinking")) status = "working";
  if (last.includes("Agent is already running a task")) status = "busy_guard";
  else if (status === "idle" && last.trim().startsWith("⚠️")) status = "blocked_guard";

  const doneMatch = joined.match(/tool calls:\s*(\d+)\s*·\s*changed files:\s*(\d+)/);

  return {
    status,
    toolCalls: doneMatch ? Number(doneMatch[1]) : null,
    changedFiles: doneMatch ? Number(doneMatch[2]) : null,
    lastText: last.slice(0, 300),
    buttons: [...(bubbles[bubbles.length - 1]?.querySelectorAll(".reply-markup-button") || [])].map(
      (b) => readText(b),
    ),
    bubbleCount: bubbles.length,
  };
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Detailed tail of the conversation. Call once after `probeState` reports
 * `finished`, not inside the wait loop.
 *
 * `html` is included so MarkdownV2 rendering can be asserted textually
 * (<strong>, <em>, <code>, <pre>) instead of by eyeballing a screenshot.
 */
const readChat = () => {
  const LIMIT = 8; /* ARG: how many trailing messages */
  const readText = (el) => {
    if (!el) return "";
    const clone = el.cloneNode(true);
    clone.querySelectorAll("img.emoji").forEach((img) => {
      img.replaceWith(document.createTextNode(img.getAttribute("alt") || ""));
    });
    clone.querySelectorAll(".time").forEach((n) => n.remove());
    return (clone.textContent || "").trim();
  };

  return [...document.querySelectorAll(".bubble[data-mid]")].slice(-LIMIT).map((b) => {
    const body = b.querySelector(".message");
    return {
      mid: b.dataset.mid || null,
      out: b.classList.contains("is-out"),
      text: readText(body || b).slice(0, 800),
      html: body ? body.innerHTML.slice(0, 800) : "",
      buttons: [...b.querySelectorAll(".reply-markup-button")].map((x) => readText(x)),
    };
  });
};

/**
 * The pinned message is the bot's state dashboard: project, worktree, model,
 * tracking (idle/busy), context usage, cost, changed files. Prefer this over
 * scrolling the message list when asserting state.
 *
 * Do NOT read the pinned bar at the top of the chat - it only shows a truncated
 * one-line preview. The bar does carry `data-mid` pointing at the real message,
 * so resolve that id in the message list and read the full text there.
 *
 * If the pinned message has scrolled out of the virtualised list, `found` is
 * false while `mid` is set. Click the bar to jump to it:
 *   browser_click({ target: ".pinned-message" })
 */
const readPinned = () => {
  const readText = (el) => {
    if (!el) return "";
    const clone = el.cloneNode(true);
    clone.querySelectorAll("img.emoji").forEach((img) => {
      img.replaceWith(document.createTextNode(img.getAttribute("alt") || ""));
    });
    clone.querySelectorAll(".time").forEach((n) => n.remove());
    return (clone.textContent || "").trim();
  };

  const bar = document.querySelector(".pinned-message[data-mid], .pinned-container[data-mid]");
  const mid = bar ? bar.dataset.mid : null;
  if (!mid) return { found: false, mid: null, reason: "no_pinned_bar" };

  const bubble = document.querySelector('.bubble[data-mid="' + mid + '"]');
  if (!bubble) return { found: false, mid, reason: "outside_virtualised_dom" };

  const text = readText(bubble.querySelector(".message") || bubble);
  const pick = (label) => {
    const m = text.match(new RegExp("^" + label + ":\\s*(.+)$", "m"));
    return m ? m[1].trim() : null;
  };

  return {
    found: true,
    mid,
    raw: text.slice(0, 800),
    title: text.split("\n")[0] || null,
    project: pick("Project"),
    worktree: pick("Worktree"),
    model: pick("Model"),
    tracking: pick("Tracking"),
    context: pick("Context"),
    cost: pick("Cost"),
  };
};

/**
 * The bottom reply keyboard ends with a fixed 2x2 grid (see
 * src/bot/keyboards/main-reply-keyboard.ts), optionally preceded by 0..5
 * one-per-row queued-prompt buttons, so read the fixed grid BY POSITION FROM
 * THE END. Labels are dynamic; only the emoji anchors are stable: agent ends
 * with " Agent", context starts with "📊", variant starts with "💡" or "💭",
 * queued prompts start with "❌ <n>. ".
 *
 * READING the buttons works even while the keyboard is collapsed, but CLICKING
 * one does not: Playwright rejects a collapsed button as "not visible", and a
 * JS `offsetParent` check will NOT catch this - it reports the button visible.
 * Always expand first:
 *   browser_click({ target: ".toggle-reply-markup.show" })
 */
const readReplyKeyboard = () => {
  const readText = (el) => {
    if (!el) return "";
    const clone = el.cloneNode(true);
    clone.querySelectorAll("img.emoji").forEach((img) => {
      img.replaceWith(document.createTextNode(img.getAttribute("alt") || ""));
    });
    return (clone.textContent || "").trim();
  };

  const flat = [...document.querySelectorAll(".reply-keyboard-button")].map((b) => readText(b));
  const fixed = flat.slice(-4);
  return {
    found: flat.length > 0,
    agent: fixed[0] || null,
    context: fixed[1] || null,
    model: fixed[2] || null,
    variant: fixed[3] || null,
    queued: flat.slice(0, Math.max(flat.length - 4, 0)),
  };
};

// ---------------------------------------------------------------------------
// Acting
// ---------------------------------------------------------------------------

/**
 * Lists the inline buttons of the most recent message. Labels are static i18n
 * strings ("✅ Allow once", "🔓 Allow always", "❌ Reject", "✅ Done").
 *
 * CAUTION: the bottom reply-keyboard buttons share the .reply-markup-button
 * class, so an unqualified selector mixes both keyboards. Always exclude
 * .reply-keyboard-button.
 *
 * To CLICK, use the Playwright tool - synthetic clicks are unreliable here:
 *   browser_click({
 *     target: ".reply-markup-button:not(.reply-keyboard-button):has-text('Reject')"
 *   })
 * Note the single quotes: escaped double quotes break the CSS parser.
 */
const listInlineButtons = () => {
  const readText = (el) => {
    const clone = el.cloneNode(true);
    clone.querySelectorAll("img.emoji").forEach((img) => {
      img.replaceWith(document.createTextNode(img.getAttribute("alt") || ""));
    });
    return (clone.textContent || "").trim();
  };
  const bubbles = [...document.querySelectorAll(".bubble[data-mid]")];
  const last = bubbles[bubbles.length - 1];
  if (!last) return { mid: null, buttons: [] };
  return {
    mid: last.dataset.mid,
    buttons: [...last.querySelectorAll(".reply-markup-button:not(.reply-keyboard-button)")].map(
      (b) => readText(b),
    ),
  };
};

/**
 * Types into the composer and sends. Single-line only: Enter submits, so a
 * multi-line prompt must be sent as separate messages or pasted.
 *
 * PREFER the Playwright tool, which is verified to work:
 *   browser_type({
 *     target: ".input-message-input:not(.input-field-input-fake)",
 *     text: "/status",
 *     submit: true,
 *   })
 * This probe is only a fallback.
 */
const sendPrompt = () => {
  const TEXT = "hello"; /* ARG: message text */
  const input = document.querySelector(".input-message-input:not(.input-field-input-fake)");
  if (!input) return { sent: false, reason: "composer_not_found" };

  input.focus();
  document.execCommand("insertText", false, TEXT);
  input.dispatchEvent(new Event("input", { bubbles: true }));

  const enter = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true };
  input.dispatchEvent(new KeyboardEvent("keydown", enter));
  input.dispatchEvent(new KeyboardEvent("keyup", enter));
  return { sent: true, text: TEXT };
};

/**
 * Marks the current tail of the chat so a scenario step can later assert
 * "everything after this point". Returns the last message id; pass it to
 * readChat filtering if a scenario needs strict before/after isolation.
 */
const markTail = () => {
  const bubbles = [...document.querySelectorAll(".bubble[data-mid]")];
  const last = bubbles[bubbles.length - 1];
  return { mid: last ? last.dataset.mid : null, count: bubbles.length };
};
