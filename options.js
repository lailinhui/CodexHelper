import { DEFAULT_API_URL, DEFAULT_MODEL, loadConfig, saveConfig } from "./shared/config.js";

const els = {
  form: document.getElementById("form"),
  apiUrl: document.getElementById("apiUrl"),
  token: document.getElementById("token"),
  model: document.getElementById("model"),
  enableSelectionActions: document.getElementById("enableSelectionActions"),
  resetBtn: document.getElementById("resetBtn"),
  status: document.getElementById("status")
};

function setStatus(text) {
  els.status.textContent = text;
}

function normalizeApiUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return DEFAULT_API_URL;
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("API URL is invalid.");
  }
  if (u.protocol !== "https:") throw new Error("API URL must start with https://");
  return u.toString();
}

async function fillForm() {
  const cfg = await loadConfig();
  els.apiUrl.value = cfg.apiUrl || DEFAULT_API_URL;
  els.token.value = cfg.token || "";
  els.model.value = cfg.model || DEFAULT_MODEL;
  els.enableSelectionActions.value = Boolean(cfg.enableSelectionActions) ? "true" : "false";
}

async function onSubmit(e) {
  e.preventDefault();
  try {
    const apiUrl = normalizeApiUrl(els.apiUrl.value);
    const model = String(els.model.value || "").trim();
    if (!model) throw new Error("Model is required.");

    await saveConfig({
      apiUrl,
      token: String(els.token.value || ""),
      model,
      enableSelectionActions: String(els.enableSelectionActions.value) === "true"
    });

    setStatus("Saved.");
    setTimeout(() => setStatus(""), 1200);
  } catch (err) {
    setStatus(err?.message || String(err));
  }
}

async function onReset() {
  await saveConfig({
    apiUrl: DEFAULT_API_URL,
    token: "",
    model: DEFAULT_MODEL,
    enableSelectionActions: false
  });
  await fillForm();
  setStatus("Reset.");
  setTimeout(() => setStatus(""), 1200);
}

els.form.addEventListener("submit", onSubmit);
els.resetBtn.addEventListener("click", onReset);

fillForm();
