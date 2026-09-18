importScripts("defaults.js", "settings.js");

const PROVIDERS = {
  openai: {
    label: "OpenAI",
    endpoint: "https://api.openai.com/v1/responses"
  },
  deepseek: {
    label: "DeepSeek",
    endpoint: "https://api.deepseek.com/chat/completions"
  }
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) {
    return false;
  }

  let operation;
  if (message.type === "TRANSLATE_TEXT" || message.type === "TRANSLATE_ANY_TEXT") {
    operation = translateMessage(message.text, {
      chatId: message.chatId,
      languageSettings: message.languageSettings,
      force: message.type === "TRANSLATE_ANY_TEXT",
      targetLanguage: message.targetLanguage,
      appendOriginal: message.appendOriginal
    });
  } else if (message.type === "OPENAI_SPEAK") {
    operation = speakWithOpenAI(message.text, message.options);
  } else if (message.type === "LIST_MODELS") {
    operation = listModels(message.provider, message.apiKey);
  } else if (message.type === "ELEVENLABS_VOICES") {
    operation = getElevenLabsVoices(message.apiKey);
  } else if (message.type === "ELEVENLABS_SPEAK") {
    operation = speakWithElevenLabs(message.text, message.options);
  } else {
    return false;
  }

  operation
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: readableError(error) }));

  return true;
});

async function getElevenLabsVoices(apiKeyOverride) {
  const settings = await getSettings();
  const apiKey = String(apiKeyOverride || settings.elevenLabsApiKey || "").trim();
  if (!apiKey) throw new Error("请先填写 ElevenLabs API Key。");

  const response = await fetch("https://api.elevenlabs.io/v2/voices?page_size=100", {
    headers: { "xi-api-key": apiKey }
  });
  const data = await parseJsonResponse(response);
  return {
    voices: (data.voices || []).map((voice) => ({
      id: voice.voice_id,
      name: voice.name,
      gender: voice.labels?.gender || "",
      accent: voice.labels?.accent || ""
    }))
  };
}

async function speakWithElevenLabs(text, options = {}) {
  const settings = await getSettings();
  const apiKey = String(options.apiKey || settings.elevenLabsApiKey || "").trim();
  const voiceId = String(options.voiceId || settings.elevenLabsVoiceId || "").trim();
  if (!apiKey) throw new Error("请先填写 ElevenLabs API Key。");
  if (!voiceId) throw new Error("请先选择 ElevenLabs 语音。");

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text: String(text || "").slice(0, 5000),
        model_id: options.model || settings.elevenLabsModel || "eleven_multilingual_v2",
        voice_settings: {
          speed: Math.max(0.7, Math.min(1.2, Number(options.rate || settings.speechRate || 1)))
        }
      })
    }
  );
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail?.detail?.message || detail?.detail?.status || `${response.status} ${response.statusText}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return { audioDataUrl: `data:audio/mpeg;base64,${btoa(binary)}` };
}

async function getSettings() {
  return chrome.storage.sync.get(WA_TRANSLATOR_DEFAULTS);
}

async function translateMessage(text, options = {}) {
  const settings = await readSettings(WA_TRANSLATOR_DEFAULTS, options.chatId);
  for(const key of ["targetLanguage","customLanguage"]) {
    if(typeof options.languageSettings?.[key] === "string") settings[key]=options.languageSettings[key];
  }
  const trimmed = String(text || "").trim();

  if (!trimmed) {
    return { translatedText: "", skipped: true, reason: "empty" };
  }

  if (!settings.enabled || settings.provider === "none") {
    return { translatedText: trimmed, skipped: true, reason: "disabled" };
  }

  const targetLanguage = String(options.targetLanguage || "").trim() || resolveTargetLanguage(settings);
  if (!targetLanguage) {
    return { translatedText: trimmed, skipped: true, reason: "no-target-language" };
  }

  if (!options.force && !containsChinese(trimmed)) {
    return { translatedText: trimmed, skipped: true, reason: "not-chinese" };
  }

  const translated = settings.provider === "deepseek"
    ? await translateWithDeepSeek(trimmed, targetLanguage, settings)
    : await translateWithOpenAI(trimmed, targetLanguage, settings);

  return {
    translatedText: (options.appendOriginal ?? settings.appendOriginal)
      ? `${translated}\n\n(Original: ${trimmed})`
      : translated,
    skipped: false
  };
}

function resolveTargetLanguage(settings) {
  const selected = String(settings.targetLanguage || "").trim();
  if (!selected || selected === "none") return "";
  if (selected === "custom") return String(settings.customLanguage || "").trim();
  return selected;
}

function containsChinese(text) {
  return /[\u3400-\u9fff\uf900-\ufaff]/u.test(text);
}

async function translateWithOpenAI(text, targetLanguage, settings) {
  const apiKey = String(settings.openaiApiKey || "").trim();
  if (!apiKey) {
    throw new Error("Please set your OpenAI API key in the extension popup.");
  }

  const model = String(settings.openaiModel || WA_TRANSLATOR_DEFAULTS.openaiModel).trim();
  const response = await fetch(PROVIDERS.openai.endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: settings.systemPrompt || WA_TRANSLATOR_DEFAULTS.systemPrompt
        },
        {
          role: "user",
          content: `Target language: ${targetLanguage}\n\nChinese message:\n${text}`
        }
      ]
    })
  });

  const data = await parseJsonResponse(response);
  return extractOpenAIText(data);
}

async function translateWithDeepSeek(text, targetLanguage, settings) {
  const apiKey = String(settings.deepseekApiKey || "").trim();
  if (!apiKey) {
    throw new Error("Please set your DeepSeek API key in the extension popup.");
  }

  const model = String(settings.deepseekModel || WA_TRANSLATOR_DEFAULTS.deepseekModel).trim();
  const response = await fetch(PROVIDERS.deepseek.endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: settings.systemPrompt || WA_TRANSLATOR_DEFAULTS.systemPrompt
        },
        {
          role: "user",
          content: `Target language: ${targetLanguage}\n\nChinese message:\n${text}`
        }
      ]
    })
  });

  const data = await parseJsonResponse(response);
  const textResult = data?.choices?.[0]?.message?.content;
  if (!textResult) {
    throw new Error("DeepSeek returned an empty translation.");
  }
  return cleanTranslation(textResult);
}

async function parseJsonResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data?.error?.message || data?.message || `${response.status} ${response.statusText}`;
    throw new Error(`API request failed: ${detail}`);
  }
  return data;
}

function extractOpenAIText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return cleanTranslation(data.output_text);
  }

  const chunks = [];
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === "output_text" && content?.text) {
        chunks.push(content.text);
      }
    }
  }

  const joined = chunks.join("").trim();
  if (!joined) {
    throw new Error("OpenAI returned an empty translation.");
  }
  return cleanTranslation(joined);
}

function cleanTranslation(text) {
  const trimmed = String(text || "").trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith("\u201c") && trimmed.endsWith("\u201d")) ||
    (trimmed.startsWith("\u2018") && trimmed.endsWith("\u2019"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function readableError(error) {
  return error instanceof Error ? error.message : String(error);
}

async function listModels(provider, apiKey) {
  if (!Object.hasOwn(PROVIDERS, provider)) throw new Error("不支持的服务商");
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("请先填写此服务商的 API Key");
  const endpoint = provider === "openai" ? "https://api.openai.com/v1/models" : "https://api.deepseek.com/models";
  const response = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000)
  });
  const data = await parseJsonResponse(response);
  if (!Array.isArray(data.data)) throw new Error("模型列表格式异常，请稍后刷新");
  return { models: data.data.filter(item => typeof item.id === "string").map(item => ({id:item.id, created:Number(item.created) || 0})) };
}

async function speakWithOpenAI(text, options = {}) {
  const settings = await getSettings();
  const key = String(options.apiKey || settings.openaiApiKey || "").trim();
  if (!key) throw new Error("请填写 OpenAI API Key 后使用 OpenAI 语音");
  const input = String(text || "").trim();
  if (!input || input.length > 4096) throw new Error("OpenAI 朗读需为 1–4096 个字符，请缩短文本");
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method:"POST", headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    signal:AbortSignal.timeout(60000),
    body:JSON.stringify({model:"gpt-4o-mini-tts", input, voice:options.voice || settings.openaiVoice || "coral", response_format:"mp3", speed:Math.max(.25,Math.min(4,Number(options.rate)||1))})
  });
  if (!response.ok) { await parseJsonResponse(response); }
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary="";
  for(let i=0;i<bytes.length;i+=0x8000) binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));
  return {audioDataUrl:`data:audio/mpeg;base64,${btoa(binary)}`};
}
