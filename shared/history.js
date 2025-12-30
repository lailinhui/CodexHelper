const HISTORY_KEY = "aihelper_chat_history_v1";
const MAX_MESSAGES = 30;

function getArea() {
  return chrome.storage.session || chrome.storage.local;
}

export function trimChatHistory(history) {
  const arr = Array.isArray(history) ? history : [];
  if (arr.length <= MAX_MESSAGES) return arr;
  return arr.slice(arr.length - MAX_MESSAGES);
}

export async function loadChatHistory() {
  const area = getArea();
  const result = await area.get(HISTORY_KEY);
  const data = result?.[HISTORY_KEY];
  const arr = Array.isArray(data) ? data : [];
  return trimChatHistory(
    arr
      .filter((m) => m && typeof m === "object")
      .map((m) => ({ role: m.role, content: m.content }))
      .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
  );
}

export async function saveChatHistory(history) {
  const area = getArea();
  await area.set({ [HISTORY_KEY]: trimChatHistory(history) });
}

