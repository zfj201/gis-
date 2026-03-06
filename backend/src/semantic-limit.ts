function chineseDigitValue(ch: string): number | null {
  switch (ch) {
    case "零":
      return 0;
    case "一":
      return 1;
    case "二":
    case "两":
      return 2;
    case "三":
      return 3;
    case "四":
      return 4;
    case "五":
      return 5;
    case "六":
      return 6;
    case "七":
      return 7;
    case "八":
      return 8;
    case "九":
      return 9;
    default:
      return null;
  }
}

function chineseUnitValue(ch: string): number | null {
  switch (ch) {
    case "十":
      return 10;
    case "百":
      return 100;
    case "千":
      return 1000;
    case "万":
      return 10000;
    default:
      return null;
  }
}

export function parseChineseNumeral(raw: string): number | undefined {
  const text = raw.trim();
  if (!text) {
    return undefined;
  }

  let total = 0;
  let section = 0;
  let number = 0;
  let hasAny = false;

  for (const ch of text) {
    const digit = chineseDigitValue(ch);
    if (digit !== null) {
      number = digit;
      hasAny = true;
      continue;
    }

    const unit = chineseUnitValue(ch);
    if (unit === null) {
      return undefined;
    }
    hasAny = true;

    if (unit === 10000) {
      section = (section + number) * unit;
      total += section;
      section = 0;
      number = 0;
      continue;
    }

    if (number === 0) {
      number = 1;
    }
    section += number * unit;
    number = 0;
  }

  if (!hasAny) {
    return undefined;
  }

  return total + section + number;
}

function parseCountToken(raw: string): number | undefined {
  // 兼容全角数字，避免“前５个”解析失败。
  const token = raw
    .trim()
    .replace(/[０-９]/g, (ch) => String(ch.charCodeAt(0) - "０".charCodeAt(0)));
  if (!token) {
    return undefined;
  }
  if (/^\d+$/.test(token)) {
    const value = Number(token);
    return Number.isFinite(value) ? value : undefined;
  }
  return parseChineseNumeral(token);
}

const countTokenPattern = "([零一二两三四五六七八九十百千万\\d０-９]+)";
const countUnitPattern = "(个|条|家|所|项|座|处)?";

// “前N”与“最近的N个”都视为显式 TopN。
const topPhrasePatterns = [
  new RegExp(`前\\s*${countTokenPattern}\\s*${countUnitPattern}`, "i"),
  new RegExp(`最近(?:的)?\\s*${countTokenPattern}\\s*${countUnitPattern}`, "i"),
  new RegExp(`${countTokenPattern}\\s*${countUnitPattern}\\s*最近(?:的)?`, "i")
];

export function parseTopLimitFromQuestion(question: string, cap: number): number | undefined {
  for (const pattern of topPhrasePatterns) {
    const match = question.match(pattern);
    if (!match?.[1]) {
      continue;
    }
    const parsed = parseCountToken(match[1]);
    if (parsed === undefined || !Number.isFinite(parsed) || parsed < 1) {
      continue;
    }
    return Math.min(Math.round(parsed), Math.max(1, cap));
  }
  return undefined;
}

export function stripTopLimitPhrase(text: string): string {
  let next = text.trim();
  for (const pattern of topPhrasePatterns) {
    next = next
      .replace(new RegExp(`^\\s*${pattern.source}\\s*`, "i"), "")
      .replace(new RegExp(`\\s*${pattern.source}\\s*$`, "i"), "")
      .trim();
  }
  return next;
}
