const WA_TRANSLATOR_DEFAULTS = {
  enabled: true,
  provider: "openai",
  targetLanguage: "French",
  customLanguage: "",
  openaiApiKey: "",
  openaiModel: "gpt-5.5",
  openaiCustomModel: "",
  deepseekApiKey: "",
  deepseekModel: "deepseek-v4-flash",
  sendMode: "auto",
  appendOriginal: false,
  speechEngine: "browser",
  openaiVoice: "coral",
  speechGender: "any",
  speechVoiceURI: "",
  browserVoiceURI: "",
  languageVoices: {},
  speechRate: "1",
  speechPitch: "1",
  elevenLabsApiKey: "",
  elevenLabsVoiceId: "",
  elevenLabsModel: "eleven_multilingual_v2",
  systemPrompt:
    "You are a professional message translator. Translate the user's message into the target language for WhatsApp. Keep names, numbers, URLs, emojis, and formatting. Return only the translated message."
};

if (typeof module !== "undefined") {
  module.exports = { WA_TRANSLATOR_DEFAULTS };
}
