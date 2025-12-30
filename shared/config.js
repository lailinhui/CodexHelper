export const DEFAULT_API_URL = "https://api.openai.com/v1/responses";
export const DEFAULT_MODEL = "gpt-5.2";
export const FIXED_SYSTEM_PROMPT =
  "You are a helpful assistant. When page context is provided, use it to answer accurately and concisely.";
export const FIXED_TEMPERATURE = 0.2;
export const FIXED_MAX_PAGE_CHARS = 12000;

export const DEFAULT_CONFIG = Object.freeze({
  apiUrl: DEFAULT_API_URL,
  token: "",
  model: DEFAULT_MODEL,
  enableSelectionActions: false
});

const CONFIG_KEY = "aihelper_config_v1";

export function buildAuthHeaders(token) {
  const t = String(token || "").trim();
  if (!t) return {};
  if (/^Bearer\\s+/i.test(t)) return { Authorization: t };
  return { Authorization: `Bearer ${t}` };
}

function normalizeApiUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return DEFAULT_API_URL;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return DEFAULT_API_URL;
    return u.toString();
  } catch {
    return DEFAULT_API_URL;
  }
}

export async function loadConfig() {
  const result = await chrome.storage.sync.get(CONFIG_KEY);
  const saved = result?.[CONFIG_KEY] && typeof result[CONFIG_KEY] === "object"
    ? result[CONFIG_KEY]
    : {};
  const apiUrl = normalizeApiUrl(saved.apiUrl);
  const token = typeof saved.token === "string" ? saved.token : "";
  const modelRaw = typeof saved.model === "string" ? saved.model : "";
  const model = modelRaw.trim() || DEFAULT_MODEL;
  const enableSelectionActions = Boolean(saved.enableSelectionActions);
  return {
    apiUrl,
    token,
    model,
    enableSelectionActions,
    systemPrompt: FIXED_SYSTEM_PROMPT,
    temperature: FIXED_TEMPERATURE,
    maxPageChars: FIXED_MAX_PAGE_CHARS
  };
}

export async function saveConfig(nextConfig) {
  const current = await loadConfig();
  const nextApiUrl =
    typeof nextConfig?.apiUrl === "string" ? normalizeApiUrl(nextConfig.apiUrl) : current.apiUrl;
  const nextToken =
    typeof nextConfig?.token === "string" ? nextConfig.token : current.token;
  const nextModel =
    typeof nextConfig?.model === "string" ? nextConfig.model : current.model;
  const nextEnableSelectionActions =
    typeof nextConfig?.enableSelectionActions === "boolean"
      ? nextConfig.enableSelectionActions
      : current.enableSelectionActions;
  await chrome.storage.sync.set({
    [CONFIG_KEY]: {
      apiUrl: nextApiUrl,
      token: nextToken,
      model: nextModel,
      enableSelectionActions: nextEnableSelectionActions
    }
  });
  return {
    ...current,
    apiUrl: nextApiUrl,
    token: nextToken,
    model: nextModel,
    enableSelectionActions: nextEnableSelectionActions
  };
}
