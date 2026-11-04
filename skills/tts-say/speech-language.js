// Text dialect selection only. Shared Chinese wording defaults to Mandarin;
// traditional characters alone do not identify Cantonese.
const CANTONESE_CHARS = /[嘅冇唔啲咗喺佢哋嚟啱嘢乜咩啫噉咁畀俾攞搵嬲嗰瞓餸嚿]/u;
const CANTONESE_WORDS = /我係|你係|佢係|係咪|都係|就係|而家|依家|點解|点解|點樣|点样|多謝|多谢|得閒|得闲|返工|收工|食飯|食饭|飲茶|饮茶|靚仔|靓仔|靚女|靓女|冚家|睇下|睇吓/u;

export function detectSpeechLanguage(text) {
  const value = String(text ?? '');
  return CANTONESE_CHARS.test(value) || CANTONESE_WORDS.test(value) ? 'yue' : 'zh';
}

export function requestedSpeechLanguage(text) {
  // Match requests, not a mere mention of a language (e.g. “粤语是什么”).
  // Last instruction wins: “不要用粤语，改用普通话”.
  const requests = String(text ?? '').matchAll(/(不要|別|别|唔好|不用)?(?:再)?(?:用|改用|改成|換成|换成|轉成|转成|切換到|切换到|講|讲|說|说|讀|读|念)(?:一下|成|返|番|下)?\s*(粵語|粤语|廣東話|广东话|廣府話|广府话|普通話|普通话|國語|国语)/gu);
  let language = '';
  for (const match of requests) {
    language = /粵|粤|廣|广/u.test(match[2]) ? 'yue' : 'zh';
    if (match[1]) language = language === 'yue' ? 'zh' : 'yue';
  }
  return language;
}

export function resolveSpeechLanguage(text, { language = 'auto', mode = 'auto', context = '' } = {}) {
  if (!['auto', 'zh', 'yue'].includes(language)) throw new Error('language 只支持 auto、zh（普通话）、yue（粤语）');
  if (language !== 'auto') return language;
  if (mode === 'zh' || mode === 'yue') return mode;
  const requested = requestedSpeechLanguage(context);
  if (requested) return requested;
  // Dialect in a literal reading can differ from the surrounding request.
  if (detectSpeechLanguage(text) === 'yue') return 'yue';
  return detectSpeechLanguage(context);
}
