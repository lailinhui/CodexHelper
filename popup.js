import { loadConfig } from "./shared/config.js";
import {
  loadChatHistory,
  saveChatHistory,
  trimChatHistory
} from "./shared/history.js";

const els = {
  chat: document.getElementById("chat"),
  form: document.getElementById("form"),
  input: document.getElementById("input"),
  sendBtn: document.getElementById("sendBtn"),
  clearBtn: document.getElementById("clearBtn"),
  settingsBtn: document.getElementById("settingsBtn"),
  includePage: document.getElementById("includePage"),
  refreshPageBtn: document.getElementById("refreshPageBtn"),
  status: document.getElementById("status"),
  configNotice: document.getElementById("configNotice")
};

let chatHistory = [];
let cachedPageContext = null;

function setStatus(text) {
  els.status.textContent = text;
}

function scrollToBottom() {
  els.chat.scrollTop = els.chat.scrollHeight;
}

function addBubble(role, content, meta) {
  const bubble = document.createElement("div");
  bubble.className = `bubble ${role}`;
  bubble.textContent = content;
  if (meta) {
    const metaEl = document.createElement("div");
    metaEl.className = "meta";
    metaEl.textContent = meta;
    bubble.appendChild(metaEl);
  }
  els.chat.appendChild(bubble);
  scrollToBottom();
  return bubble;
}

function renderAll() {
  els.chat.innerHTML = "";
  for (const m of chatHistory) {
    addBubble(m.role, m.content);
  }
}

async function ensureConfigured() {
  const cfg = await loadConfig();
  const ok = Boolean(cfg.token);
  els.configNotice.classList.toggle("hidden", ok);
  return ok;
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab.");
  return tab.id;
}

async function fetchPageContext() {
  const cfg = await loadConfig();
  const tabId = await getActiveTabId();

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (maxChars) => {
      const selection = String(window.getSelection?.()?.toString?.() || "").trim();
      const title = document.title || "";
      const url = location.href || "";

      const rawText = document.body ? document.body.innerText || "" : "";
      const text = rawText.replace(/\\s+\\n/g, "\\n").trim();
      const clipped =
        text.length > maxChars ? text.slice(0, maxChars) + "\\n…(truncated)" : text;

      return {
        title,
        url,
        selection,
        content: clipped
      };
    },
    args: [typeof cfg.maxPageChars === "number" ? cfg.maxPageChars : 12000]
  });

  return result;
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
  return lines.join("\\n");
}

async function callChatApi(messages) {
  const res = await chrome.runtime.sendMessage({ type: "CHAT", messages });
  return res;
}

async function onSend(e) {
  e.preventDefault();
  const userText = els.input.value;
  if (!String(userText || "").trim()) return;

  const configured = await ensureConfigured();
  if (!configured) {
    setStatus("Open Settings to configure Token");
    return;
  }

  els.input.value = "";
  els.input.focus();

  let pageContext = null;
  if (els.includePage.checked) {
    try {
      setStatus("Reading page…");
      pageContext = cachedPageContext || (await fetchPageContext());
      cachedPageContext = pageContext;
    } catch (err) {
      pageContext = null;
      addBubble("error", `Failed to read page: ${err?.message || err}`);
    }
  }

  const userContent = buildUserMessage(userText, pageContext, els.includePage.checked);
  const userMessage = { role: "user", content: userContent };
  chatHistory.push(userMessage);
  chatHistory = trimChatHistory(chatHistory);
  addBubble("user", userText, els.includePage.checked ? "Includes page context" : "");
  await saveChatHistory(chatHistory);

  els.sendBtn.disabled = true;
  const pending = addBubble("assistant", "Thinking…");
  setStatus("Calling model…");

  try {
    const apiRes = await callChatApi(chatHistory);
    if (!apiRes?.ok) {
      pending.className = "bubble error";
      pending.textContent = apiRes?.error || "Request failed.";
      setStatus("Error");
      return;
    }

    const assistantText = String(apiRes.content || "").trim() || "(empty response)";
    pending.textContent = assistantText;
    pending.className = "bubble assistant";
    chatHistory.push({ role: "assistant", content: assistantText });
    chatHistory = trimChatHistory(chatHistory);
    await saveChatHistory(chatHistory);
    setStatus("Ready");
  } catch (err) {
    pending.className = "bubble error";
    pending.textContent = err?.message || String(err);
    setStatus("Error");
  } finally {
    els.sendBtn.disabled = false;
    scrollToBottom();
  }
}

async function onClear() {
  chatHistory = [];
  await saveChatHistory(chatHistory);
  renderAll();
  setStatus("Cleared");
}

async function onOpenSettings() {
  await chrome.runtime.openOptionsPage();
}

async function onRefreshPage() {
  try {
    setStatus("Reading page…");
    cachedPageContext = await fetchPageContext();
    setStatus("Page captured");
  } catch (err) {
    cachedPageContext = null;
    setStatus("Failed to read page");
    addBubble("error", `Failed to read page: ${err?.message || err}`);
  }
}

async function init() {
  setStatus("Loading…");
  chatHistory = await loadChatHistory();
  renderAll();
  await ensureConfigured();
  setStatus("Ready");
  els.input.focus();
}

els.form.addEventListener("submit", onSend);
els.clearBtn.addEventListener("click", onClear);
els.settingsBtn.addEventListener("click", onOpenSettings);
els.refreshPageBtn.addEventListener("click", onRefreshPage);
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    els.form.requestSubmit();
  }
});

init();
