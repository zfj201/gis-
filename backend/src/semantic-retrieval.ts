import { promises as fs } from "node:fs";
import path from "node:path";
import type { LayerDescriptor, SpatialQueryDSL } from "@gis/shared";
import { spatialQueryDslSchema } from "@gis/shared";
import { config } from "./config.js";

interface SemanticCorpusLine {
  question?: unknown;
  dsl?: unknown;
  queryPlanWhere?: unknown;
  tags?: unknown;
  source?: unknown;
  qualityScore?: unknown;
}

interface SemanticSynonyms {
  intent?: Record<string, string[]>;
  operator?: Record<string, string[]>;
}

interface IndexedSemanticExample {
  question: string;
  dsl: SpatialQueryDSL;
  queryPlanWhere: string;
  tags: string[];
  source: string;
  qualityScore: number;
  tokenFreq: Map<string, number>;
}

export interface RetrievedSemanticExample {
  question: string;
  dsl: SpatialQueryDSL;
  queryPlanWhere: string;
  tags: string[];
  source: string;
  qualityScore: number;
  score: number;
  reasons: string[];
}

export interface SemanticRetrievalOptions {
  question: string;
  layers: LayerDescriptor[];
  topK?: number;
  maxExamples?: number;
}

export interface SemanticRetrievalResult {
  hits: RetrievedSemanticExample[];
  totalCorpus: number;
}

interface IndexedCorpusCache {
  path: string;
  mtimeMs: number;
  entries: IndexedSemanticExample[];
  idf: Map<string, number>;
}

interface SynonymCache {
  path: string;
  mtimeMs: number;
  value: SemanticSynonyms;
}

interface FailureHintCache {
  path: string;
  mtimeMs: number;
  hints: string[];
}

export interface SemanticFailureRecordInput {
  question: string;
  parserFailureReason: string;
  parserFailureDetail?: string;
  parserSource?: string;
  providerChain?: string;
  dsl?: SpatialQueryDSL | null;
}

const DEFAULT_SYNONYMS: SemanticSynonyms = {
  intent: {
    count: ["多少", "几个", "数量", "总数", "count"],
    group_stat: ["分组", "统计", "汇总", "维度"],
    buffer_search: ["附近", "周边", "内", "范围", "缓冲"],
    nearest: ["最近", "nearest"],
    relation: ["相交", "包含", "被包含", "相离", "接触", "重叠"],
    join_count: ["每个", "内", "数量"]
  },
  operator: {
    "=": ["为", "等于", "是", "就是", ":", "："],
    "!=": ["不等于", "不为", "不是", "!="],
    like: ["包含", "含有", "相关", "类似"],
    "<": ["小于", "低于", "少于", "以下"],
    "<=": ["不超过", "至多", "小于等于"],
    ">": ["大于", "高于", "多于", "以上", "超过"],
    ">=": ["不少于", "至少", "大于等于"],
    in: ["在", "属于", "in"],
    "not in": ["不在", "不属于", "not in"],
    between: ["介于", "之间", "between"],
    "is null": ["为空", "是空", "null"],
    "is not null": ["不为空", "非空", "not null"]
  }
};

let corpusCache: IndexedCorpusCache | null = null;
let corpusLoadingPromise: Promise<IndexedCorpusCache> | null = null;
let synonymCache: SynonymCache | null = null;
let synonymLoadingPromise: Promise<SynonymCache> | null = null;
let failureHintCache: FailureHintCache | null = null;
let failureHintLoadingPromise: Promise<FailureHintCache> | null = null;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeText(input: string): string {
  return input.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenizeQuestion(question: string): string[] {
  const normalized = normalizeText(question);
  if (!normalized) {
    return [];
  }
  const tokens = new Set<string>();
  const ascii = normalized.match(/[a-z0-9_]{2,}/g) ?? [];
  for (const token of ascii) {
    tokens.add(token);
  }
  const chineseWords = normalized.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  for (const word of chineseWords) {
    if (word.length <= 4) {
      tokens.add(word);
    }
    for (let i = 0; i < word.length - 1; i += 1) {
      tokens.add(word.slice(i, i + 2));
    }
    if (word.length >= 3) {
      for (let i = 0; i < word.length - 2; i += 1) {
        tokens.add(word.slice(i, i + 3));
      }
    }
  }
  return Array.from(tokens).slice(0, 120);
}

function buildTokenFreq(question: string): Map<string, number> {
  const freq = new Map<string, number>();
  for (const token of tokenizeQuestion(question)) {
    freq.set(token, (freq.get(token) ?? 0) + 1);
  }
  return freq;
}

function toTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item) => String(item ?? "").trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 24);
}

function normalizeQuality(raw: unknown): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return 0.75;
  }
  return clamp(parsed, 0, 1);
}

function parseCorpusLine(rawLine: string): IndexedSemanticExample | null {
  const text = rawLine.trim();
  if (!text) {
    return null;
  }
  let parsedLine: SemanticCorpusLine;
  try {
    parsedLine = JSON.parse(text) as SemanticCorpusLine;
  } catch {
    return null;
  }

  const question = String(parsedLine.question ?? "").trim();
  if (!question) {
    return null;
  }

  const dslParsed = spatialQueryDslSchema.safeParse(parsedLine.dsl);
  if (!dslParsed.success) {
    return null;
  }

  return {
    question,
    dsl: dslParsed.data,
    queryPlanWhere: String(parsedLine.queryPlanWhere ?? "").trim(),
    tags: toTags(parsedLine.tags),
    source: String(parsedLine.source ?? "manual").trim() || "manual",
    qualityScore: normalizeQuality(parsedLine.qualityScore),
    tokenFreq: buildTokenFreq(question)
  };
}

function buildIdf(entries: IndexedSemanticExample[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const entry of entries) {
    const uniqueTerms = new Set(entry.tokenFreq.keys());
    for (const term of uniqueTerms) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  const idf = new Map<string, number>();
  const docCount = Math.max(1, entries.length);
  for (const [term, count] of df.entries()) {
    const value = Math.log((docCount + 1) / (count + 1)) + 1;
    idf.set(term, value);
  }
  return idf;
}

async function safeReadFile(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function getFileMtimeMs(filePath: string): Promise<number> {
  try {
    const stat = await fs.stat(filePath);
    return stat.mtimeMs;
  } catch {
    return -1;
  }
}

async function loadCorpusCache(): Promise<IndexedCorpusCache> {
  const corpusPath = config.semanticCorpusPath;
  const mtimeMs = await getFileMtimeMs(corpusPath);
  if (corpusCache && corpusCache.path === corpusPath && corpusCache.mtimeMs === mtimeMs) {
    return corpusCache;
  }

  const raw = await safeReadFile(corpusPath);
  const lines = raw.split("\n");
  const entries = lines
    .map((line) => parseCorpusLine(line))
    .filter((item): item is IndexedSemanticExample => Boolean(item));
  const nextCache: IndexedCorpusCache = {
    path: corpusPath,
    mtimeMs,
    entries,
    idf: buildIdf(entries)
  };
  corpusCache = nextCache;
  return nextCache;
}

async function ensureCorpusCache(): Promise<IndexedCorpusCache> {
  if (!corpusLoadingPromise) {
    corpusLoadingPromise = loadCorpusCache()
      .catch((error) => {
        console.warn("[semantic-rag] 加载语料失败:", (error as Error).message);
        return {
          path: config.semanticCorpusPath,
          mtimeMs: -1,
          entries: [],
          idf: new Map<string, number>()
        } as IndexedCorpusCache;
      })
      .finally(() => {
        corpusLoadingPromise = null;
      });
  }
  return corpusLoadingPromise;
}

async function loadSynonymsCache(): Promise<SynonymCache> {
  const synonymsPath = config.semanticSynonymsPath;
  const mtimeMs = await getFileMtimeMs(synonymsPath);
  if (synonymCache && synonymCache.path === synonymsPath && synonymCache.mtimeMs === mtimeMs) {
    return synonymCache;
  }

  const raw = await safeReadFile(synonymsPath);
  let value: SemanticSynonyms = DEFAULT_SYNONYMS;
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as SemanticSynonyms;
      value = {
        intent: {
          ...(DEFAULT_SYNONYMS.intent ?? {}),
          ...(parsed.intent ?? {})
        },
        operator: {
          ...(DEFAULT_SYNONYMS.operator ?? {}),
          ...(parsed.operator ?? {})
        }
      };
    } catch {
      value = DEFAULT_SYNONYMS;
    }
  }
  const next: SynonymCache = {
    path: synonymsPath,
    mtimeMs,
    value
  };
  synonymCache = next;
  return next;
}

async function ensureSynonymsCache(): Promise<SemanticSynonyms> {
  if (!synonymLoadingPromise) {
    synonymLoadingPromise = loadSynonymsCache()
      .catch((error) => {
        console.warn("[semantic-rag] 加载同义词失败:", (error as Error).message);
        return {
          path: config.semanticSynonymsPath,
          mtimeMs: -1,
          value: DEFAULT_SYNONYMS
        } as SynonymCache;
      })
      .finally(() => {
        synonymLoadingPromise = null;
      });
  }
  const cache = await synonymLoadingPromise;
  return cache.value;
}

function inferIntentTags(question: string, synonyms: SemanticSynonyms): string[] {
  const tags = new Set<string>();
  const normalized = normalizeText(question);
  const intentMap = synonyms.intent ?? {};
  for (const [intent, words] of Object.entries(intentMap)) {
    if ((words ?? []).some((word) => normalized.includes(String(word).toLowerCase()))) {
      tags.add(`intent:${intent.toLowerCase()}`);
    }
  }
  if (/(多少|几个|数量|总数)/.test(question)) {
    tags.add("intent:count");
  }
  if (/(最近|nearest)/i.test(question)) {
    tags.add("intent:nearest");
  }
  if (/(附近|周边|米内|公里内|千米内)/.test(question)) {
    tags.add("intent:buffer_search");
  }
  if (/(分组|汇总|维度|按.+统计)/.test(question)) {
    tags.add("intent:group_stat");
  }
  return Array.from(tags);
}

function inferOperatorTags(question: string, synonyms: SemanticSynonyms): string[] {
  const tags = new Set<string>();
  const normalized = normalizeText(question);
  const opMap = synonyms.operator ?? {};
  for (const [op, words] of Object.entries(opMap)) {
    if ((words ?? []).some((word) => normalized.includes(String(word).toLowerCase()))) {
      tags.add(`op:${op}`);
    }
  }
  return Array.from(tags);
}

function inferLayerTags(question: string, layers: LayerDescriptor[]): string[] {
  const normalized = normalizeText(question);
  const tags = new Set<string>();
  for (const layer of layers) {
    const names = [layer.name, ...layer.aliases].map((item) => normalizeText(item)).filter(Boolean);
    if (names.some((name) => normalized.includes(name))) {
      tags.add(`layer:${layer.layerKey}`);
      continue;
    }
    if (/公园/.test(layer.name) && /公园/.test(question)) {
      tags.add(`layer:${layer.layerKey}`);
      continue;
    }
    if (/道路|街巷|路/.test(layer.name) && /道路|街巷|路/.test(question)) {
      tags.add(`layer:${layer.layerKey}`);
      continue;
    }
    if (/门牌|地址/.test(layer.name) && /门牌|地址/.test(question)) {
      tags.add(`layer:${layer.layerKey}`);
      continue;
    }
    if (/宗地|院落|地块/.test(layer.name) && /宗地|院落|地块/.test(question)) {
      tags.add(`layer:${layer.layerKey}`);
    }
  }
  return Array.from(tags);
}

function sourceWeight(source: string): number {
  const value = source.trim().toLowerCase();
  if (value === "production-failure-fixed") {
    return 0.8;
  }
  if (value === "manual") {
    return 0.6;
  }
  if (value === "case-regression") {
    return 0.4;
  }
  return 0.2;
}

function scoreEntry(
  entry: IndexedSemanticExample,
  queryTokens: string[],
  idf: Map<string, number>,
  intentTags: string[],
  operatorTags: string[],
  layerTags: string[]
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  for (const token of queryTokens) {
    const tf = entry.tokenFreq.get(token) ?? 0;
    if (!tf) {
      continue;
    }
    const tokenIdf = idf.get(token) ?? 1;
    score += tokenIdf * (1 + Math.log(1 + tf));
  }

  if (queryTokens.length > 0 && score > 0) {
    reasons.push(`词法重合=${score.toFixed(2)}`);
  }

  for (const tag of intentTags) {
    if (entry.tags.includes(tag)) {
      score += 1.6;
      reasons.push(`命中${tag}`);
    }
  }
  for (const tag of operatorTags) {
    if (entry.tags.includes(tag)) {
      score += 1.1;
      reasons.push(`命中${tag}`);
    }
  }
  for (const tag of layerTags) {
    if (entry.tags.includes(tag)) {
      score += 1.8;
      reasons.push(`命中${tag}`);
    }
  }

  const normalizedQuestion = normalizeText(entry.question);
  if (queryTokens.some((token) => token.length >= 2 && normalizedQuestion.includes(token))) {
    score += 0.8;
  }

  score += sourceWeight(entry.source);
  score *= 0.7 + entry.qualityScore * 0.6;
  return {
    score,
    reasons
  };
}

export async function retrieveSemanticExamples(
  options: SemanticRetrievalOptions
): Promise<SemanticRetrievalResult> {
  if (!config.semanticRagEnabled) {
    return {
      hits: [],
      totalCorpus: 0
    };
  }

  const [corpus, synonyms] = await Promise.all([ensureCorpusCache(), ensureSynonymsCache()]);
  if (!corpus.entries.length) {
    return {
      hits: [],
      totalCorpus: 0
    };
  }

  const topK = Math.max(1, options.topK ?? config.semanticRagTopK);
  const maxExamples = Math.max(1, options.maxExamples ?? config.semanticRagMaxExamples);
  const queryTokens = tokenizeQuestion(options.question);
  const intentTags = inferIntentTags(options.question, synonyms);
  const operatorTags = inferOperatorTags(options.question, synonyms);
  const layerTags = inferLayerTags(options.question, options.layers);

  const scored = corpus.entries
    .map((entry) => {
      const evaluated = scoreEntry(entry, queryTokens, corpus.idf, intentTags, operatorTags, layerTags);
      return {
        entry,
        score: evaluated.score,
        reasons: evaluated.reasons
      };
    })
    .filter((item) => item.score > 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const deduped: RetrievedSemanticExample[] = [];
  const seenQuestion = new Set<string>();
  for (const item of scored) {
    const key = normalizeText(item.entry.question);
    if (seenQuestion.has(key)) {
      continue;
    }
    seenQuestion.add(key);
    deduped.push({
      question: item.entry.question,
      dsl: item.entry.dsl,
      queryPlanWhere: item.entry.queryPlanWhere,
      tags: item.entry.tags,
      source: item.entry.source,
      qualityScore: item.entry.qualityScore,
      score: Number(item.score.toFixed(3)),
      reasons: item.reasons.slice(0, 4)
    });
    if (deduped.length >= maxExamples) {
      break;
    }
  }

  return {
    hits: deduped,
    totalCorpus: corpus.entries.length
  };
}

function mapFailureReasonToHint(reason: string): string | null {
  const key = reason.trim().toLowerCase();
  if (key === "schema_validation_failed") {
    return "输出必须是严格 JSON，且键固定为 actionable/confidence/followUpQuestion/dsl。";
  }
  if (key === "provider_non_json") {
    return "禁止输出解释性文本或 markdown，必须只输出 JSON 对象。";
  }
  if (key === "consistency_check_failed") {
    return "必须保持语义一致：统计问句用 count/group_stat，含“或”必须保留 OR，nearest 禁止目标层脏过滤。";
  }
  if (key === "provider_timeout") {
    return "优先给出简洁可执行 DSL，避免冗长输出。";
  }
  return null;
}

async function loadFailureHintCache(): Promise<FailureHintCache> {
  const failuresPath = config.semanticFailuresPath;
  const mtimeMs = await getFileMtimeMs(failuresPath);
  if (failureHintCache && failureHintCache.path === failuresPath && failureHintCache.mtimeMs === mtimeMs) {
    return failureHintCache;
  }
  const raw = await safeReadFile(failuresPath);
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  const recent = lines.slice(-500);
  const reasonCount = new Map<string, number>();
  for (const line of recent) {
    try {
      const parsed = JSON.parse(line) as { parserFailureReason?: unknown };
      const reason = String(parsed.parserFailureReason ?? "").trim();
      if (!reason) {
        continue;
      }
      reasonCount.set(reason, (reasonCount.get(reason) ?? 0) + 1);
    } catch {
      // ignore
    }
  }
  const hints = Array.from(reasonCount.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([reason]) => mapFailureReasonToHint(reason))
    .filter((item): item is string => Boolean(item))
    .slice(0, 4);
  const next: FailureHintCache = {
    path: failuresPath,
    mtimeMs,
    hints
  };
  failureHintCache = next;
  return next;
}

export async function getSemanticFailureHints(limit = 3): Promise<string[]> {
  if (!failureHintLoadingPromise) {
    failureHintLoadingPromise = loadFailureHintCache()
      .catch((error) => {
        console.warn("[semantic-rag] 加载失败提示失败:", (error as Error).message);
        return {
          path: config.semanticFailuresPath,
          mtimeMs: -1,
          hints: []
        } as FailureHintCache;
      })
      .finally(() => {
        failureHintLoadingPromise = null;
      });
  }
  const cache = await failureHintLoadingPromise;
  return cache.hints.slice(0, Math.max(1, limit));
}

export async function appendSemanticFailureRecord(input: SemanticFailureRecordInput): Promise<void> {
  if (!input.question.trim()) {
    return;
  }
  const record = {
    ts: new Date().toISOString(),
    question: input.question,
    parserFailureReason: input.parserFailureReason,
    parserFailureDetail: input.parserFailureDetail ?? "",
    parserSource: input.parserSource ?? "rule_fallback",
    providerChain: input.providerChain ?? "",
    dsl: input.dsl ?? null
  };
  const targetPath = config.semanticFailuresPath;
  try {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.appendFile(targetPath, `${JSON.stringify(record)}\n`, "utf8");
  } catch (error) {
    console.warn("[semantic-rag] 记录失败样本失败:", (error as Error).message);
  }
}
