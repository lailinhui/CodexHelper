import { buildAuthHeaders, loadConfig } from "./shared/config.js";

const inflightChats = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function fetchWithRetry(url, options, { retries = 1, retryDelayMs = 350 } = {}) {
  let lastError;
  const attemptCount = Math.max(0, Number.isFinite(retries) ? retries : 0) + 1;
  for (let attempt = 0; attempt < attemptCount; attempt++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      const aborted = options?.signal?.aborted || err?.name === "AbortError";
      if (aborted) throw err;
      lastError = err;
      if (attempt + 1 >= attemptCount) break;
      await sleep(retryDelayMs * (attempt + 1));
    }
  }
  throw lastError;
}

function makeRequestId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function toResponsesInput(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  return arr
    .filter((m) => m && typeof m === "object")
    .map((m) => ({
      role: m.role,
      content: [
        {
          type: m.role === "assistant" ? "output_text" : "input_text",
          text: String(m.content || "")
        }
      ]
    }));
}

function extractResponseText(data) {
  if (!data || typeof data !== "object") return "";

  if (typeof data.output_text === "string") return data.output_text;

  const output = Array.isArray(data.output) ? data.output : [];
  const chunks = [];
  for (const item of output) {
    const contents = Array.isArray(item?.content) ? item.content : [];
    for (const c of contents) {
      if (!c || typeof c !== "object") continue;
      if (c.type === "output_text" && typeof c.text === "string") chunks.push(c.text);
      if (c.type === "text" && typeof c.text === "string") chunks.push(c.text);
    }
  }
  if (chunks.length) return chunks.join("");

  return (
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.text ??
    ""
  );
}

function extractStreamDelta(payload) {
  if (!payload || typeof payload !== "object") return "";

  if (payload.type === "response.output_text.delta" && typeof payload.delta === "string") {
    return payload.delta;
  }

  const maybeText =
    payload?.delta?.content ??
    payload?.choices?.[0]?.delta?.content ??
    payload?.choices?.[0]?.delta?.text ??
    "";
  return typeof maybeText === "string" ? maybeText : "";
}

async function readSseTextStream(reader, initialBuffer) {
  const decoder = new TextDecoder();
  let buffer = String(initialBuffer || "");
  const textChunks = [];
  let doneText = "";
  let completedResponse = null;

  const flushEventBlock = (block) => {
    const lines = String(block || "").split("\n");
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return;

    const dataStr = dataLines.join("\n").trim();
    if (!dataStr || dataStr === "[DONE]") return;

    let payload;
    try {
      payload = JSON.parse(dataStr);
    } catch {
      textChunks.push(dataStr);
      return;
    }

    if (payload?.type === "response.completed" && payload?.response) {
      completedResponse = payload.response;
      return;
    }
    if (payload?.type === "response.output_text.done" && typeof payload.text === "string") {
      doneText = payload.text;
      return;
    }
    if (payload?.type === "response.error") {
      const msg = payload?.error?.message;
      throw new Error(typeof msg === "string" && msg.trim() ? msg : "Response error.");
    }

    const delta = extractStreamDelta(payload);
    if (delta) textChunks.push(delta);

    if (payload?.response && typeof payload.response === "object") {
      completedResponse = payload.response;
    }
  };

  while (true) {
    while (true) {
      const sepIndex = buffer.indexOf("\n\n");
      if (sepIndex === -1) break;
      const block = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);
      flushEventBlock(block);
    }

    const { value, done } = await reader.read();
    if (done) break;
    const decoded = decoder.decode(value, { stream: true });
    buffer += decoded.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }

  if (buffer.trim()) flushEventBlock(buffer);

  const streamedText = textChunks.join("");
  if (doneText.trim() && doneText.length >= streamedText.length) return doneText;
  if (streamedText.trim()) return streamedText;
  if (doneText.trim()) return doneText;

  const completedText = extractResponseText(completedResponse);
  return String(completedText || "");
}

async function readResponseText(res) {
  const body = res.body;
  if (!body) throw new Error("Missing response body.");

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const first = await reader.read();
  const firstChunk = first.value ? decoder.decode(first.value, { stream: true }) : "";
  const normalizedFirst = firstChunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trimmed = normalizedFirst.trimStart();

  const looksLikeJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  const looksLikeSse =
    trimmed.startsWith("data:") ||
    trimmed.startsWith("event:") ||
    trimmed.startsWith(":") ||
    normalizedFirst.includes("\ndata:") ||
    normalizedFirst.includes("\nevent:");

  if (!first.done && looksLikeSse && !looksLikeJson) {
    return readSseTextStream(reader, normalizedFirst);
  }

  // Default to JSON mode (some proxies omit content-type even for JSON).
  let all = normalizedFirst;
  if (!first.done) {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      all += decoder.decode(value, { stream: true });
    }
  }

  // If it was actually SSE but didn't match our early heuristic, try SSE parsing once.
  if (looksLikeSse && !looksLikeJson) {
    const fakeReader = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(all));
        controller.close();
      }
    }).getReader();
    return readSseTextStream(fakeReader, "");
  }

  let data;
  try {
    data = JSON.parse(all);
  } catch {
    throw new Error("Invalid JSON response from API.");
  }
  return extractResponseText(data);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return;

  if (message.type === "PING") {
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "OPEN_OPTIONS_PAGE") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "CANCEL_CHAT") {
    const requestId = typeof message.requestId === "string" ? message.requestId : "";
    const controller = inflightChats.get(requestId);
    if (controller) {
      controller.abort();
      inflightChats.delete(requestId);
      sendResponse({ ok: true, aborted: true });
      return;
    }
    sendResponse({ ok: true, aborted: false });
    return;
  }

  if (message.type === "CHAT") {
    (async () => {
      const requestId =
        typeof message.requestId === "string" && message.requestId.trim()
          ? message.requestId.trim()
          : makeRequestId();
      const controller = new AbortController();
      inflightChats.set(requestId, controller);

      try {
        const config = await loadConfig();
        const apiUrl = String(config.apiUrl || "").trim();
        if (!apiUrl) throw new Error("Missing API URL (internal error).");
        if (!config.token) throw new Error("Missing API token. Set it in Options.");
        if (!config.model) throw new Error("Missing model. Set it in Options.");

        const messages = Array.isArray(message.messages) ? message.messages : [];
        const systemPrompt = String(config.systemPrompt || "").trim();
        const input = toResponsesInput(messages);

        const temperature =
          typeof config.temperature === "number" ? config.temperature : 0.2;

	        const res = await fetchWithRetry(apiUrl, {
	          method: "POST",
	          headers: {
	            "Content-Type": "application/json",
	            Accept: "text/event-stream",
	            ...buildAuthHeaders(config.token)
	          },
	          signal: controller.signal,
	          body: JSON.stringify({
	            model: config.model,
	            input,
	            ...(systemPrompt ? { instructions: systemPrompt } : {}),
	            temperature,
	            max_output_tokens: 1024,
	            stream: true
	          })
	        });

        if (!res.ok) {
          const text = await res.text();
          try {
            const maybe = JSON.parse(text);
            const msg = maybe?.error?.message;
            if (typeof msg === "string" && msg.trim()) {
              sendResponse({ ok: false, error: `HTTP ${res.status}: ${msg}` });
              return;
            }
          } catch {
            // ignore
          }
          sendResponse({
            ok: false,
            error: `HTTP ${res.status}: ${text || res.statusText}`
          });
          return;
        }

        const content = await readResponseText(res);

        sendResponse({ ok: true, content: String(content || "") });
	      } catch (err) {
	        const isAbort =
	          err?.name === "AbortError" ||
	          /aborted/i.test(String(err?.message || "")) ||
	          /abort/i.test(String(err || ""));
	        if (isAbort) {
	          sendResponse({ ok: false, cancelled: true, error: "Cancelled." });
	          return;
	        }
	        const rawMsg = String(err?.message || err || "");
	        const msg =
	          rawMsg === "Failed to fetch"
	            ? "Network error: Failed to fetch (temporary connection issue or API unreachable)."
	            : rawMsg;
	        sendResponse({ ok: false, error: msg || "Request failed." });
	      } finally {
	        inflightChats.delete(requestId);
	      }
	    })();

    return true;
  }
});

async function togglePanelForTab(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "AIHELPER_TOGGLE_PANEL" });
    return;
  } catch {
    // ignored; injection path below
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["contentScript.js"]
    });
  } catch (err) {
    // e.g. chrome:// pages or blocked injection
    console.warn("Failed to inject Codex Helper panel:", err);
    return;
  }

  try {
    await chrome.tabs.sendMessage(tabId, { type: "AIHELPER_TOGGLE_PANEL" });
  } catch (err) {
    console.warn("Failed to toggle Codex Helper panel:", err);
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  const tabId = tab?.id;
  if (!tabId) return;
  await togglePanelForTab(tabId);
});
