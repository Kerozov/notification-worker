/**
 * Колко СМС е един текст — сметнато така, както го брои операторът.
 *
 * „70 знака на кирилица, 160 на латиница“ е вярно само за чист текст. Два капана:
 *
 * - **Един знак сменя кодирането на целия текст.** „„Здравей““ с типографски
 *   кавички, „–“ или „’“ в иначе латински текст не са в GSM-7, и съобщението
 *   става UCS-2: 70 знака вместо 160. Същото прави кирилица в линка.
 * - **Някои знаци струват два.** `€ [ ] { } ~ ^ | \` са в разширената таблица на
 *   GSM-7 — escape + знак. „Цена 15€“ е 9 знака и 10 позиции.
 *
 * Многочастовото СМС губи място за заглавие на всяка част (153 / 67), и двойна
 * позиция или сурогатна двойка не се цепят между две части — затова частите се
 * пълнят една по една, не се делят с калкулатор.
 *
 * Чист файл, без IO: същото число вижда и редакторът, и сървърът преди
 * изпращане. Същият файл живее и в платформата (funnel-brand `lib/sms/segments.ts`).
 */

export type SmsEncoding = "GSM-7" | "UCS-2";

export type SmsSegmentCount = {
  encoding: SmsEncoding;
  /** Позиции: septets за GSM-7, UTF-16 единици за UCS-2. */
  units: number;
  /** Брой СМС, които операторът ще таксува. 0 за празен текст. */
  segments: number;
  /** Колко позиции събира едно СМС при това кодиране (160 / 70). */
  singleLimit: number;
  /** Колко позиции събира една част от многочастово СМС (153 / 67). */
  partLimit: number;
  /** Колко позиции остават в последната част. */
  remainingInSegment: number;
  /** Знаците (уникални, по реда на срещане), заради които текстът е UCS-2. */
  nonGsmChars: string[];
};

const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED = "\f^{}\\[~]|€";

const BASIC = new Set(Array.from(GSM_BASIC));
const EXTENDED = new Set(Array.from(GSM_EXTENDED));

export const GSM_SINGLE = 160;
export const GSM_PART = 153;
export const UCS2_SINGLE = 70;
export const UCS2_PART = 67;

/** Едно СМС е таванът, докато доставчикът не каже, че приема дълги. */
export const DEFAULT_SMS_MAX_SEGMENTS = 1;
/** Повече от това е писмо, не СМС — и всяка част се плаща. */
export const SMS_MAX_SEGMENTS_CAP = 6;

export const isGsmChar = (char: string): boolean =>
  BASIC.has(char) || EXTENDED.has(char);

/** 1 за основната таблица, 2 за разширената (escape + знак). */
const gsmCost = (char: string): number => (EXTENDED.has(char) ? 2 : 1);

/** Textarea праща `\r\n` на някои системи; операторът брои един нов ред. */
export const normalizeSmsNewlines = (text: string): string =>
  text.replace(/\r\n?/g, "\n");

/** Пълни частите една по една: двойна позиция не се цепи между две части. */
const packSegments = (
  costs: number[],
  single: number,
  part: number,
): { segments: number; lastFill: number } => {
  const total = costs.reduce((sum, cost) => sum + cost, 0);
  if (total === 0) return { segments: 0, lastFill: 0 };
  if (total <= single) return { segments: 1, lastFill: total };
  let segments = 1;
  let fill = 0;
  for (const cost of costs) {
    if (fill + cost > part) {
      segments += 1;
      fill = 0;
    }
    fill += cost;
  }
  return { segments, lastFill: fill };
};

export const countSmsSegments = (raw: string): SmsSegmentCount => {
  const text = normalizeSmsNewlines(raw);
  const chars = Array.from(text);
  const nonGsm: string[] = [];
  for (const char of chars) {
    if (!isGsmChar(char) && !nonGsm.includes(char)) nonGsm.push(char);
  }

  if (nonGsm.length === 0) {
    const costs = chars.map(gsmCost);
    const { segments, lastFill } = packSegments(costs, GSM_SINGLE, GSM_PART);
    const units = costs.reduce((sum, cost) => sum + cost, 0);
    const capacity = segments <= 1 ? GSM_SINGLE : GSM_PART;
    return {
      encoding: "GSM-7",
      units,
      segments,
      singleLimit: GSM_SINGLE,
      partLimit: GSM_PART,
      remainingInSegment: capacity - lastFill,
      nonGsmChars: [],
    };
  }

  // UCS-2: всеки знак извън BMP (емоджи) е сурогатна двойка — две позиции, неделими.
  const costs = chars.map((char) => char.length);
  const { segments, lastFill } = packSegments(costs, UCS2_SINGLE, UCS2_PART);
  const units = costs.reduce((sum, cost) => sum + cost, 0);
  const capacity = segments <= 1 ? UCS2_SINGLE : UCS2_PART;
  return {
    encoding: "UCS-2",
    units,
    segments,
    singleLimit: UCS2_SINGLE,
    partLimit: UCS2_PART,
    remainingInSegment: capacity - lastFill,
    nonGsmChars: nonGsm,
  };
};

/** Колко позиции събира текстът при даден таван на частите. */
export const smsCapacity = (
  encoding: SmsEncoding,
  maxSegments: number,
): number => {
  const max = Math.max(1, Math.floor(maxSegments));
  if (encoding === "GSM-7") return max === 1 ? GSM_SINGLE : GSM_PART * max;
  return max === 1 ? UCS2_SINGLE : UCS2_PART * max;
};

/** Таванът от средата, ограничен в разумното — грешна стойност не отваря шлюза. */
export const resolveSmsMaxSegments = (
  raw: string | number | null | undefined,
): number => {
  const value =
    typeof raw === "number"
      ? raw
      : Number.parseInt(String(raw ?? "").trim(), 10);
  if (!Number.isFinite(value) || value < 1) return DEFAULT_SMS_MAX_SEGMENTS;
  return Math.min(Math.floor(value), SMS_MAX_SEGMENTS_CAP);
};
