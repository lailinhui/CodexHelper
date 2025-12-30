(() => {
  const CONFIG_KEY = "aihelper_config_v1";
  const HISTORY_KEY = "aihelper_chat_history_v1";
  const MAX_MESSAGES = 30;
  const QUICK_ACTION_MAX_CHARS = 4000;
  const QUICK_ACTION_MIN_CHARS = 1;

  const API_URL = "https://api.openai.com/v1/responses";
  const DEFAULT_MODEL = "gpt-5.2";
  const SYSTEM_PROMPT =
    "You are a helpful assistant. When page context is provided, use it to answer accurately and concisely.";
  const TEMPERATURE = 0.2;
  const MAX_PAGE_CHARS = 12000;
  const DEFAULT_PANEL_WIDTH = "clamp(320px, 20vw, 480px)";
  const PANEL_WIDTH_KEY = "aihelper_panel_width_v1";
  const MIN_PANEL_WIDTH_PX = 280;

  function getHistoryArea() {
    // chrome.storage.session is not reliably available to content scripts across Chrome versions.
    return chrome.storage.local;
  }

  function clampNumber(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  async function loadPanelWidthPx() {
    try {
      const result = await chrome.storage.local.get(PANEL_WIDTH_KEY);
      const v = result?.[PANEL_WIDTH_KEY];
      if (typeof v === "number" && Number.isFinite(v) && v >= MIN_PANEL_WIDTH_PX) return v;
    } catch {
      // ignore
    }
    return null;
  }

  async function savePanelWidthPx(value) {
    try {
      const widthPx = Number(value);
      if (!Number.isFinite(widthPx) || widthPx < MIN_PANEL_WIDTH_PX) return;
      await chrome.storage.local.set({ [PANEL_WIDTH_KEY]: widthPx });
    } catch {
      // ignore
    }
  }

  function trimChatHistory(history) {
    const arr = Array.isArray(history) ? history : [];
    if (arr.length <= MAX_MESSAGES) return arr;
    return arr.slice(arr.length - MAX_MESSAGES);
  }

  async function loadChatHistory() {
    const area = getHistoryArea();
    const result = await area.get(HISTORY_KEY);
    const data = result?.[HISTORY_KEY];
    const arr = Array.isArray(data) ? data : [];
    return trimChatHistory(
      arr
        .filter((m) => m && typeof m === "object")
        .map((m) => ({ role: m.role, content: m.content }))
        .filter(
          (m) =>
            (m.role === "user" || m.role === "assistant") && typeof m.content === "string"
        )
    );
  }

  async function saveChatHistory(history) {
    const area = getHistoryArea();
    await area.set({ [HISTORY_KEY]: trimChatHistory(history) });
  }

  async function loadConfig() {
    const result = await chrome.storage.sync.get(CONFIG_KEY);
    const saved = result?.[CONFIG_KEY] && typeof result[CONFIG_KEY] === "object"
      ? result[CONFIG_KEY]
      : {};
    const token = typeof saved.token === "string" ? saved.token : "";
    const modelRaw = typeof saved.model === "string" ? saved.model : "";
    const model = modelRaw.trim() || DEFAULT_MODEL;
    const enableSelectionActions = Boolean(saved.enableSelectionActions);
    return {
      apiUrl: API_URL,
      token,
      model,
      enableSelectionActions,
      systemPrompt: SYSTEM_PROMPT,
      temperature: TEMPERATURE,
      maxPageChars: MAX_PAGE_CHARS
    };
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs && typeof attrs === "object") {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === "class") node.className = String(v);
        else if (k === "text") node.textContent = String(v);
        else if (k.startsWith("on") && typeof v === "function") {
          node.addEventListener(k.slice(2).toLowerCase(), v);
        } else {
          node.setAttribute(k, String(v));
        }
      }
    }
    if (Array.isArray(children)) {
      for (const c of children) {
        if (c == null) continue;
        node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      }
    }
    return node;
  }

  function parseFencedCodeBlocks(text) {
    const src = String(text || "");
    const parts = [];
    const re = /```([^\n`]*)\n([\s\S]*?)```/g;
    let lastIndex = 0;
    for (;;) {
      const m = re.exec(src);
      if (!m) break;
      if (m.index > lastIndex) {
        parts.push({ type: "text", text: src.slice(lastIndex, m.index) });
      }
      const lang = String(m[1] || "").trim();
      const code = String(m[2] || "");
      parts.push({ type: "code", lang, code });
      lastIndex = re.lastIndex;
    }
    if (lastIndex < src.length) parts.push({ type: "text", text: src.slice(lastIndex) });
    return parts.length ? parts : [{ type: "text", text: src }];
  }

  async function copyToClipboard(text) {
    const value = String(text || "");
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // fallback
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.style.position = "fixed";
      ta.style.top = "-9999px";
      ta.style.left = "-9999px";
      document.documentElement.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  function buildUserMessage(userText, pageContext, includePage) {
    const text = String(userText || "").trim();
    if (!text) return "";
    if (!includePage || !pageContext) return text;

    const lines = [];
    lines.push("Page context:");
    if (pageContext.title) lines.push(`Title: ${pageContext.title}`);
    if (pageContext.url) lines.push(`URL: ${pageContext.url}`);
    if (pageContext.selection) {
      lines.push("Selection:");
      lines.push(pageContext.selection);
    }
    if (pageContext.content) {
      lines.push("Content:");
      lines.push(pageContext.content);
    }
    lines.push("");
    lines.push("User question:");
    lines.push(text);
    return lines.join("\n");
  }

  function getPageContext(maxChars) {
    const selection = String(window.getSelection?.()?.toString?.() || "").trim();
    const title = document.title || "";
    const url = location.href || "";
    const rawText = document.body ? document.body.innerText || "" : "";
    const text = rawText.replace(/\s+\n/g, "\n").trim();
    const clipped = text.length > maxChars ? text.slice(0, maxChars) + "\n…(truncated)" : text;
    return {
      title,
      url,
      selection,
      content: clipped
    };
  }

  function makeRequestId() {
    try {
      return crypto.randomUUID();
    } catch {
      return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
  }

  async function callChatApi(messages, requestId) {
    return await chrome.runtime.sendMessage({ type: "CHAT", messages, requestId });
  }

  async function cancelChatApi(requestId) {
    return await chrome.runtime.sendMessage({ type: "CANCEL_CHAT", requestId });
  }

  function ensureSingleton() {
    if (window.__aihelperPanel?.version) return window.__aihelperPanel;
    const state = {
      version: 1,
      mounted: false,
      quickActionsMounted: false,
      quickActionsEnabled: false,
      messageListenerMounted: false,
      pendingQuickAction: null,
      sendQuickAction: null
    };
    Object.defineProperty(window, "__aihelperPanel", {
      value: state,
      configurable: true
    });
    return state;
  }

  function isProbablyChinese(text) {
    const s = String(text || "");
    const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
    const latin = (s.match(/[A-Za-z]/g) || []).length;
    if (cjk === 0 && latin === 0) return false;
    if (cjk === 0) return false;
    if (latin === 0) return true;
    return cjk >= latin * 0.6;
  }

  function getSelectionText() {
    try {
      return String(window.getSelection?.()?.toString?.() || "").trim();
    } catch {
      return "";
    }
  }

  function selectionLooksEditable(sel) {
    try {
      const node = sel?.anchorNode;
      if (!node) return false;
      const el =
        node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      if (!el) return false;
      return Boolean(
        el.closest?.(
          'input, textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]'
        )
      );
    } catch {
      return false;
    }
  }

  function selectionInPanel(sel) {
    try {
      const state = ensureSingleton();
      const root = state?.root;
      if (!root) return false;
      const node = sel?.anchorNode;
      if (!node) return false;
      if (root === node) return true;
      if (root.contains?.(node)) return true;
      const rn = node.getRootNode?.();
      if (rn && rn.host && rn.host === root) return true;
      return false;
    } catch {
      return false;
    }
  }

  function truncatePreview(text, maxLen) {
    const s = String(text || "").trim();
    const limit = typeof maxLen === "number" ? maxLen : 240;
    if (s.length <= limit) return s;
    return s.slice(0, Math.max(0, limit - 1)) + "…";
  }

  function clipSelectionForPrompt(text) {
    const raw = String(text || "");
    const trimmed = raw.trim();
    if (trimmed.length <= QUICK_ACTION_MAX_CHARS) return { text: trimmed, clipped: false };
    return { text: trimmed.slice(0, QUICK_ACTION_MAX_CHARS) + "\n…(truncated)", clipped: true };
  }

  function buildTranslatePrompt(selectionText) {
    const input = String(selectionText || "").trim();
    const zh = isProbablyChinese(input);
    const source = zh ? "中文" : "英文";
    const target = zh ? "英文" : "中文";
    return {
      title: `翻译（${source}→${target}）`,
      prompt: [
        `请把下面的文本从${source}翻译成${target}。`,
        "要求：",
        "- 保留原意、语气与格式（包含换行/列表/标点）",
        "- 专有名词保留原文，必要时补充常见译名",
        "- 只输出译文，不要解释、不要加前后缀",
        "",
        "文本：",
        "```",
        input,
        "```"
      ].join("\n")
    };
  }

  function buildExplainPrompt(selectionText) {
    const input = String(selectionText || "").trim();
    return {
      title: "解释",
      prompt: [
        "请用中文解释下面这段文本的含义，尽量简洁清晰：",
        "1) 用 1-2 句话概括整体意思；",
        "2) 解释关键术语/隐含前提；",
        "3) 如果存在歧义，列出 1-2 种可能解读；",
        "4) 如有必要给一个简短例子帮助理解。",
        "",
        "文本：",
        "```",
        input,
        "```"
      ].join("\n")
    };
  }

  function getSelectionRect(sel) {
    try {
      if (!sel || sel.rangeCount <= 0) return null;
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect && rect.width && rect.height) return rect;
      const rects = range.getClientRects();
      if (rects && rects.length) return rects[rects.length - 1];
      return rect || null;
    } catch {
      return null;
    }
  }

  function mountQuickActions() {
    const state = ensureSingleton();
    if (state.quickActionsMounted) return;
    state.quickActionsMounted = true;

    const host = document.createElement("div");
    host.id = "aihelper-quick-actions-root";
    const shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .wrap {
        position: fixed;
        top: 0;
        left: 0;
        z-index: 2147483647;
        font: 13px/1.25 -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
        user-select: none;
        -webkit-font-smoothing: antialiased;
      }
      .menu {
        position: fixed;
        display: flex;
        gap: 6px;
        padding: 6px;
        border-radius: 999px;
        background: rgba(16, 24, 38, 0.86);
        border: 1px solid rgba(255, 255, 255, 0.14);
        box-shadow: 0 12px 30px rgba(0,0,0,0.35);
        backdrop-filter: blur(10px);
        transform: translate(-100%, -110%) scale(0.98);
        transform-origin: 100% 100%;
        opacity: 0;
        transition: opacity 120ms ease, transform 120ms ease;
        pointer-events: none;
      }
      .menu[data-pos="bottom"] {
        transform: translate(-100%, 12px) scale(0.98);
        transform-origin: 100% 0%;
      }
      .menu.show {
        opacity: 1;
        transform: translate(-100%, -110%) scale(1);
        pointer-events: auto;
      }
      .menu.show[data-pos="bottom"] {
        transform: translate(-100%, 12px) scale(1);
      }
      .btn {
        appearance: none;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(255, 255, 255, 0.06);
        color: rgba(255, 255, 255, 0.92);
        border-radius: 999px;
        padding: 6px 10px;
        cursor: pointer;
        letter-spacing: 0.2px;
      }
      .btn:hover { border-color: rgba(110, 231, 255, 0.28); background: rgba(110, 231, 255, 0.12); }
      .btn:active { transform: translateY(0.5px); }
      .btn:disabled { opacity: 0.55; cursor: not-allowed; }
    `;

    const menu = document.createElement("div");
    menu.className = "menu";
    menu.setAttribute("role", "menu");

    const translateBtn = document.createElement("button");
    translateBtn.type = "button";
    translateBtn.className = "btn";
    translateBtn.textContent = "翻译";
    translateBtn.setAttribute("aria-label", "翻译选中文本");

	    const explainBtn = document.createElement("button");
	    explainBtn.type = "button";
	    explainBtn.className = "btn";
	    explainBtn.textContent = "解释";
	    explainBtn.setAttribute("aria-label", "解释选中文本");

	    const copyBtn = document.createElement("button");
	    copyBtn.type = "button";
	    copyBtn.className = "btn";
	    copyBtn.textContent = "复制";
	    copyBtn.setAttribute("aria-label", "复制选中文本");

	    menu.appendChild(translateBtn);
	    menu.appendChild(explainBtn);
	    menu.appendChild(copyBtn);
	    shadow.appendChild(style);
	    shadow.appendChild(el("div", { class: "wrap" }, [menu]));
	    document.documentElement.appendChild(host);

    let visibleSelectionText = "";
    let lastPos = { left: 0, top: 0, pos: "top" };
    let rafId = null;
    let isMouseSelecting = false;

	    function setButtonsDisabled(disabled) {
	      translateBtn.disabled = Boolean(disabled);
	      explainBtn.disabled = Boolean(disabled);
	      copyBtn.disabled = Boolean(disabled);
	    }

	    function hideMenu() {
	      menu.classList.remove("show");
	      visibleSelectionText = "";
	      copyBtn.textContent = "复制";
	      setButtonsDisabled(false);
	    }

    function showMenuAt(rect) {
      if (!rect) return;
      const padding = 10;
      const pos = rect.top > 56 ? "top" : "bottom";
      menu.dataset.pos = pos;
      menu.classList.add("show");

      const width = Math.max(120, menu.getBoundingClientRect().width || 160);
      const nextLeft = clampNumber(rect.right, padding + width, window.innerWidth - padding);
      const nextTop = clampNumber(pos === "top" ? rect.top : rect.bottom, padding, window.innerHeight - padding);
      lastPos = { left: nextLeft, top: nextTop, pos };
      menu.style.left = `${nextLeft}px`;
      menu.style.top = `${nextTop}px`;
    }

    function updateFromSelection() {
      const state = ensureSingleton();
      if (!state.quickActionsEnabled) return hideMenu();
      if (isMouseSelecting) return hideMenu();

      const sel = window.getSelection?.();
      if (!sel || sel.isCollapsed) return hideMenu();
      if (selectionInPanel(sel)) return hideMenu();
      if (selectionLooksEditable(sel)) return hideMenu();

      const text = String(sel.toString?.() || "").trim();
      if (text.length < QUICK_ACTION_MIN_CHARS) return hideMenu();
      if (text === visibleSelectionText && menu.classList.contains("show")) {
        const rect = getSelectionRect(sel);
        if (rect) showMenuAt(rect);
        return;
      }

      visibleSelectionText = text;
      const rect = getSelectionRect(sel);
      if (!rect) return hideMenu();
      showMenuAt(rect);
    }

    function scheduleUpdate() {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => updateFromSelection());
    }

    function requestAction(kind) {
      const text = String(visibleSelectionText || "").trim();
      if (!text) return;
      setButtonsDisabled(true);

      try {
        const state = ensureSingleton();
        const payload = { kind, text };
        if (state.mounted && typeof state.sendQuickAction === "function") {
          state.sendQuickAction(payload);
        } else {
          state.pendingQuickAction = payload;
          mountPanel({ focusInput: false });
        }
      } finally {
        // Hide quickly to avoid covering selection while reading.
        setTimeout(() => hideMenu(), 60);
      }
    }

    translateBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      requestAction("translate");
    });
	    explainBtn.addEventListener("click", (e) => {
	      e.preventDefault();
	      e.stopPropagation();
	      requestAction("explain");
	    });
	    copyBtn.addEventListener("click", async (e) => {
	      e.preventDefault();
	      e.stopPropagation();
	      const text = String(visibleSelectionText || "").trim();
	      if (!text) return;
	      setButtonsDisabled(true);
	      const ok = await copyToClipboard(text);
	      copyBtn.textContent = ok ? "已复制" : "复制失败";
	      setTimeout(() => hideMenu(), 450);
	    });

    document.addEventListener(
      "mousedown",
      (e) => {
        if (e.button === 0) isMouseSelecting = true;
        if (!menu.classList.contains("show")) return;
        const path = e.composedPath?.() || [];
        if (path.includes(menu) || path.includes(host)) return;
        hideMenu();
      },
      true
    );
    document.addEventListener(
      "mouseup",
      (e) => {
        if (e.button !== 0) return;
        isMouseSelecting = false;
        setTimeout(() => scheduleUpdate(), 0);
      },
      true
    );
    document.addEventListener("keyup", (e) => {
      if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") return;
      scheduleUpdate();
    });
    document.addEventListener(
      "selectionchange",
      () => {
        if (isMouseSelecting) return;
        const sel = window.getSelection?.();
        if (!sel || sel.isCollapsed) hideMenu();
      },
      true
    );
    window.addEventListener("scroll", () => {
      if (!menu.classList.contains("show")) return;
      scheduleUpdate();
    }, true);

    state.quickActions = {
      hide: hideMenu,
      update: scheduleUpdate
    };
  }

  function mountPanel(opts) {
    const state = ensureSingleton();
    if (state.mounted) return;
    state.mounted = true;
    const shouldFocusInput = opts?.focusInput !== false;

    const root = document.createElement("div");
    root.id = "aihelper-panel-root";
    const shadow = root.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
	      .wrap {
	        position: fixed;
	        top: 0;
	        right: 0;
	        height: 100vh;
	        width: var(--aihelper-panel-width, ${DEFAULT_PANEL_WIDTH});
	        display: flex;
	        flex-direction: column;
	        background: #0b0f19;
	        color: #e7edf7;
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
        z-index: 2147483647;
        border-left: 1px solid rgba(255, 255, 255, 0.1);
        box-shadow: 0 0 0 1px rgba(0,0,0,0.1), -20px 0 50px rgba(0,0,0,0.35);
      }
      .topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 10px 10px 8px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.04), transparent);
      }
      .brand { display: flex; flex-direction: column; gap: 2px; }
      .title { font-weight: 650; letter-spacing: 0.2px; }
      .subtitle { color: #93a4bf; font-size: 11px; }
	      .actions { display: flex; gap: 8px; align-items: center; }
	      .btn {
	        border: 1px solid rgba(255, 255, 255, 0.08);
	        background: rgba(255, 255, 255, 0.03);
	        color: #e7edf7;
	        border-radius: 10px;
	        padding: 7px 10px;
	        cursor: pointer;
	      }
	      .btn:hover { border-color: rgba(255, 255, 255, 0.14); }
	      .btn.primary {
	        border-color: rgba(110, 231, 255, 0.3);
	        background: rgba(110, 231, 255, 0.12);
	      }
	      .btn.danger {
	        border-color: rgba(255, 107, 107, 0.35);
	        background: rgba(255, 107, 107, 0.14);
	      }
	      .btn.secondary { padding: 6px 10px; font-size: 12px; }
	      .btn:disabled { opacity: 0.55; cursor: not-allowed; }
	      .resizer {
	        position: absolute;
	        left: -6px;
	        top: 0;
	        width: 12px;
	        height: 100%;
	        cursor: ew-resize;
	        touch-action: none;
	      }
	      .resizer:hover {
	        background: linear-gradient(90deg, rgba(110, 231, 255, 0.18), transparent);
	      }
      .main {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 10px;
        min-height: 0;
      }
      .notice {
        padding: 10px;
        border: 1px solid rgba(255, 107, 107, 0.25);
        background: rgba(255, 107, 107, 0.08);
        border-radius: 12px;
      }
      .hidden { display: none; }
      .chat {
        flex: 1;
        overflow: auto;
        padding: 10px;
        border-radius: 14px;
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.04), transparent);
        border: 1px solid rgba(255, 255, 255, 0.08);
      }
      .bubble {
        max-width: 92%;
        padding: 10px 11px;
        border-radius: 14px;
        margin: 8px 0;
        white-space: pre-wrap;
        word-break: break-word;
        border: 1px solid rgba(255, 255, 255, 0.08);
      }
      .bubble.user {
        margin-left: auto;
        background: rgba(110, 231, 255, 0.1);
        border-color: rgba(110, 231, 255, 0.22);
      }
      .bubble.assistant {
        margin-right: auto;
        background: rgba(255, 255, 255, 0.03);
      }
      .bubble.error {
        border-color: rgba(255, 107, 107, 0.28);
        background: rgba(255, 107, 107, 0.09);
      }
      .md { white-space: pre-wrap; }
      .codeblock {
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 12px;
        overflow: hidden;
        margin: 10px 0;
        background: rgba(16, 24, 38, 0.7);
      }
      .codebar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 8px 10px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(255, 255, 255, 0.03);
      }
      .codelang { color: #93a4bf; font-size: 11px; }
      .copyhint { color: #93a4bf; font-size: 11px; }
      pre {
        margin: 0;
        padding: 10px 12px;
        overflow: auto;
        font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
        color: #e7edf7;
      }
      code { white-space: pre; }
      .meta { color: #93a4bf; font-size: 11px; margin-top: 4px; }
      .controls {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      .toggle {
        display: flex;
        align-items: center;
        gap: 8px;
        color: #93a4bf;
        user-select: none;
      }
      .composer {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 10px;
        align-items: end;
      }
      textarea {
        resize: none;
        border-radius: 14px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(255, 255, 255, 0.02);
        color: #e7edf7;
        padding: 10px 11px;
        outline: none;
        min-height: 44px;
        max-height: 130px;
      }
      textarea:focus { border-color: rgba(110, 231, 255, 0.25); }
      .footnote { color: #93a4bf; font-size: 11px; padding: 0 2px; }
    `;

    const statusEl = el("div", { class: "subtitle", text: "Ready" });
    const noticeEl = el("div", { class: "notice hidden", text: "Configure Token / Model in Settings first." });
    const chatEl = el("div", { class: "chat" });
	    const includePageEl = el("input", { type: "checkbox" });
    const inputEl = el("textarea", {
      placeholder: "Ask something…",
      rows: "2",
      autocomplete: "off"
    });
	    const sendBtn = el("button", { class: "btn primary", type: "button", text: "Send" });
	    const refreshBtn = el("button", { class: "btn secondary", type: "button", text: "Refresh page" });
	    const settingsBtn = el("button", { class: "btn", type: "button", text: "Settings", title: "Settings" });
	    const closeBtn = el("button", { class: "btn", type: "button", text: "Close", title: "Close" });
	    const clearBtn = el("button", { class: "btn", type: "button", text: "Clear", title: "Clear chat" });
	    const resizerEl = el("div", { class: "resizer", title: "Drag to resize" });
	    let wrapEl = null;

    function setStatus(text) {
      statusEl.textContent = String(text || "");
    }

	    function scrollToBottom() {
	      chatEl.scrollTop = chatEl.scrollHeight;
	    }

	    function setPanelWidthCss(widthCssValue) {
	      const v = String(widthCssValue || "").trim();
	      if (!v) return;
	      root.style.setProperty("--aihelper-panel-width", v);
	      document.documentElement.style.setProperty("--aihelper-panel-width", v);
	    }

	    async function initPanelWidth() {
	      const saved = await loadPanelWidthPx();
	      if (saved) setPanelWidthCss(`${Math.round(saved)}px`);
	    }

	    const resizeState = { active: false };

	    function onResizerPointerDown(e) {
	      if (e.pointerType === "mouse" && e.button !== 0) return;
	      if (!wrapEl) return;
	      e.preventDefault();

	      const rect = wrapEl.getBoundingClientRect();
	      resizeState.active = true;
	      resizeState.pointerId = e.pointerId;
	      resizeState.startX = e.clientX;
	      resizeState.startWidth = rect.width;
	      resizeState.previousUserSelect = document.documentElement.style.userSelect || "";

	      document.documentElement.style.userSelect = "none";
	      try {
	        resizerEl.setPointerCapture(e.pointerId);
	      } catch {
	        // ignore
	      }
	    }

	    function onResizerPointerMove(e) {
	      if (!resizeState.active) return;
	      if (resizeState.pointerId !== e.pointerId) return;
	      if (!wrapEl) return;

	      const dx = e.clientX - resizeState.startX;
	      const nextWidth = resizeState.startWidth - dx;
	      const maxWidth = Math.max(MIN_PANEL_WIDTH_PX, Math.min(window.innerWidth - 120, 900));
	      const clamped = clampNumber(nextWidth, MIN_PANEL_WIDTH_PX, maxWidth);
	      setPanelWidthCss(`${Math.round(clamped)}px`);
	    }

	    async function onResizerPointerUp(e) {
	      if (!resizeState.active) return;
	      if (resizeState.pointerId !== e.pointerId) return;
	      resizeState.active = false;

	      document.documentElement.style.userSelect = resizeState.previousUserSelect || "";

	      if (wrapEl) {
	        const rect = wrapEl.getBoundingClientRect();
	        await savePanelWidthPx(Math.round(rect.width));
	      }
	    }

	    function renderBubbleContent(bubble, role, content) {
	      const raw = String(content || "");
	      bubble.textContent = "";

      if (role === "assistant") {
        const parts = parseFencedCodeBlocks(raw);
        for (const part of parts) {
          if (part.type === "code") {
            const codeText = String(part.code || "");
            const copyBtn = el("button", { class: "btn secondary", type: "button", text: "Copy" });
            const hint = el("div", { class: "copyhint", text: "" });
            copyBtn.addEventListener("click", async () => {
              const ok = await copyToClipboard(codeText);
              hint.textContent = ok ? "Copied" : "Copy failed";
              setTimeout(() => {
                hint.textContent = "";
              }, 1200);
            });

            bubble.appendChild(
              el("div", { class: "codeblock" }, [
                el("div", { class: "codebar" }, [
                  el("div", { class: "codelang", text: part.lang ? part.lang : "code" }),
                  el("div", { class: "actions" }, [hint, copyBtn])
                ]),
                el("pre", {}, [el("code", {}, [codeText])])
              ])
            );
          } else {
            const t = String(part.text || "");
            if (!t) continue;
            bubble.appendChild(el("div", { class: "md" }, [t]));
          }
        }
        return;
      }

      bubble.textContent = raw;
    }

    function addBubble(role, content, meta) {
      const bubble = el("div", { class: `bubble ${role}` }, []);
      renderBubbleContent(bubble, role, content);

      if (meta) {
        bubble.appendChild(el("div", { class: "meta", text: meta }));
      }
      chatEl.appendChild(bubble);
      scrollToBottom();
      return bubble;
    }

	    let chatHistory = [];
	    let cachedPageContext = null;
	    let activeRequestId = null;
	    let activePendingBubble = null;
	    let activeUserBubble = null;
	    let activeUserMessageIndex = null;
      state.sendQuickAction = null;

	    function setSendButtonMode(mode) {
	      const m = String(mode || "");
	      if (m === "cancel") {
	        sendBtn.textContent = "Cancel";
	        sendBtn.classList.remove("primary");
	        sendBtn.classList.add("danger");
	        return;
	      }
	      sendBtn.textContent = "Send";
	      sendBtn.classList.add("primary");
	      sendBtn.classList.remove("danger");
	    }

	    async function onCancel() {
	      const requestId = activeRequestId;
	      const pending = activePendingBubble;
	      const userBubble = activeUserBubble;
	      const userIndex = activeUserMessageIndex;
	      if (!requestId) return;

	      activeRequestId = null;
	      activePendingBubble = null;
	      activeUserBubble = null;
	      activeUserMessageIndex = null;
	      setSendButtonMode("send");

	      setStatus("Cancelling…");
	      try {
	        await cancelChatApi(requestId);
	      } catch {
	        // ignore
	      }

	      try {
	        if (typeof userIndex === "number" && userIndex >= 0 && userIndex < chatHistory.length) {
	          const msg = chatHistory[userIndex];
	          if (msg?.role === "user") {
	            chatHistory.splice(userIndex, 1);
	            await saveChatHistory(chatHistory);
	          }
	        }
	      } catch {
	        // ignore
	      }

	      try {
	        if (userBubble && userBubble.isConnected) userBubble.remove();
	      } catch {
	        // ignore
	      }

	      if (pending && pending.isConnected) {
	        pending.className = "bubble error";
	        renderBubbleContent(pending, "assistant", "Cancelled.");
	      }
	      setStatus("Ready");
	    }

	    async function onSendOrCancel() {
	      if (activeRequestId) {
	        await onCancel();
	        return;
	      }
	      await onSend();
	    }

    async function ensureConfigured() {
      const cfg = await loadConfig();
      const ok = Boolean(cfg.token && cfg.model);
      noticeEl.classList.toggle("hidden", ok);
      return ok;
    }

    function renderAll() {
      chatEl.innerHTML = "";
      for (const m of chatHistory) addBubble(m.role, m.content);
    }

    async function onOpenSettings() {
      try {
        await chrome.runtime.openOptionsPage();
      } catch {
        chrome.runtime.sendMessage({ type: "OPEN_OPTIONS_PAGE" });
      }
    }

    async function onClear() {
      chatHistory = [];
      await saveChatHistory(chatHistory);
      renderAll();
      setStatus("Cleared");
    }

    async function onRefreshPage() {
      try {
        const cfg = await loadConfig();
        setStatus("Reading page…");
        cachedPageContext = getPageContext(
          typeof cfg.maxPageChars === "number" ? cfg.maxPageChars : MAX_PAGE_CHARS
        );
        setStatus("Page captured");
      } catch (err) {
        cachedPageContext = null;
        setStatus("Failed to read page");
        addBubble("error", `Failed to read page: ${err?.message || err}`);
      }
    }

	    async function onSend() {
	      if (activeRequestId) return;

	      const userText = String(inputEl.value || "");
	      if (!userText.trim()) return;
        await submitPrompt({
          displayText: userText,
          promptText: userText,
          includePage: includePageEl.checked
        });
	    }

      async function submitPrompt({ displayText, promptText, includePage }) {
        if (activeRequestId) return;

        const configured = await ensureConfigured();
        if (!configured) {
          setStatus("Open Settings to configure Token/Model");
          return;
        }

        const display = String(displayText || "").trim();
        const prompt = String(promptText || "").trim();
        if (!prompt) return;

        inputEl.value = "";
        if (shouldFocusInput) inputEl.focus();

        let pageContext = null;
        if (includePage) {
          try {
            const cfg = await loadConfig();
            setStatus("Reading page…");
            pageContext =
              cachedPageContext ||
              getPageContext(
                typeof cfg.maxPageChars === "number" ? cfg.maxPageChars : MAX_PAGE_CHARS
              );
            cachedPageContext = pageContext;
          } catch (err) {
            pageContext = null;
            addBubble("error", `Failed to read page: ${err?.message || err}`);
          }
        }

        const userContent = buildUserMessage(prompt, pageContext, includePage);
        const userMessage = { role: "user", content: userContent };
        chatHistory.push(userMessage);
        chatHistory = trimChatHistory(chatHistory);
        activeUserBubble = addBubble(
          "user",
          display,
          includePage ? "Includes page context" : ""
        );
        activeUserMessageIndex = chatHistory.length - 1;
        await saveChatHistory(chatHistory);

        const requestId = makeRequestId();
        setSendButtonMode("cancel");
        const pending = addBubble("assistant", "Thinking…");
        activeRequestId = requestId;
        activePendingBubble = pending;
        setStatus("Calling model…");

        try {
          const apiRes = await callChatApi(chatHistory, requestId);
          if (activeRequestId !== requestId) return;

          if (!apiRes?.ok) {
            pending.className = "bubble error";
            if (apiRes?.cancelled) {
              renderBubbleContent(pending, "assistant", "Cancelled.");
              setStatus("Ready");
              return;
            }
            renderBubbleContent(pending, "assistant", apiRes?.error || "Request failed.");
            setStatus("Error");
            return;
          }

          const assistantText = String(apiRes.content || "").trim() || "(empty response)";
          pending.className = "bubble assistant";
          renderBubbleContent(pending, "assistant", assistantText);
          chatHistory.push({ role: "assistant", content: assistantText });
          chatHistory = trimChatHistory(chatHistory);
          await saveChatHistory(chatHistory);
          setStatus("Ready");
        } catch (err) {
          if (activeRequestId !== requestId) return;
          pending.className = "bubble error";
          renderBubbleContent(pending, "assistant", err?.message || String(err));
          setStatus("Error");
        } finally {
          if (activeRequestId === requestId) {
            activeRequestId = null;
            activePendingBubble = null;
            activeUserBubble = null;
            activeUserMessageIndex = null;
            setSendButtonMode("send");
          }
          scrollToBottom();
        }
      }

      async function handleQuickAction(payload) {
        const kind = payload?.kind;
        const raw = String(payload?.text || "").trim();
        if (!raw) return;

        const clipped = clipSelectionForPrompt(raw);
        const selectionText = clipped.text;

        let promptInfo;
        if (kind === "translate") promptInfo = buildTranslatePrompt(selectionText);
        else if (kind === "explain") promptInfo = buildExplainPrompt(selectionText);
        else promptInfo = { title: "Action", prompt: selectionText };

        const preview = truncatePreview(raw, 240);
        const displayText = `${promptInfo.title}：${preview}`;
        await submitPrompt({
          displayText,
          promptText: promptInfo.prompt,
          includePage: false
        });
      }

	    settingsBtn.addEventListener("click", onOpenSettings);
	    closeBtn.addEventListener("click", () => unmountPanel());
	    clearBtn.addEventListener("click", onClear);
	    refreshBtn.addEventListener("click", onRefreshPage);
	    sendBtn.addEventListener("click", onSendOrCancel);
	    resizerEl.addEventListener("pointerdown", onResizerPointerDown);
	    resizerEl.addEventListener("pointermove", onResizerPointerMove);
	    resizerEl.addEventListener("pointerup", onResizerPointerUp);
	    resizerEl.addEventListener("pointercancel", onResizerPointerUp);
	    inputEl.addEventListener("keydown", (e) => {
	      if (e.key !== "Enter") return;
	      if (e.isComposing) return;
	      if (e.shiftKey) return; // allow newline
	      e.preventDefault();
	      onSendOrCancel();
	    });

	    const ui = el("div", { class: "wrap" }, [
	      resizerEl,
	      el("div", { class: "topbar" }, [
	        el("div", { class: "brand" }, [
	          el("div", { class: "title", text: "Codex Helper" }),
	          statusEl
	        ]),
	        el("div", { class: "actions" }, [settingsBtn, clearBtn, closeBtn])
	      ]),
	      el("div", { class: "main" }, [
	        noticeEl,
	        chatEl,
        el("div", { class: "controls" }, [
          el("label", { class: "toggle" }, [
            includePageEl,
            el("span", { text: "是否将当前网页作为上下文" })
          ]),
          refreshBtn
        ]),
        el("div", { class: "composer" }, [inputEl, sendBtn]),
	        el("div", { class: "footnote", text: "Tip: select text on the page — selection will be included if available." })
	      ])
	    ]);
	    wrapEl = ui;

    shadow.appendChild(style);
    shadow.appendChild(ui);
    document.documentElement.appendChild(root);

	    state.root = root;
	    state.previousPaddingRight = document.documentElement.style.paddingRight || "";
	    state.previousBoxSizing = document.documentElement.style.boxSizing || "";
	    state.previousWidth = document.documentElement.style.width || "";
	    state.previousOverflowX = document.documentElement.style.overflowX || "";
	    state.previousPanelWidthVar =
	      document.documentElement.style.getPropertyValue("--aihelper-panel-width") || "";

	    document.documentElement.style.setProperty("box-sizing", "border-box");
	    document.documentElement.style.setProperty("width", "100%");
	    document.documentElement.style.setProperty(
	      "padding-right",
	      `var(--aihelper-panel-width, ${DEFAULT_PANEL_WIDTH})`
	    );
	    document.documentElement.style.setProperty("overflow-x", "hidden");

	    (async () => {
	      try {
	        await initPanelWidth();
	        setStatus("Loading…");
	        chatHistory = await loadChatHistory();
	        renderAll();
	        await ensureConfigured();
        setStatus("Ready");
        if (shouldFocusInput) inputEl.focus();

        state.sendQuickAction = handleQuickAction;
        if (state.pendingQuickAction) {
          const pending = state.pendingQuickAction;
          state.pendingQuickAction = null;
          await handleQuickAction(pending);
        }
      } catch (err) {
        setStatus("Error");
        addBubble("error", err?.message || String(err));
      }
    })();
  }

  function unmountPanel() {
    const state = ensureSingleton();
    if (!state.mounted) return;
    state.mounted = false;
    state.sendQuickAction = null;

    try {
      if (state.root && state.root.isConnected) state.root.remove();
    } catch {
      // ignore
    }

	    try {
	      document.documentElement.style.paddingRight = state.previousPaddingRight || "";
	      document.documentElement.style.boxSizing = state.previousBoxSizing || "";
	      document.documentElement.style.width = state.previousWidth || "";
	      document.documentElement.style.overflowX = state.previousOverflowX || "";
	      if (state.previousPanelWidthVar) {
	        document.documentElement.style.setProperty("--aihelper-panel-width", state.previousPanelWidthVar);
	      } else {
	        document.documentElement.style.removeProperty("--aihelper-panel-width");
	      }
	    } catch {
	      // ignore
	    }
	  }

  function togglePanel() {
    const state = ensureSingleton();
    if (state.mounted) unmountPanel();
    else mountPanel({ focusInput: true });
  }

  async function syncQuickActionsEnabled() {
    try {
      const cfg = await loadConfig();
      const enabled = Boolean(cfg.enableSelectionActions);
      const state = ensureSingleton();
      state.quickActionsEnabled = enabled;
      if (enabled) mountQuickActions();
      else state.quickActions?.hide?.();
    } catch {
      const state = ensureSingleton();
      state.quickActionsEnabled = false;
      state.quickActions?.hide?.();
    }
  }

  syncQuickActionsEnabled();
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    if (!changes || typeof changes !== "object") return;
    if (!changes[CONFIG_KEY]) return;
    syncQuickActionsEnabled();
  });

  const state = ensureSingleton();
  if (!state.messageListenerMounted) {
    state.messageListenerMounted = true;
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === "AIHELPER_TOGGLE_PANEL") {
        togglePanel();
        sendResponse?.({ ok: true });
      }
    });
  }
})();
