/**
 * Линкът в СМС е изчистен, преди да бъде броен.
 *
 * Копиран от браузъра, линкът носи неща, които в СМС струват пари или чупят:
 *
 * - **Проследяване** (`utm_*`, `fbclid`, `gclid`…) — 60–200 знака, които
 *   обръщат едно СМС в три. Ние не ги четем в СМС, а получателят не ги иска.
 * - **Кирилица в адреса** — един знак извън GSM-7 прави *целия* текст UCS-2,
 *   тоест 70 знака вместо 160. Кодирана (`%D0…`), тя е латиница и адресът е
 *   същият.
 * - **`~ [ ] { } | \ ^`** — в GSM-7 те са двойни, а някои телефони режат линка
 *   на тях. Кодирани, са единични и линкът стига цял.
 * - **Пунктуация в края** — „виж https://site.bg/.“ точката не е част от адреса.
 *
 * Чист файл, без IO: редакторът брои изчистения текст, а сървърът праща точно
 * него — броеното е изпратеното. Същата логика има и в платформата (funnel-brand `lib/sms/links.ts`).
 */

export const SMS_URL_RE = /https?:\/\/[^\s<>"'„“”«»]+/gi;

const TRAILING_PUNCTUATION = new Set([
  ".",
  ",",
  ";",
  ":",
  "!",
  "?",
  "'",
  '"',
  "»",
  "”",
  "…",
]);
const CLOSING: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

const count = (text: string, char: string): number =>
  text.split(char).length - 1;

/**
 * Пунктуацията след адреса не е част от него. Затваряща скоба е — ако адресът
 * сам я е отворил (`…/wiki/Foo_(bar)`), иначе е скобата на изречението.
 */
const trimTrailingPunctuation = (raw: string): string => {
  let url = raw;
  while (url.length > 0) {
    const last = url[url.length - 1];
    if (TRAILING_PUNCTUATION.has(last)) {
      url = url.slice(0, -1);
      continue;
    }
    const opening = CLOSING[last];
    if (opening && count(url, last) > count(url, opening)) {
      url = url.slice(0, -1);
      continue;
    }
    break;
  }
  return url;
};

/** Параметри, които само мерят откъде е дошъл кликът. */
const TRACKING_PARAM_RE =
  /^(utm_[a-z_]+|fbclid|gclid|gbraid|wbraid|dclid|msclkid|yclid|ttclid|twclid|igshid|igsh|mibextid|mc_cid|mc_eid|_ga|_gl|_hsenc|_hsmi|li_fat_id|srsltid|ref_src|ref_url|si|spm|oly_anon_id|oly_enc_id|vero_id|wickedid|s_cid)$/i;

/** GSM-7 двойни или опасни за разпознаването на линк в телефона. */
const ENCODE_IN_URL: Record<string, string> = {
  "~": "%7E",
  "[": "%5B",
  "]": "%5D",
  "{": "%7B",
  "}": "%7D",
  "|": "%7C",
  "\\": "%5C",
  "^": "%5E",
  "`": "%60",
};

export type SmsUrlMatch = { url: string; index: number };

/** Адресите в текста, без пунктуацията след тях. */
export const findSmsUrls = (text: string): SmsUrlMatch[] => {
  const out: SmsUrlMatch[] = [];
  for (const match of text.matchAll(SMS_URL_RE)) {
    const url = trimTrailingPunctuation(match[0]);
    if (url.length > "https://".length)
      out.push({ url, index: match.index ?? 0 });
  }
  return out;
};

const encodeUnsafe = (value: string): string =>
  Array.from(value)
    .map((char) => {
      if (ENCODE_IN_URL[char]) return ENCODE_IN_URL[char];
      // Каквото е извън ASCII и е оцеляло след URL (рядко), се кодира тук.
      if (char.charCodeAt(0) > 0x7e) return encodeURIComponent(char);
      return char;
    })
    .join("");

/**
 * Един адрес, готов за СМС. Непарсим низ се връща само с изрязаната пунктуация —
 * по-добре нечист линк, отколкото изчезнал.
 */
export const cleanSmsUrl = (raw: string): string => {
  const trimmed = trimTrailingPunctuation(raw.trim());
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return encodeUnsafe(trimmed);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return encodeUnsafe(trimmed);

  const params = [...parsed.searchParams.keys()];
  const tracking = params.filter((key) => TRACKING_PARAM_RE.test(key));
  if (tracking.length > 0) {
    for (const key of new Set(tracking)) parsed.searchParams.delete(key);
  }

  // URL вече е превел кирилицата в хоста (punycode) и в пътя (%D0…).
  let href = parsed.href;
  if (href.endsWith("#")) href = href.slice(0, -1);
  // Голият домейн не иска наклонената черта — един знак е един знак.
  if (
    parsed.pathname === "/" &&
    !parsed.search &&
    !parsed.hash &&
    href.endsWith("/")
  ) {
    href = href.slice(0, -1);
  }
  return encodeUnsafe(href);
};

export type SmsLinkCleanup = {
  text: string;
  /** Всеки линк, който е сменен — за реда „ще тръгне като…“ в редактора. */
  changes: { from: string; to: string }[];
};

/** Всички линкове в текста, изчистени. Останалият текст не се пипа. */
export const cleanSmsLinksInText = (text: string): SmsLinkCleanup => {
  const changes: { from: string; to: string }[] = [];
  const matches = findSmsUrls(text);
  if (matches.length === 0) return { text, changes };

  let out = "";
  let cursor = 0;
  for (const { url, index } of matches) {
    const cleaned = cleanSmsUrl(url);
    out += text.slice(cursor, index) + cleaned;
    cursor = index + url.length;
    if (cleaned !== url && !changes.some((c) => c.from === url))
      changes.push({ from: url, to: cleaned });
  }
  out += text.slice(cursor);
  return { text: out, changes };
};

/** Сменя един адрес с друг (например с краткия) навсякъде в текста. */
export const replaceSmsUrl = (
  text: string,
  from: string,
  to: string,
): string => (from ? text.split(from).join(to) : text);
