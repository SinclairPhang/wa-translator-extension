(() => {
  const INPUT_SELECTOR = [
    "footer [contenteditable='true'][role='textbox']",
    "footer [contenteditable='true'][data-tab]"
  ].join(",");
  const SEND_SELECTOR = [
    "footer button[aria-label='Send']",
    "footer button[aria-label='发送']",
    "footer span[data-icon='send']"
  ].join(",");

  const preparedDrafts = new WeakMap();
  function currentChatTitle() {
    const node=document.querySelector('#main [data-testid="conversation-info-header-chat-title"]');
    return (node?.textContent || "").normalize("NFKC").trim();
  }
  function titleChatId() {
    const title=currentChatTitle();
    if(!title) return "";
    // A visible duplicate name is ambiguous; do not share its stored settings.
    const rows=[...document.querySelectorAll('#pane-side [role="row"]')];
    const matches=rows.filter(row=>[...row.querySelectorAll('[title]')].some(n=>(n.getAttribute('title') || "").normalize("NFKC").trim()===title));
    if(matches.length>1) return "";
    return `title:${encodeURIComponent(title)}`;
  }
  function currentChatId() {
    const input = getComposerInput();
    let scope = input?.closest("#main, [role='main']") || document.querySelector("#main");
    if (!scope && input) {
      // Find the composer’s own conversation ancestor, never the sidebar.
      for(let parent=input.closest("footer")?.parentElement; parent && parent!==document.body; parent=parent.parentElement) {
        if(parent.querySelector(".message-in, .message-out")) { scope=parent; break; }
      }
    }
    if (!scope) return "";
    const bubbles = [...scope.querySelectorAll(".message-in, .message-out")];
    const nodes = bubbles.length ? bubbles.map(node => node.closest("[data-id]") || node.querySelector("[data-id]")).filter(Boolean)
      : [...scope.querySelectorAll("[data-id]")].filter(node=>!node.closest("blockquote, [data-testid*='quoted'], header, footer"));
    const ids=nodes.map(node=>node.getAttribute("data-id")?.match(/^(?:true|false)_([^_]+@(?:c\.us|s\.whatsapp\.net|g\.us|lid))_/i)?.[1]).filter(Boolean);
    if(ids.length) return ids.every(id=>id===ids[0]) ? ids[0] : "";
    return titleChatId();
  }

  let lastChatId = "";
  let temporaryLanguage = null;
  function languageContext() {
    return {id:currentChatId(), input:getComposerInput(), title:currentChatTitle()};
  }
  function sameLanguageContext(a,b) {
    return a.id===b.id && a.input===b.input && a.title===b.title;
  }
  function currentLanguageOverride() {
    if(temporaryLanguage && !sameLanguageContext(temporaryLanguage.context,languageContext())) temporaryLanguage=null;
    return temporaryLanguage?.settings || {};
  }
  async function setChatLanguage(updates) {
    const context=languageContext();
    temporaryLanguage={context,settings:{...updates}};
    if(!context.id) return false;
    try { await saveChatSettings(context.id, updates); return true; }
    catch (_) { return false; }
  }
  // Invalidate temporary choices before another sidebar conversation opens.
  document.addEventListener("pointerdown", event => {
    if(event.target?.closest?.("#pane-side [role='row'], #pane-side [data-id], #side [role='row']")) temporaryLanguage=null;
  },true);
  const chatSettings = async defaults => {
    const context=languageContext();
    const settings=await readSettings(defaults,context.id);
    return sameLanguageContext(context,languageContext()) ? {...settings,...currentLanguageOverride()} : settings;
  };
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if(message?.type === "GET_CHAT_CONTEXT") {
      respond({chatId:currentChatId(), label:currentChatTitle() || "当前聊天"});
    }
  });
  let busy = false;
  let internalInputChange = false;
  let allowNextSend = false;
  let lastHandledText = "";
  let lastHandledAt = 0;
  let controlsRoot = null;
  let speakingButton = null;
  let activeAudio = null;
  const translatedMessageCache = new Map();
  const messageActions = new WeakMap();
  const uiOwners = new WeakMap();
  const QUOTE_SELECTOR = [
    "[data-testid*='quoted']", "[data-testid*='quote']",
    "[data-testid*='reply-context']", "[data-icon='quoted-message']",
    "blockquote"
  ].join(",");
  const targetLanguageOptions = [
    ["French", "\u6cd5\u8bed"],
    ["English", "\u82f1\u8bed"],
    ["Portuguese", "\u8461\u8404\u7259\u8bed"],
    ["Spanish", "\u897f\u73ed\u7259\u8bed"],
    ["Arabic", "\u963f\u62c9\u4f2f\u8bed"],
    ["Lingala", "\u6797\u52a0\u62c9\u8bed"],
    ["Swahili", "\u65af\u74e6\u5e0c\u91cc\u8bed"],
    ["none", "\u4e0d\u7ffb\u8bd1"],
    ["custom", "\u81ea\u5b9a\u4e49"]
  ];

  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("click", onClick, true);
  chrome.storage.onChanged.addListener(onStorageChanged);
  setInterval(ensureControls, 1000);
  setInterval(ensureMessageTranslateButtons, 1600);
  observeMessages();

  showToast("WA translator loaded", "info", 1200);

  async function onKeyDown(event) {
    if (!isSendKey(event)) return;

    const input = getComposerInput();
    if (!input || !input.contains(document.activeElement)) return;

    if (allowNextSend && !event.isTrusted) return;
    if (!busy && preparedDrafts.get(input) === normalizeComposerText(getText(input))) {
      preparedDrafts.delete(input);
      return;
    }
    blockEvent(event);
    if (busy) return;

    await translateAndMaybeSend(input, null);
  }

  async function onClick(event) {
    const sendTarget = event.target?.closest?.(SEND_SELECTOR);
    if (!sendTarget) return;

    const input = getComposerInput();
    if (!input) return;

    if (allowNextSend && !event.isTrusted) return;
    if (!busy && preparedDrafts.get(input) === normalizeComposerText(getText(input))) {
      preparedDrafts.delete(input);
      return;
    }
    blockEvent(event);
    if (busy) return;

    await translateAndMaybeSend(input, sendTarget);
  }

  function blockEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  function isSendKey(event) {
    return event.key === "Enter"
      && !event.shiftKey
      && !event.ctrlKey
      && !event.altKey
      && !event.metaKey
      && !event.isComposing;
  }

  async function translateAndMaybeSend(input, originalSendTarget, modeOverride) {
    const originalText = normalizeComposerText(getText(input));
    if (!originalText) return;

    const now = Date.now();
    if (originalText === lastHandledText && now - lastHandledAt < 1200) {
      return;
    }
    lastHandledText = originalText;
    lastHandledAt = now;

    preparedDrafts.delete(input);
    const footer = input.closest("footer");
    const chatTitle = () => currentChatTitle();
    const initialChatTitle = chatTitle();
    let cancelled = false;
    const cancel = (event) => {
      if (event.isTrusted && !internalInputChange && (event.target === input || input.contains(event.target))) cancelled = true;
    };
    const cancelNavigation = (event) => {
      if (event.isTrusted && event.target?.closest?.("#pane-side [role='row'], #pane-side [data-id], #side [role='row']")) cancelled = true;
    };
    document.addEventListener("input", cancel, true);
    document.addEventListener("pointerdown", cancelNavigation, true);
    function assertCurrent() {
      if (cancelled || !input.isConnected || getComposerInput() !== input ||
          (initialChatTitle && chatTitle() && chatTitle() !== initialChatTitle)) {
        throw new Error("聊天或输入内容已变化，已取消本次翻译发送，请重新操作。");
      }
    }
    setBusy(true);
    showToast("Translating...", "info");

    try {
      const response = await sendRuntimeMessage({
        type: "TRANSLATE_TEXT",
        text: originalText
      });

      if (!response?.ok) {
        throw new Error(response?.error || "Translation failed.");
      }

      assertCurrent();
      if (normalizeComposerText(getText(input)) !== originalText) {
        throw new Error("输入内容已变化，已取消本次操作。");
      }
      const nextText = normalizeComposerText(response.translatedText || originalText);
      if (nextText !== originalText) {
        await setComposerText(input, nextText, assertCurrent);
        assertCurrent();
        const replaced = normalizeComposerText(getText(input));
        if (replaced !== nextText) {
          await setComposerTextFallback(input, nextText, assertCurrent);
          assertCurrent();
        }
        const finalText = normalizeComposerText(getText(input));
        if (finalText !== nextText) {
          await copyText(nextText);
          throw new Error("Could not replace the WhatsApp input. Translation copied; paste it manually.");
        }
        showToast("Translated", "success", 1000);
      } else if (response.skipped) {
        showToast(skipLabel(response.reason), "info", 1000);
      }

      const settings = await chatSettings({ sendMode: "auto" });
      assertCurrent();
      if (modeOverride === "preview" || (!modeOverride && settings.sendMode === "preview" && !response.skipped)) {
        preparedDrafts.set(input, nextText);
        showToast("译文已就绪，按回车或点击发送确认。", "success", 2600);
        return;
      }

      if (!await waitForComposerText(input, nextText)) {
        throw new Error("输入框内容未就绪，请手动确认后发送。");
      }
      await sleep(180);
      assertCurrent();
      if (normalizeComposerText(getText(input)) !== nextText) {
        throw new Error("输入内容已变化，已取消发送。");
      }
      allowNextSend = true;

      if (!clickSendButton(originalSendTarget)) {
        dispatchEnter(input);
      }
      await sleep(250);
    } catch (error) {
      showToast(error.message || String(error), "error", 4200);
    } finally {
      document.removeEventListener("input", cancel, true);
      document.removeEventListener("pointerdown", cancelNavigation, true);
      allowNextSend = false;
      setBusy(false);
    }
  }

  async function sendTranslatedFromButton() {
    const input = getComposerInput();
    if (!input || busy) return;
    if (preparedDrafts.get(input) === normalizeComposerText(getText(input))) {
      preparedDrafts.delete(input);
      await sendOriginalFromButton();
      return;
    }
    await translateAndMaybeSend(input, null, "auto");
  }

  async function sendOriginalFromButton() {
    const input = getComposerInput();
    if (!input || busy) return;

    const text = normalizeComposerText(getText(input));
    if (!text) return;

    allowNextSend = true;
    try {
      if (!clickSendButton(null)) {
        dispatchEnter(input);
      }
    } finally {
      await sleep(250);
      allowNextSend = false;
    }
  }

  function ensureControls() {
    const input = getComposerInput();
    const footer = input?.closest("footer");
    if (!footer || !input) return;
    if (controlsRoot?.isConnected && controlsRoot.parentElement === footer) {
      if(lastChatId !== currentChatId()) { lastChatId=currentChatId(); syncTargetLanguageSelect(controlsRoot.querySelector("select")); }
      return;
    }
    lastChatId=currentChatId();
    controlsRoot?.remove();
    document.getElementById("wa-translator-controls")?.remove();

    controlsRoot = document.createElement("div");
    controlsRoot.id = "wa-translator-controls";

    const originalButton = document.createElement("button");
    originalButton.type = "button";
    originalButton.textContent = "\u53d1\u9001\u539f\u6587";
    originalButton.addEventListener("click", (event) => {
      blockEvent(event);
      sendOriginalFromButton();
    });

    const translatedButton = document.createElement("button");
    translatedButton.type = "button";
    translatedButton.textContent = "\u53d1\u9001\u8bd1\u6587";
    translatedButton.dataset.primary = "true";
    translatedButton.addEventListener("click", (event) => {
      blockEvent(event);
      sendTranslatedFromButton();
    });

    const speakButton = document.createElement("button");
    speakButton.type = "button";
    speakButton.textContent = "\u25b6 \u6717\u8bfb\u8bd1\u6587";
    speakButton.dataset.idleLabel = "\u25b6 \u6717\u8bfb\u8bd1\u6587";
    speakButton.title = "\u7ffb\u8bd1\u5f53\u524d\u8f93\u5165\u4f46\u4e0d\u53d1\u9001\uff0c\u7136\u540e\u6717\u8bfb";
    speakButton.addEventListener("click", async (event) => {
      blockEvent(event);
      await speakComposerTranslation(speakButton);
    });

    const translateOnlyButton = document.createElement("button");
    translateOnlyButton.type = "button";
    translateOnlyButton.textContent = "只翻译";
    translateOnlyButton.title = "替换输入框内容，不发送；确认后按回车或点击发送";
    translateOnlyButton.addEventListener("click", async (event) => {
      blockEvent(event);
      const input = getComposerInput();
      if (input && !busy) await translateAndMaybeSend(input, null, "preview");
    });
    const targetSelect = createTargetLanguageSelect();
    controlsRoot.append(targetSelect, speakButton, translateOnlyButton, originalButton, translatedButton);
    footer.prepend(controlsRoot);
    syncTargetLanguageSelect(targetSelect);
  }

  function createTargetLanguageSelect() {
    const select = document.createElement("select");
    select.id = "wa-translator-target-language";
    select.title = "\u76ee\u6807\u8bed\u8a00";

    for (const [value, label] of targetLanguageOptions) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    }

    select.addEventListener("change", async (event) => {
      event.stopPropagation();
      const chatId=currentChatId();
      const chosen=select.value;
      const updates={targetLanguage:chosen};
      if(chosen === "custom") {
        const settings=await chatSettings({customLanguage:""});
        const language=window.prompt("输入此联系人的目标语言",settings.customLanguage || "");
        if(!language?.trim() || chatId!==currentChatId()) { await syncTargetLanguageSelect(select); return; }
        updates.customLanguage=language.trim();
      }
      const remembered=await setChatLanguage(updates);
      if(chatId!==currentChatId()) { await syncTargetLanguageSelect(select); return; }
      showToast(`${remembered ? "已记住此聊天的语言" : "已切换语言（本次聊天生效）"}：${updates.customLanguage || select.selectedOptions[0]?.textContent || chosen}`, "success", 1800);
    });

    select.addEventListener("click", (event) => event.stopPropagation());
    return select;
  }

  function onStorageChanged(changes, areaName) {
    if (areaName !== "sync" && areaName !== "local") return;
    const select=document.getElementById("wa-translator-target-language");
    if(select) syncTargetLanguageSelect(select);
  }

  async function syncTargetLanguageSelect(select) {
    const chatId=currentChatId();
    const settings = await chatSettings({ targetLanguage: "French" });
    if(chatId!==currentChatId() || !select?.isConnected) return;
    const value = settings.targetLanguage || "French";
    if (![...select.options].some((option) => option.value === value)) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      select.appendChild(option);
    }
    select.value = value;
  }

  function getComposerInput() {
    const activeEditable = document.activeElement?.closest?.(INPUT_SELECTOR);
    if (activeEditable && activeEditable.offsetParent !== null) {
      return activeEditable;
    }

    const candidates = [...document.querySelectorAll(INPUT_SELECTOR)]
      .filter((element) => element.offsetParent !== null);
    return candidates[candidates.length - 1] || null;
  }

  async function sendRuntimeMessage(message) {
    if (!globalThis.chrome?.runtime?.id) {
      throw new Error("Extension was reloaded. Refresh WhatsApp Web and try again.");
    }

    try {
      return await chrome.runtime.sendMessage({...message, chatId:currentChatId(), languageSettings:currentLanguageOverride()});
    } catch (error) {
      const detail = error?.message || String(error);
      if (/context invalidated|Extension context invalidated|receiving end does not exist/i.test(detail)) {
        throw new Error("Extension was reloaded. Refresh WhatsApp Web and try again.");
      }
      throw error;
    }
  }

  function getMessageBodyNode(message) {
    // A reply's quote precedes its own body. Never bind to the first text span.
    const candidates = [...message.querySelectorAll("span.selectable-text")]
      .filter((node) => findMessageContainer(node) === message
        && !node.closest(QUOTE_SELECTOR)
        && !node.closest(".wa-translator-message-actions, .wa-translator-message-result"));
    // Keep the outer span to preserve all formatting runs in the body.
    const outer = candidates.filter((node) => !candidates.some(
      (other) => other !== node && other.contains(node)
    ));
    return outer[outer.length - 1] || null;
  }

  function getMessageBody(message) {
    const node = getMessageBodyNode(message);
    return node ? normalizeComposerText(node.innerText || node.textContent || "") : "";
  }

  function cleanupMessageUI() {
    for (const node of document.querySelectorAll(".wa-translator-message-actions, .wa-translator-message-result")) {
      const owner = uiOwners.get(node);
      if (!owner || !owner.message.isConnected || !owner.message.contains(node)
          || owner.text !== getMessageBody(owner.message)) {
        node.remove();
      }
    }
  }

  function ensureMessageTranslateButtons() {
    cleanupMessageUI();
    const messages = new Set([...document.querySelectorAll("span.selectable-text")]
      .map(findMessageContainer).filter(Boolean));
    for (const message of messages) {
      const text = getMessageBody(message);
      const previous = messageActions.get(message);
      if (previous?.text === text && previous.actions.isConnected) continue;
      if (previous) {
        previous.actions.remove();
        message.querySelectorAll(".wa-translator-message-result").forEach((node) => node.remove());
        messageActions.delete(message);
      }
      if (!text) continue;
      const actions = addMessageActionButtons(message, text);
      messageActions.set(message, { text, actions });
    }
  }

  function observeMessages() {
    const observer = new MutationObserver(() => {
      window.clearTimeout(observeMessages.timer);
      observeMessages.timer = window.setTimeout(() => {
        ensureControls();
        ensureMessageTranslateButtons();
      }, 250);
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function findMessageContainer(node) {
    if (node.closest("header, footer, [role='dialog'], #pane-side, #side, .wa-translator-message-actions, .wa-translator-message-result")) return null;
    const bubble = node.closest(".message-in, .message-out");
    if (bubble) return bubble;
    // Fallback only for a message row with both a message ID and message metadata.
    // A generic data-id on its own is never enough to create controls.
    const row = node.closest("[data-id]");
    if (row && row.querySelector("[data-pre-plain-text]")) return row;
    return null;
  }

  function shouldOfferMessageTranslation(text) {
    if (!text || text.length < 2) return false;
    if (containsChinese(text)) return false;
    if (/^[\d\s:.,!?+\-()[\]/\\]+$/.test(text)) return false;
    return /\p{L}/u.test(text);
  }

  function containsChinese(text) {
    return /[\u3400-\u9fff\uf900-\ufaff]/u.test(text);
  }

  function addMessageActionButtons(message, text) {
    const actions = document.createElement("div");
    actions.className = "wa-translator-message-actions";

    const speakButton = document.createElement("button");
    speakButton.type = "button";
    speakButton.textContent = "\u25b6 \u53d1\u97f3";
    speakButton.dataset.idleLabel = "\u25b6 \u53d1\u97f3";
    speakButton.title = "\u6717\u8bfb\u8be5\u6761\u6d88\u606f";
    speakButton.addEventListener("click", (event) => {
      blockEvent(event);
      if (speakingButton === speakButton) {
        stopSpeaking();
      } else {
        const currentText = getMessageBody(message);
        if (currentText) speakText(currentText, detectSpeechLanguage(currentText), speakButton);
      }
    });
    actions.appendChild(speakButton);

    if (shouldOfferMessageTranslation(text)) {
      const translateButton = document.createElement("button");
      translateButton.type = "button";
      translateButton.textContent = "\u7ffb\u8bd1";
      translateButton.addEventListener("click", async (event) => {
        blockEvent(event);
        const currentText = getMessageBody(message);
        if (currentText) await translateExistingMessage(message, currentText, translateButton);
      });
      actions.appendChild(translateButton);
    }

    const body = getMessageBodyNode(message);
    if (!body?.parentElement) return actions;
    const content = body.closest("div.copyable-text[data-pre-plain-text]");
    if (content && message.contains(content)) content.appendChild(actions);
    else message.appendChild(actions);
    uiOwners.set(actions, { message, text });
    return actions;
  }

  async function translateExistingMessage(message, text, button) {
    const cacheKey = text;
    const existing = message.querySelector(".wa-translator-message-result[data-source-id='" + getMessageId(message) + "']");
    if (existing) {
      existing.hidden = !existing.hidden;
      return;
    }

    button.disabled = true;
    button.textContent = "\u7ffb\u8bd1\u4e2d...";

    try {
      const cached = translatedMessageCache.get(cacheKey);
      const translatedText = cached || await requestMessageTranslation(text);
      translatedMessageCache.set(cacheKey, translatedText);
      if (translatedMessageCache.size > 200) {
        translatedMessageCache.delete(translatedMessageCache.keys().next().value);
      }
      if (!message.isConnected || getMessageBody(message) !== text || !button.isConnected) return;
      showMessageTranslation(message, translatedText);
      button.textContent = "\u9690\u85cf\u8bd1\u6587";
    } catch (error) {
      button.textContent = "\u91cd\u8bd5";
      showToast(error.message || String(error), "error", 4200);
    } finally {
      button.disabled = false;
    }
  }

  async function requestMessageTranslation(text) {
    const response = await sendRuntimeMessage({
      type: "TRANSLATE_ANY_TEXT",
      text,
      targetLanguage: "Chinese",
      appendOriginal: false
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Translation failed.");
    }
    return normalizeComposerText(response.translatedText || "");
  }

  async function speakComposerTranslation(button) {
    if (speakingButton === button) {
      stopSpeaking();
      return;
    }

    const input = getComposerInput();
    const text = normalizeComposerText(getText(input));
    if (!text || busy) return;

    const settings = await chatSettings({
      targetLanguage: "French",
      customLanguage: ""
    });
    const targetLanguage = settings.targetLanguage === "custom"
      ? normalizeComposerText(settings.customLanguage)
      : settings.targetLanguage;

    if (!targetLanguage || targetLanguage === "none") {
      showToast("\u8bf7\u5148\u9009\u62e9\u76ee\u6807\u8bed\u8a00", "error", 2600);
      return;
    }

    button.disabled = true;
    button.textContent = "\u7ffb\u8bd1\u4e2d...";
    try {
      const response = await sendRuntimeMessage({
        type: "TRANSLATE_ANY_TEXT",
        text,
        targetLanguage,
        appendOriginal: false
      });
      if (!response?.ok) throw new Error(response?.error || "Translation failed.");
      speakText(normalizeComposerText(response.translatedText), targetLanguage, button);
    } catch (error) {
      button.textContent = "\u25b6 \u6717\u8bfb\u8bd1\u6587";
      showToast(error.message || String(error), "error", 4200);
    } finally {
      button.disabled = false;
    }
  }

  function showMessageTranslation(message, translatedText) {
    const result = document.createElement("div");
    result.className = "wa-translator-message-result";
    result.dataset.sourceId = getMessageId(message);

    const text = document.createElement("span");
    text.className = "wa-translator-message-result-text";
    text.textContent = translatedText || "\u65e0\u7ffb\u8bd1\u7ed3\u679c";

    const speakButton = document.createElement("button");
    speakButton.type = "button";
    speakButton.className = "wa-translator-speak-button";
    speakButton.textContent = "\u25b6";
    speakButton.dataset.idleLabel = "\u25b6";
    speakButton.title = "\u6717\u8bfb\u4e2d\u6587\u8bd1\u6587";
    speakButton.setAttribute("aria-label", "\u6717\u8bfb\u4e2d\u6587\u8bd1\u6587");
    speakButton.addEventListener("click", (event) => {
      blockEvent(event);
      if (speakingButton === speakButton) {
        stopSpeaking();
      } else {
        speakText(translatedText, "Chinese", speakButton);
      }
    });

    result.append(text, speakButton);
    uiOwners.set(result, { message, text: getMessageBody(message) });
    const actions = message.querySelector(".wa-translator-message-actions");
    if (actions) {
      actions.insertAdjacentElement("afterend", result);
    } else {
      message.appendChild(result);
    }
  }

  async function speakText(text, language, button) {
    stopSpeaking();
    speakingButton = button;
    button.textContent = "\u751f\u6210\u4e2d...";

    try {
      const settings = await chatSettings({
        speechEngine: "browser",
        openaiVoice:"coral",
        speechGender: "any",
        speechVoiceURI: "",
        browserVoiceURI: "",
        languageVoices: {},
        speechRate: "1",
        speechPitch: "1",
        elevenLabsApiKey: "",
        elevenLabsVoiceId: "",
        elevenLabsModel: "eleven_multilingual_v2"
      });

      const voiceProfile = settings.languageVoices?.[String(language || "").trim().toLowerCase()];
      if (settings.speechEngine === "elevenlabs" || settings.speechEngine === "openai") {
        const response = await sendRuntimeMessage({
          type: settings.speechEngine === "openai" ? "OPENAI_SPEAK" : "ELEVENLABS_SPEAK",
          text,
          options: {
            voice: voiceProfile?.openai || settings.openaiVoice || "coral",
            voiceId: voiceProfile?.elevenlabs || settings.elevenLabsVoiceId || settings.speechVoiceURI,
            model: settings.elevenLabsModel,
            rate: settings.speechRate
          }
        });
        if (!response?.ok) throw new Error(response?.error || "\u8bed\u97f3\u751f\u6210\u5931\u8d25");
        if (speakingButton !== button) return;
        activeAudio = new Audio(response.audioDataUrl);
        activeAudio.onended = activeAudio.onerror = () => resetSpeakingButton(button);
        button.textContent = "\u25a0 \u505c\u6b62";
        await activeAudio.play();
        return;
      }

      if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
        throw new Error("\u5f53\u524d\u6d4f\u89c8\u5668\u4e0d\u652f\u6301\u8bed\u97f3\u5408\u6210");
      }
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = speechLanguageCode(language);
      const voices = window.speechSynthesis.getVoices();
      const voice = voices.find((item) => item.voiceURI === (voiceProfile?.browser ?? (settings.browserVoiceURI || settings.speechVoiceURI)))
        || chooseVoiceByGender(voices, utterance.lang, settings.speechGender);
      if (voice) utterance.voice = voice;
      utterance.rate = Number(settings.speechRate) || 1;
      utterance.pitch = Number(settings.speechPitch) || 1;

      button.textContent = "\u25a0 \u505c\u6b62";
      utterance.onend = utterance.onerror = () => resetSpeakingButton(button);
      window.speechSynthesis.speak(utterance);
    } catch (error) {
      resetSpeakingButton(button);
      showToast(error.message || String(error), "error", 4200);
    }
  }

  function stopSpeaking() {
    window.speechSynthesis?.cancel();
    if (activeAudio) {
      activeAudio.pause();
      activeAudio.src = "";
      activeAudio = null;
    }
    if (speakingButton) resetSpeakingButton(speakingButton);
  }

  function resetSpeakingButton(button) {
    button.textContent = button.dataset.idleLabel || "\u25b6 \u53d1\u97f3";
    if (speakingButton === button) speakingButton = null;
  }

  function chooseVoiceByGender(voices, languageCode, gender) {
    const language = languageCode.split("-")[0].toLowerCase();
    const matches = voices.filter((voice) => voice.lang.toLowerCase().startsWith(language));
    if (gender === "any") return matches[0];
    const genderPattern = gender === "male"
      ? /\b(david|mark|george|guy|daniel|paul|henri|thomas|james|richard)\b/i
      : /\b(zira|julie|denise|hortense|susan|hazel|linda|catherine|yaoyao|huihui)\b/i;
    return matches.find((voice) => genderPattern.test(voice.name)) || matches[0];
  }

  function speechLanguageCode(language) {
    const normalized = String(language || "").toLowerCase();
    if (normalized.includes("chinese") || normalized.includes("\u4e2d\u6587")) return "zh-CN";
    if (normalized.includes("french") || normalized.includes("\u6cd5\u8bed")) return "fr-FR";
    if (normalized.includes("english") || normalized.includes("\u82f1\u8bed")) return "en-US";
    if (normalized.includes("portuguese") || normalized.includes("\u8461\u8404\u7259\u8bed")) return "pt-BR";
    if (normalized.includes("spanish") || normalized.includes("\u897f\u73ed\u7259\u8bed")) return "es-ES";
    if (normalized.includes("arabic") || normalized.includes("\u963f\u62c9\u4f2f\u8bed")) return "ar";
    if (normalized.includes("swahili") || normalized.includes("\u65af\u74e6\u5e0c\u91cc\u8bed")) return "sw";
    if (normalized.includes("lingala") || normalized.includes("\u6797\u52a0\u62c9\u8bed")) return "ln";
    return normalized || "en-US";
  }

  function detectSpeechLanguage(text) {
    if (containsChinese(text)) return "Chinese";
    if (/[\u0600-\u06ff]/u.test(text)) return "Arabic";
    if (/[ãõáâêôç]/iu.test(text)) return "Portuguese";
    if (/[ñ¿¡]/u.test(text)) return "Spanish";
    if (/[àâçéèêëîïôùûüÿœ]/iu.test(text)) return "French";

    const lower = ` ${text.toLowerCase()} `;
    if (/\b(le|la|les|un|une|des|est|sont|avec|pour|dans|bonjour|merci|vous|nous|je|tu)\b/u.test(lower)) {
      return "French";
    }
    return "English";
  }

  function getMessageId(message) {
    if (!message.dataset.waTranslatorId) {
      message.dataset.waTranslatorId = `m${Date.now()}${Math.random().toString(16).slice(2)}`;
    }
    return message.dataset.waTranslatorId;
  }

  function getText(input) {
    return input?.innerText || input?.textContent || "";
  }

  function normalizeComposerText(text) {
    return String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  async function setComposerText(input, text, guard = () => {}) {
    guard();
    input.focus();
    await clearComposer(input, guard);
    guard();
    if (await pasteByClipboardEvent(input, text)) return;
    guard();
    if (await insertByExecCommand(input, text)) return;
    guard();
    await setComposerTextFallback(input, text, guard);
  }

  function editComposerCommand(command, value) {
    internalInputChange = true;
    try { return document.execCommand(command, false, value); }
    finally { internalInputChange = false; }
  }

  async function clearComposer(input, guard = () => {}) {
    guard();
    input.focus();
    selectComposerContents(input);
    editComposerCommand("delete", null);
    input.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
    await sleep(80);

    guard();
    if (normalizeComposerText(getText(input))) {
      input.replaceChildren();
      input.textContent = "";
      input.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
      await sleep(80);
    }
  }

  async function pasteByClipboardEvent(input, text) {
    try {
      input.focus();
      selectComposerContents(input);
      const data = new DataTransfer();
      data.setData("text/plain", text);
      const event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data
      });
      input.dispatchEvent(event);
      await sleep(160);
      return normalizeComposerText(getText(input)) === normalizeComposerText(text);
    } catch (_error) {
      return false;
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_error) {
      return false;
    }
  }

  async function insertByExecCommand(input, text) {
    input.focus();
    selectComposerContents(input);
    editComposerCommand("delete", null);
    const ok = editComposerCommand("insertText", text);
    fireInputEvents(input);
    await sleep(160);
    return ok && normalizeComposerText(getText(input)) === normalizeComposerText(text);
  }

  async function setComposerTextFallback(input, text, guard = () => {}) {
    guard();
    input.focus();
    input.replaceChildren();
    input.textContent = "";
    const lines = String(text).split("\n");
    lines.forEach((line, index) => {
      if (index > 0) input.appendChild(document.createElement("br"));
      input.appendChild(document.createTextNode(line));
    });
    placeCaretAtEnd(input);
    fireInputEvents(input);
    await sleep(120);
    guard();
    fireInputEvents(input);
  }

  function selectComposerContents(input) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(input);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function placeCaretAtEnd(input) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function fireInputEvents(input) {
    input.dispatchEvent(new Event("input", {
      bubbles: true,
      cancelable: true
    }));
  }

  async function waitForComposerText(input, expectedText) {
    for (let i = 0; i < 10; i += 1) {
      if (normalizeComposerText(getText(input)) === expectedText) return true;
      await sleep(80);
    }
    return false;
  }

  function clickSendButton(preferredTarget) {
    const target = preferredTarget?.isConnected
      ? preferredTarget
      : document.querySelector(SEND_SELECTOR);
    if (!target) return false;
    const button = target.closest?.("button") || target;
    button.click();
    return true;
  }

  function dispatchEnter(input) {
    input.focus();
    const eventInit = {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13
    };
    input.dispatchEvent(new KeyboardEvent("keydown", eventInit));
    input.dispatchEvent(new KeyboardEvent("keyup", eventInit));
  }

  function setBusy(value) {
    busy = value;
    document.documentElement.dataset.waTranslatorBusy = value ? "true" : "false";
  }

  function showToast(message, type = "info", timeout = 0) {
    let toast = document.getElementById("wa-translator-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "wa-translator-toast";
      document.documentElement.appendChild(toast);
    }
    toast.textContent = message;
    toast.dataset.type = type;
    toast.classList.add("visible");

    clearTimeout(showToast.timer);
    if (timeout) {
      showToast.timer = setTimeout(() => toast.classList.remove("visible"), timeout);
    }
  }

  function skipLabel(reason) {
    const labels = {
      disabled: "Translator disabled",
      empty: "Empty message",
      "no-target-language": "No target language",
      "not-chinese": "No Chinese detected"
    };
    return labels[reason] || "Sending original";
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
