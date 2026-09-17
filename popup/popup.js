const fields = [
  "enabled", "provider", "targetLanguage", "customLanguage", "openaiApiKey",
  "openaiModel", "openaiCustomModel", "deepseekApiKey", "deepseekModel", "sendMode", "appendOriginal",
  "speechEngine", "speechGender", "speechVoiceURI", "speechRate", "speechPitch",
  "elevenLabsApiKey", "elevenLabsVoiceId", "elevenLabsModel"
];

let browserVoices = [];
let elevenLabsVoices = [];
let previewAudio = null;
const voiceSelections = { browser: "", elevenlabs: "", openai:"coral" };
let popupChatId="";
let popupTabId;
let isWhatsAppTab=false;
const openaiVoices="alloy ash ballad coral echo fable nova onyx sage shimmer verse marin cedar".split(" ").map(id=>({id,name:id,gender:"",accent:"多语言"}));
let activeEngine = "browser";
let activeVoiceLanguage = "";
let languageVoices = {};
let legacyVoices = { browser: "", elevenlabs: "" };

function languageKey(value) { return String(value || "").trim().toLowerCase(); }
function selectedTarget() {
  const target = document.getElementById("targetLanguage").value;
  return target === "custom" ? document.getElementById("customLanguage").value : target;
}
function rememberLanguageVoices() {
  if (activeVoiceLanguage && activeVoiceLanguage !== "none") {
    languageVoices[activeVoiceLanguage] = { ...voiceSelections };
  }
}
function switchVoiceLanguage(value) {
  rememberLanguageVoices();
  activeVoiceLanguage = languageKey(value);
  const saved = Object.hasOwn(languageVoices, activeVoiceLanguage) ? languageVoices[activeVoiceLanguage] : legacyVoices;
  voiceSelections.openai = saved.openai || "coral";
  voiceSelections.browser = saved.browser || "";
  voiceSelections.elevenlabs = saved.elevenlabs || "";
  const select = document.getElementById("voiceLanguage");
  if (![...select.options].some(option => option.value === activeVoiceLanguage)) {
    select.add(new Option(value || "未指定语言", activeVoiceLanguage));
  }
  select.value = activeVoiceLanguage;
  refreshVoiceOptions();
}

document.addEventListener("DOMContentLoaded", init);

async function init() {
  try {
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    popupTabId=tab?.id;
    isWhatsAppTab=Boolean(tab?.url?.startsWith("https://web.whatsapp.com/"));
    if(isWhatsAppTab) {
      const context=await chrome.tabs.sendMessage(popupTabId,{type:"GET_CHAT_CONTEXT"});
      popupChatId=context?.chatId || "";
      document.getElementById("chatScope").textContent=popupChatId ? `当前聊天：${context.label}。目标语言在聊天输入框上方选择，选完自动记住；此处保存语音等设置。` : "当前保存默认设置；不会覆盖已记住的联系人语言。";
    } else document.getElementById("chatScope").textContent="当前编辑默认设置；已有联系人配置不受影响。";
  } catch(error) { document.getElementById("chatScope").textContent="暂时无法读取聊天，仍可保存 API、模型和默认语音设置。"; }
  const settings = await readSettings(WA_TRANSLATOR_DEFAULTS,popupChatId);
  voiceSelections.browser = settings.browserVoiceURI ||
    (settings.speechEngine === "browser" ? settings.speechVoiceURI : "") || "";
  voiceSelections.elevenlabs = settings.elevenLabsVoiceId ||
    (settings.speechEngine === "elevenlabs" ? settings.speechVoiceURI : "") || "";
  voiceSelections.openai=settings.openaiVoice || "coral";
  legacyVoices = { ...voiceSelections };
  languageVoices = { ...(settings.languageVoices || {}) };
  activeEngine = settings.speechEngine;
  populateForm(settings);
  if(popupChatId) {
    document.getElementById("targetLanguage").disabled=true;
    document.getElementById("customLanguage").disabled=true;
    document.getElementById("targetLanguage").title="请在聊天输入框上方选择语言，选择后自动保存";
  }
  switchVoiceLanguage(selectedTarget());
  bindEvents();
  setupModelDiscovery();
  loadBrowserVoices();
  if (settings.speechEngine === "elevenlabs" && settings.elevenLabsApiKey) {
    await loadElevenLabsVoices(settings.elevenLabsVoiceId);
  }
  speechSynthesis.onvoiceschanged = () => loadBrowserVoices();
  updateVisibility();
  updateRangeLabels();
}

function populateForm(settings) {
  for (const field of fields) {
    const element = document.getElementById(field);
    if (!element) continue;
    if (element.type === "checkbox") element.checked = Boolean(settings[field]);
    else {
      if (["openaiModel", "deepseekModel"].includes(field) && settings[field] &&
          ![...element.options].some(option => option.value === settings[field])) {
        element.add(new Option(`${settings[field]}（当前保存）`, settings[field]));
      }
      element.value = settings[field] ?? "";
    }
  }

  const modelSelect = document.getElementById("openaiModel");
  const savedModel = String(settings.openaiModel || "");
  if (savedModel && ![...modelSelect.options].some((option) => option.value === savedModel)) {
    modelSelect.value = "custom";
    document.getElementById("openaiCustomModel").value =
      settings.openaiCustomModel || savedModel;
  }
}

function bindEvents() {
  document.getElementById("save").addEventListener("click", save);
  document.getElementById("provider").addEventListener("change", updateVisibility);
  document.getElementById("openaiModel").addEventListener("change", updateVisibility);
  document.getElementById("targetLanguage").addEventListener("change", () => {
    updateVisibility();
    switchVoiceLanguage(selectedTarget());
  });
  document.getElementById("customLanguage").addEventListener("change", () => switchVoiceLanguage(selectedTarget()));
  document.getElementById("voiceLanguage").addEventListener("change", event => switchVoiceLanguage(event.target.value));
  document.getElementById("speechEngine").addEventListener("change", () => {
    activeEngine = document.getElementById("speechEngine").value;
    updateVisibility();
    refreshVoiceOptions();
  });
  document.getElementById("speechGender").addEventListener("change", () => refreshVoiceOptions());
  document.getElementById("speechRate").addEventListener("input", updateRangeLabels);
  document.getElementById("speechPitch").addEventListener("input", updateRangeLabels);
  document.getElementById("loadVoices").addEventListener("click", () => loadElevenLabsVoices());
  document.getElementById("speechVoiceURI").addEventListener("change", (event) => {
    voiceSelections[activeEngine] = event.target.value;
  });
  document.getElementById("previewVoice").addEventListener("click", previewVoice);
}

async function save() {
  const next = {};
  for (const field of fields) {
    const element = document.getElementById(field);
    if (!element) continue;
    next[field] = element.type === "checkbox" ? element.checked : element.value.trim();
  }
  if (next.openaiModel === "custom") {
    next.openaiModel = next.openaiCustomModel;
  }
  if (["openai", "deepseek"].includes(next.provider) && !next[`${next.provider}Model`]) {
    setStatus("请先选择模型再保存", true);
    return;
  }
  rememberLanguageVoices();
  next.languageVoices = languageVoices;
  // Preserve the old global voices as defaults for languages without a binding.
  next.browserVoiceURI = legacyVoices.browser;
  next.elevenLabsVoiceId = legacyVoices.elevenlabs;
  next.speechVoiceURI = legacyVoices[next.speechEngine];
  try {
    if(popupChatId) {
      // Global credentials/model changes must not depend on page connectivity.
      const global=Object.fromEntries(Object.entries(next).filter(([key])=>!CHAT_FIELDS.includes(key)));
      await chrome.storage.sync.set(global);
      let context;
      try { context=await chrome.tabs.sendMessage(popupTabId,{type:"GET_CHAT_CONTEXT"}); } catch (_) {}
      if(context?.chatId!==popupChatId) {
        setStatus("API 和模型已保存；聊天已变化，语音设置未保存，请重新打开面板",true);
        return;
      }
      const chatNext={...next};
      delete chatNext.targetLanguage;
      delete chatNext.customLanguage;
      await saveChatSettings(popupChatId,chatNext);
    } else {
      await chrome.storage.sync.set(next);
      setStatus("已保存默认设置；不影响已记住的联系人语言");
      return;
    }
    setStatus("已保存");
  } catch (error) {
    setStatus(`保存失败：${error.message}`, true);
  }
}

function updateVisibility() {
  const provider = document.getElementById("provider").value;
  const targetLanguage = document.getElementById("targetLanguage").value;
  const isOnline = document.getElementById("speechEngine").value !== "browser";
  document.getElementById("openaiSpeechNote").hidden = document.getElementById("speechEngine").value !== "openai";
  const isElevenLabs = document.getElementById("speechEngine").value === "elevenlabs";
  document.getElementById("openaiSection").classList.toggle("active", provider === "openai");
  document.getElementById("deepseekSection").classList.toggle("active", provider === "deepseek");
  document.querySelector("#openaiSection .provider-state").textContent = provider === "openai" ? "当前启用" : "";
  document.querySelector("#deepseekSection .provider-state").textContent = provider === "deepseek" ? "当前启用" : "";
  document.getElementById("openaiCustomModelRow").hidden =
    document.getElementById("openaiModel").value !== "custom";
  document.getElementById("customLanguageRow").hidden = targetLanguage !== "custom";
  document.getElementById("elevenLabsSection").hidden = !isElevenLabs;
  document.getElementById("pitchRow").classList.toggle("disabled", isOnline);
  document.getElementById("speechPitch").disabled = isOnline;
}

function loadBrowserVoices() {
  browserVoices = speechSynthesis.getVoices().map((voice) => ({
    id: voice.voiceURI,
    name: voice.name,
    gender: guessGender(voice.name),
    accent: voice.lang
  }));
  refreshVoiceOptions();
}

async function loadElevenLabsVoices() {
  try {
  const apiKey = document.getElementById("elevenLabsApiKey").value.trim();
  setStatus("加载中...");
  const response = await chrome.runtime.sendMessage({ type: "ELEVENLABS_VOICES", apiKey });
  if (!response?.ok) {
    setStatus(response?.error || "加载失败", true);
    return;
  }
  elevenLabsVoices = response.voices || [];
  refreshVoiceOptions();
  setStatus(`已加载 ${elevenLabsVoices.length} 个`);
  } catch (error) { setStatus(`加载失败：${error.message}`, true); }
}

function refreshVoiceOptions() {
  const select = document.getElementById("speechVoiceURI");
  const current = voiceSelections[activeEngine];
  const engine = document.getElementById("speechEngine").value;
  const gender = document.getElementById("speechGender").value;
  const source = engine === "openai" ? openaiVoices : engine === "elevenlabs" ? elevenLabsVoices : browserVoices;
  const filtered = source.filter((voice) => voice.id === current || gender === "any" || !voice.gender || voice.gender === gender);

  select.replaceChildren(new Option("自动选择", ""));
  for (const voice of filtered) {
    const detail = [voice.accent, voice.gender === "female" ? "女声" : voice.gender === "male" ? "男声" : ""]
      .filter(Boolean).join(" · ");
    select.add(new Option(`${voice.name}${detail ? `（${detail}）` : ""}`, voice.id));
  }
  if (current && ![...select.options].some((option) => option.value === current)) {
    select.add(new Option("已保存的语音（暂未加载）", current));
  }
  select.value = current;
}

async function previewVoice() {
  const button = document.getElementById("previewVoice");
  if (button.dataset.playing === "true") {
    stopPreview();
    return;
  }
  stopPreview();
  const engine = document.getElementById("speechEngine").value;
  const samples = {
    french: ["Bonjour, je suis votre assistant de traduction.", "fr-FR"],
    english: ["Hello, this is your selected voice.", "en-US"],
    chinese: ["你好，这是你为中文选择的声音。", "zh-CN"],
    portuguese: ["Olá, esta é a voz que você escolheu.", "pt-BR"],
    spanish: ["Hola, esta es la voz que has elegido.", "es-ES"],
    arabic: ["مرحبا، هذا هو الصوت الذي اخترته.", "ar"],
    swahili: ["Habari, hii ndiyo sauti uliyochagua.", "sw"],
    lingala: ["Mbote, sango nini?", "ln"]
  };
  const [sample, sampleLang] = samples[activeVoiceLanguage] || ["Hello, this is your selected voice.", "en-US"];
  button.disabled = true;
  button.textContent = "生成中...";

  try {
    if (engine === "elevenlabs" || engine === "openai") {
      const response = await chrome.runtime.sendMessage({
        type: engine === "openai" ? "OPENAI_SPEAK" : "ELEVENLABS_SPEAK",
        text: sample,
        options: {
          apiKey: document.getElementById(engine === "openai" ? "openaiApiKey" : "elevenLabsApiKey").value.trim(),
          voice: document.getElementById("speechVoiceURI").value || "coral",
          voiceId: document.getElementById("speechVoiceURI").value,
          model: document.getElementById("elevenLabsModel").value,
          rate: document.getElementById("speechRate").value
        }
      });
      if (!response?.ok) throw new Error(response?.error || "生成失败");
      previewAudio = new Audio(response.audioDataUrl);
      previewAudio.onended = resetPreviewButton;
      await previewAudio.play();
    } else {
      const utterance = new SpeechSynthesisUtterance(sample);
      const selected = browserVoices.find((voice) => voice.id === document.getElementById("speechVoiceURI").value);
      const nativeVoice = speechSynthesis.getVoices().find((voice) => voice.voiceURI === selected?.id);
      if (nativeVoice) utterance.voice = nativeVoice;
      utterance.lang = nativeVoice?.lang || sampleLang;
      utterance.rate = Number(document.getElementById("speechRate").value);
      utterance.pitch = Number(document.getElementById("speechPitch").value);
      utterance.onend = utterance.onerror = resetPreviewButton;
      speechSynthesis.speak(utterance);
    }
    button.textContent = "■ 停止";
    button.dataset.playing = "true";
    button.disabled = false;
  } catch (error) {
    setStatus(error.message, true);
    resetPreviewButton();
  }
}

function stopPreview() {
  speechSynthesis.cancel();
  if (previewAudio) {
    previewAudio.pause();
    previewAudio = null;
  }
  resetPreviewButton();
}

function resetPreviewButton() {
  const button = document.getElementById("previewVoice");
  if (!button) return;
  button.disabled = false;
  button.textContent = "▶ 试听";
  button.dataset.playing = "false";
}

function updateRangeLabels() {
  document.getElementById("speechRateValue").value = `${Number(document.getElementById("speechRate").value).toFixed(1)}×`;
  document.getElementById("speechPitchValue").value = Number(document.getElementById("speechPitch").value).toFixed(1);
}

function guessGender(name) {
  if (/\b(david|mark|george|guy|daniel|paul|henri|thomas|james|richard)\b/i.test(name)) return "male";
  if (/\b(zira|julie|denise|hortense|susan|hazel|linda|catherine|yaoyao|huihui)\b/i.test(name)) return "female";
  return "";
}

function setStatus(text, error = false) {
  const status = document.getElementById("status");
  status.textContent = text;
  status.dataset.error = String(error);
  clearTimeout(setStatus.timer);
  setStatus.timer = setTimeout(() => { status.textContent = ""; }, 3000);
}

const modelRequests = {openai:0, deepseek:0};
function setupModelDiscovery() {
  for (const provider of ["openai", "deepseek"]) {

    document.getElementById(`${provider}ApiKey`).addEventListener("change", () => refreshModels(provider));
  }
  document.getElementById("provider").addEventListener("change", () => refreshModels(document.getElementById("provider").value));
  for(const provider of ["openai","deepseek"]) refreshModels(provider);
}

function recentModelOptions(models, provider) {
  const candidates = [...new Map(models.filter(model => {
    if (provider === "deepseek") return /^deepseek-/i.test(model.id);
    return /^(gpt-|o\d)/i.test(model.id) && !/(audio|realtime|image|transcri|tts|search|codex|instruct|embedding|moderation)/i.test(model.id);
  }).map(model => [model.id, model])).values()];
  const generation = id => {
    const match = id.match(provider === "openai" ? /^gpt-(\d+(?:\.\d+)?)/i : /^deepseek-v(\d+(?:\.\d+)?)/i);
    return match ? match[1] : null;
  };
  const versions = [...new Set(candidates.map(model => generation(model.id)).filter(Boolean))]
    .sort((a,b) => b.localeCompare(a, undefined, {numeric:true})).slice(0,3);
  return candidates.filter(model => !generation(model.id) || versions.includes(generation(model.id)))
    .sort((a,b) => {
      const av=generation(a.id), bv=generation(b.id);
      if(av && bv && av!==bv) return bv.localeCompare(av,undefined,{numeric:true});
      if(av && !bv) return -1;
      if(!av && bv) return 1;
      return a.id.localeCompare(b.id,undefined,{numeric:true});
    });
}

function renderModelOptions(provider, models) {
  const select=document.getElementById(`${provider}Model`);
  const selected=select.value;
  select.replaceChildren(new Option("请选择模型", ""));
  for(const model of models) select.add(new Option(model.id,model.id));
  if(selected && selected!=="custom" && !models.some(model=>model.id===selected)) select.add(new Option(`${selected}（当前选择，未列入本次结果）`,selected));
  if(provider==="openai") select.add(new Option("自定义模型...","custom"));
  select.value=selected;
}
async function refreshModels(provider) {
  if(!Object.hasOwn(modelRequests,provider)) return;
  const request=++modelRequests[provider];
  const key=document.getElementById(`${provider}ApiKey`).value.trim();
  const status=document.getElementById(`${provider}ModelStatus`);
  const cacheKey=`models:${provider}`;
  const cached=(await chrome.storage.local.get(cacheKey))[cacheKey];
  if(request!==modelRequests[provider]) return;
  if(cached?.length) renderModelOptions(provider,cached);
  if(!key) {status.textContent="填写 API Key 后自动查询；保留已有列表。";return;}
  status.textContent="正在自动检查模型更新…";
  try {
    const response=await chrome.runtime.sendMessage({type:"LIST_MODELS",provider,apiKey:key});
    if(request!==modelRequests[provider]) return;
    if(!response?.ok) throw new Error(response?.error || "查询失败");
    const models=recentModelOptions(response.models || [],provider).map(model=>({id:model.id}));
    if(!models.length) throw new Error("未返回可识别的文本模型");
    if(JSON.stringify(cached)!==JSON.stringify(models)) {
      await chrome.storage.local.set({[cacheKey]:models});
      if(request!==modelRequests[provider]) return;
      renderModelOptions(provider,models);
      status.textContent=`模型列表已更新（${models.length} 个）。按名称显示最近三代，保留无版本号别名。`;
    } else status.textContent="模型列表无更新，保留原列表和选择。";
  } catch(error) {
    if(request===modelRequests[provider]) status.textContent=`自动查询失败：${error.message}。原列表与选择已保留。`;
  }
}
