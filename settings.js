const CHAT_FIELDS = ['targetLanguage','customLanguage','sendMode','appendOriginal','speechEngine','speechGender','speechRate','speechPitch','languageVoices','browserVoiceURI','speechVoiceURI','elevenLabsVoiceId','openaiVoice'];
function chatSettingsOnly(settings) {
  return Object.fromEntries(CHAT_FIELDS.filter(key => Object.hasOwn(settings,key)).map(key=>[key,settings[key]]));
}
async function readSettings(defaults, chatId) {
  const global = await chrome.storage.sync.get(defaults);
  if (!chatId) return global;
  const key = `chat:${chatId}`;
  const local = await chrome.storage.local.get(key);
  return {...global,...chatSettingsOnly(local[key] || {})};
}
async function saveChatSettings(chatId, settings) {
  if (!chatId) throw new Error('暂未识别当前联系人，请打开一条聊天后重试。');
  const key = `chat:${chatId}`;
  const old = await chrome.storage.local.get(key);
  await chrome.storage.local.set({[key]:{...(old[key]||{}),...chatSettingsOnly(settings)}});
}
