import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

type AssertionResult = "PASS" | "WARN" | "FAIL";

interface ChatCaseExpect {
  requireQueryPlan?: boolean;
  requireDsl?: boolean;
  allowFollowUp?: boolean;
  maxLatencyMs?: number;
}

interface ChatCaseItem {
  id: string;
  question: string;
  tags?: string[];
  expect?: ChatCaseExpect;
  dataset?: string;
}

interface ChatResponse {
  dsl?: Record<string, unknown> | null;
  queryPlan?: Record<string, unknown> | null;
  features?: Array<Record<string, unknown>>;
  summary?: string;
  followUpQuestion?: string | null;
  message?: string;
  error?: string;
  parserSource?: string;
  parserFailureReason?: string | null;
  parserFailureDetail?: string | null;
  targetLayerName?: string;
  executionMeta?: Record<string, unknown> | null;
  semanticMeta?: {
    retrievalHits?: number;
    modelAttempts?: number;
    repaired?: boolean;
    decisionPath?: string;
    gateDecision?: "spatial" | "non_spatial" | "uncertain";
    candidateCount?: number;
    chosenCandidate?: "model" | "rule" | "repaired_model";
    candidateScore?: number;
  } | null;
}

interface CaseRecord {
  runId: string;
  dataset: string;
  caseId: string;
  index: number;
  total: number;
  question: string;
  tags: string[];
  startedAt: string;
  endedAt: string;
  latencyMs: number;
  attempts: number;
  http: {
    statusCode: number;
    contentType: string;
  };
  reply: {
    summary: string | null;
    followUpQuestion: string | null;
    message: string | null;
    error: string | null;
    featureCount: number;
  };
  targetLayer: {
    key: string | null;
    name: string | null;
    serviceId: string | null;
  };
  parser: {
    source: string | null;
    failureReason: string | null;
    failureDetail: string | null;
    isRuleFallback: boolean;
  };
  semanticMeta: {
    retrievalHits: number;
    modelAttempts: number;
    repaired: boolean;
    decisionPath: string;
    gateDecision: "spatial" | "non_spatial" | "uncertain" | "unknown";
    candidateCount: number;
    chosenCandidate: "model" | "rule" | "repaired_model" | "unknown";
    candidateScore: number;
  };
  dsl: Record<string, unknown> | null;
  queryPlan: Record<string, unknown> | null;
  executionMeta: Record<string, unknown> | null;
  fullResponse: Record<string, unknown> | null;
  assertion: {
    result: AssertionResult;
    failReasons: string[];
    warnReasons: string[];
  };
}

interface CliOptions {
  baseUrl: string;
  casesPath: string;
  casesSecondaryPath: string | null;
  maxCases: number | null;
  reportDir: string;
  timeoutMs: number;
  spawnBackend: boolean;
  healthTimeoutMs: number;
  fromRecordsPath: string | null;
}

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(backendRoot, "..");

function timestampToken(date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}_${hh}${mi}${ss}`;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseCliOptions(argv: string[]): CliOptions {
  const defaults: CliOptions = {
    baseUrl: "http://127.0.0.1:3300",
    casesPath: path.resolve(backendRoot, "testcases/chat-query-cases.json"),
    casesSecondaryPath: null,
    maxCases: null,
    reportDir: path.resolve(projectRoot, "docs/test-reports"),
    timeoutMs: 45_000,
    spawnBackend: true,
    healthTimeoutMs: 90_000,
    fromRecordsPath: null
  };

  const options = { ...defaults };
  for (const arg of argv) {
    if (arg.startsWith("--base-url=")) {
      options.baseUrl = arg.slice("--base-url=".length);
    } else if (arg.startsWith("--cases=")) {
      options.casesPath = path.resolve(projectRoot, arg.slice("--cases=".length));
    } else if (arg.startsWith("--report-dir=")) {
      options.reportDir = path.resolve(projectRoot, arg.slice("--report-dir=".length));
    } else if (arg.startsWith("--cases-secondary=")) {
      options.casesSecondaryPath = path.resolve(projectRoot, arg.slice("--cases-secondary=".length));
    } else if (arg.startsWith("--max-cases=")) {
      const parsed = Number(arg.slice("--max-cases=".length));
      options.maxCases = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
    } else if (arg.startsWith("--timeout-ms=")) {
      options.timeoutMs = Number(arg.slice("--timeout-ms=".length)) || options.timeoutMs;
    } else if (arg.startsWith("--spawn-backend=")) {
      options.spawnBackend = parseBool(arg.slice("--spawn-backend=".length), options.spawnBackend);
    } else if (arg.startsWith("--health-timeout-ms=")) {
      options.healthTimeoutMs =
        Number(arg.slice("--health-timeout-ms=".length)) || options.healthTimeoutMs;
    } else if (arg.startsWith("--from-records=")) {
      options.fromRecordsPath = path.resolve(projectRoot, arg.slice("--from-records=".length));
    }
  }
  return options;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function isBackendHealthy(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForBackendHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isBackendHealthy(baseUrl)) {
      return;
    }
    await sleep(1_000);
  }
  throw new Error(`后端健康检查超时（>${timeoutMs}ms）：${baseUrl}/health`);
}

function startBackendProcess(): ChildProcess {
  const child = spawn("npm", ["run", "dev:backend"], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    detached: process.platform !== "win32"
  });
  child.stdout?.on("data", (chunk) => {
    process.stdout.write(`[backend] ${String(chunk)}`);
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(`[backend] ${String(chunk)}`);
  });
  return child;
}

function stopBackendProcess(child: ChildProcess | null): void {
  if (!child || child.killed) {
    return;
  }
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // ignore and fallback
    }
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // ignore
  }
}

async function loadCases(filePath: string, dataset: string): Promise<ChatCaseItem[]> {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`用例文件格式错误：${filePath} 不是数组`);
  }

  const result: ChatCaseItem[] = [];
  for (const [index, item] of parsed.entries()) {
    if (!item || typeof item !== "object") {
      throw new Error(`用例第 ${index + 1} 条不是对象`);
    }
    const id = String((item as { id?: unknown }).id ?? "").trim();
    const question = String((item as { question?: unknown }).question ?? "").trim();
    if (!id || !question) {
      throw new Error(`用例第 ${index + 1} 条缺少 id 或 question`);
    }
    result.push({
      id,
      question,
      tags: Array.isArray((item as { tags?: unknown[] }).tags)
        ? (item as { tags: unknown[] }).tags.map((tag) => String(tag))
        : [],
      expect: (item as { expect?: ChatCaseExpect }).expect,
      dataset
    });
  }
  return result;
}

function safeTruncate(text: string | null | undefined, max = 180): string {
  const value = (text ?? "").replace(/\s+/g, " ").trim();
  if (!value) {
    return "";
  }
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

function escapeMdCell(value: unknown): string {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ")
    .trim();
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

function evaluateAssertion(
  entry: {
    statusCode: number;
    isJson: boolean;
    latencyMs: number;
    response: ChatResponse | null;
  },
  expect: ChatCaseExpect | undefined
): { result: AssertionResult; failReasons: string[]; warnReasons: string[] } {
  const failReasons: string[] = [];
  const warnReasons: string[] = [];
  const requireDsl = expect?.requireDsl ?? true;
  const requireQueryPlan = expect?.requireQueryPlan ?? false;
  const allowFollowUp = expect?.allowFollowUp ?? false;

  if (entry.statusCode !== 200) {
    failReasons.push(`HTTP 非 200：${entry.statusCode}`);
  }
  if (!entry.isJson) {
    failReasons.push("响应非 JSON");
  }
  if (!entry.response?.summary) {
    failReasons.push("响应缺少 summary");
  }
  if (requireDsl && !entry.response?.dsl) {
    failReasons.push("响应缺少 dsl");
  }
  if (requireQueryPlan && !entry.response?.queryPlan) {
    failReasons.push("响应缺少 queryPlan");
  }

  if (entry.response?.followUpQuestion && !allowFollowUp) {
    warnReasons.push("出现 followUpQuestion（进入澄清流程）");
  }
  if (entry.response?.parserSource === "rule_fallback") {
    const reason = entry.response.parserFailureReason ?? "unknown";
    warnReasons.push(`模型回退到规则：${reason}`);
  }
  if (typeof expect?.maxLatencyMs === "number" && entry.latencyMs > expect.maxLatencyMs) {
    warnReasons.push(`延迟超阈值：${entry.latencyMs}ms > ${expect.maxLatencyMs}ms`);
  }

  if (failReasons.length > 0) {
    return { result: "FAIL", failReasons, warnReasons };
  }
  if (warnReasons.length > 0) {
    return { result: "WARN", failReasons, warnReasons };
  }
  return { result: "PASS", failReasons, warnReasons };
}

async function requestChat(
  baseUrl: string,
  question: string,
  timeoutMs: number
): Promise<{
  statusCode: number;
  contentType: string;
  latencyMs: number;
  response: ChatResponse | null;
  rawBodyText: string;
  isJson: boolean;
}> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/api/chat/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
      signal: controller.signal
    });

    const contentType = res.headers.get("content-type") ?? "";
    const rawBodyText = await res.text();
    const latencyMs = Date.now() - startedAt;
    const isJson = contentType.includes("application/json");
    if (!isJson) {
      return {
        statusCode: res.status,
        contentType,
        latencyMs,
        response: null,
        rawBodyText,
        isJson
      };
    }
    let parsed: ChatResponse | null = null;
    try {
      parsed = JSON.parse(rawBodyText) as ChatResponse;
    } catch {
      parsed = null;
    }
    return {
      statusCode: res.status,
      contentType,
      latencyMs,
      response: parsed,
      rawBodyText,
      isJson
    };
  } finally {
    clearTimeout(timer);
  }
}

async function appendRecord(recordPath: string, record: CaseRecord): Promise<void> {
  await fs.appendFile(recordPath, `${JSON.stringify(record)}\n`, "utf8");
}

async function loadRecords(recordPath: string): Promise<CaseRecord[]> {
  const raw = await fs.readFile(recordPath, "utf8");
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const records: CaseRecord[] = [];
  for (const line of lines) {
    records.push(JSON.parse(line) as CaseRecord);
  }
  return records;
}

function buildMarkdownReport(
  records: CaseRecord[],
  meta: {
    runId: string;
    baseUrl: string;
    casesPath: string;
    casesSecondaryPath: string | null;
    maxCases: number | null;
    recordPath: string;
    startedAt: string;
    endedAt: string;
  }
): string {
  const total = records.length;
  const pass = records.filter((item) => item.assertion.result === "PASS").length;
  const warn = records.filter((item) => item.assertion.result === "WARN").length;
  const fail = records.filter((item) => item.assertion.result === "FAIL").length;
  const latencies = records.map((item) => item.latencyMs).filter((v) => Number.isFinite(v));
  const avgLatency = latencies.length
    ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
    : 0;
  const p95Latency = Math.round(percentile(latencies, 95));
  const medianLatency = Math.round(percentile(latencies, 50));
  const modelSuccessCount = records.filter(
    (item) => item.parser.source === "gemini" || item.parser.source === "openrouter" || item.parser.source === "groq"
  ).length;
  const modelSuccessRate = total > 0 ? ((modelSuccessCount / total) * 100).toFixed(1) : "0.0";
  const warnRatio = total > 0 ? ((warn / total) * 100).toFixed(1) : "0.0";
  const avgRetrievalHits = total > 0
    ? (records.reduce((sum, item) => sum + Number(item.semanticMeta?.retrievalHits ?? 0), 0) / total).toFixed(2)
    : "0.00";
  const avgModelAttempts = total > 0
    ? (records.reduce((sum, item) => sum + Number(item.semanticMeta?.modelAttempts ?? 0), 0) / total).toFixed(2)
    : "0.00";

  const parserSourceMap = new Map<string, number>();
  const fallbackReasonMap = new Map<string, number>();
  const decisionPathMap = new Map<string, number>();
  // service 维度统计用于观察新接入服务的稳定性，不与全局指标混淆。
  const serviceMap = new Map<string, { total: number; pass: number; warn: number; fail: number }>();
  const datasetMap = new Map<string, { total: number; pass: number; warn: number; fail: number }>();
  for (const item of records) {
    const parserSource = item.parser.source ?? "unknown";
    parserSourceMap.set(parserSource, (parserSourceMap.get(parserSource) ?? 0) + 1);
    const decisionPath = item.semanticMeta?.decisionPath || "unknown";
    decisionPathMap.set(decisionPath, (decisionPathMap.get(decisionPath) ?? 0) + 1);
    if (item.parser.isRuleFallback) {
      const reason = item.parser.failureReason ?? "unknown";
      fallbackReasonMap.set(reason, (fallbackReasonMap.get(reason) ?? 0) + 1);
    }
    const dataset = item.dataset || "baseline";
    const datasetStat = datasetMap.get(dataset) ?? { total: 0, pass: 0, warn: 0, fail: 0 };
    datasetStat.total += 1;
    datasetStat[item.assertion.result.toLowerCase() as "pass" | "warn" | "fail"] += 1;
    datasetMap.set(dataset, datasetStat);
    const serviceId = item.targetLayer.serviceId ?? "unknown";
    const serviceStat = serviceMap.get(serviceId) ?? { total: 0, pass: 0, warn: 0, fail: 0 };
    serviceStat.total += 1;
    serviceStat[item.assertion.result.toLowerCase() as "pass" | "warn" | "fail"] += 1;
    serviceMap.set(serviceId, serviceStat);
  }

  const parserSourceRows = Array.from(parserSourceMap.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `| ${escapeMdCell(key)} | ${count} |`)
    .join("\n");

  const decisionPathRows = Array.from(decisionPathMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([key, count]) => `| ${escapeMdCell(key)} | ${count} |`)
    .join("\n");

  const fallbackReasonRows =
    Array.from(fallbackReasonMap.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => `| ${escapeMdCell(key)} | ${count} |`)
      .join("\n") || "| 无 | 0 |";

  const datasetRows = Array.from(datasetMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dataset, stats]) => {
      const warnRate = stats.total > 0 ? `${((stats.warn / stats.total) * 100).toFixed(1)}%` : "0.0%";
      return `| ${escapeMdCell(dataset)} | ${stats.total} | ${stats.pass} | ${stats.warn} | ${stats.fail} | ${warnRate} |`;
    })
    .join("\n");
  const serviceRows = Array.from(serviceMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([serviceId, stats]) => {
      const passRate = stats.total > 0 ? `${((stats.pass / stats.total) * 100).toFixed(1)}%` : "0.0%";
      const warnRate = stats.total > 0 ? `${((stats.warn / stats.total) * 100).toFixed(1)}%` : "0.0%";
      return `| ${escapeMdCell(serviceId)} | ${stats.total} | ${stats.pass} | ${stats.warn} | ${stats.fail} | ${passRate} | ${warnRate} |`;
    })
    .join("\n");

  const issueRows =
    records
      .filter((item) => item.assertion.result !== "PASS")
      .map((item) => {
        const reasons = [...item.assertion.failReasons, ...item.assertion.warnReasons]
          .map((reason) => safeTruncate(reason, 120))
          .join("；");
        return `| ${item.dataset || "baseline"} | ${item.caseId} | ${item.assertion.result} | ${escapeMdCell(item.question)} | ${escapeMdCell(
          item.parser.source
        )} | ${escapeMdCell(item.parser.failureReason ?? "")} | ${escapeMdCell(
          safeTruncate(item.parser.failureDetail, 120)
        )} | ${item.latencyMs} | ${escapeMdCell(item.semanticMeta?.decisionPath ?? "unknown")} | ${escapeMdCell(reasons)} |`;
      })
      .join("\n") || "| - | - | - | - | - | - | - | - | - | - |";

  const detailRows = records
    .map((item) => {
      const reasons = [...item.assertion.failReasons, ...item.assertion.warnReasons].join("；");
      return `| ${item.dataset || "baseline"} | ${item.caseId} | ${item.assertion.result} | ${item.http.statusCode} | ${item.latencyMs} | ${escapeMdCell(
        item.parser.source
      )} | ${escapeMdCell(item.targetLayer.serviceId ?? "-")} | ${escapeMdCell(item.parser.failureReason ?? "")} | ${escapeMdCell(
        safeTruncate(item.parser.failureDetail, 80)
      )} | ${item.attempts} | ${Number(item.semanticMeta?.retrievalHits ?? 0)} | ${Number(item.semanticMeta?.modelAttempts ?? 0)} | ${escapeMdCell(
        item.semanticMeta?.decisionPath ?? "unknown"
      )} | ${escapeMdCell(item.semanticMeta?.gateDecision ?? "unknown")} | ${item.semanticMeta?.candidateScore.toFixed(1)} | ${escapeMdCell(
        item.semanticMeta?.chosenCandidate ?? "unknown"
      )} | ${escapeMdCell(item.targetLayer.name ?? item.targetLayer.key ?? "-")} | ${item.reply.featureCount} | ${escapeMdCell(
        item.reply.followUpQuestion ?? ""
      )} | ${escapeMdCell(safeTruncate(reasons, 120))} | ${escapeMdCell(safeTruncate(item.reply.summary, 120))} |`;
    })
    .join("\n");

  return `# Chat Query Regression Report

## 运行信息

- Run ID: \`${meta.runId}\`
- Start: \`${meta.startedAt}\`
- End: \`${meta.endedAt}\`
- Base URL: \`${meta.baseUrl}\`
- Cases File (baseline): \`${meta.casesPath}\`
- Cases File (variant): \`${meta.casesSecondaryPath ?? "未提供"}\`
- Max Cases: \`${meta.maxCases ?? "ALL"}\`
- Record File: \`${meta.recordPath}\`

## 总览统计

| 指标 | 值 |
|---|---:|
| Total | ${total} |
| PASS | ${pass} |
| WARN | ${warn} |
| FAIL | ${fail} |
| Avg Latency (ms) | ${avgLatency} |
| Median Latency (ms) | ${medianLatency} |
| P95 Latency (ms) | ${p95Latency} |
| Model Success Rate | ${modelSuccessRate}% |
| WARN Ratio | ${warnRatio}% |
| Avg Retrieval Hits | ${avgRetrievalHits} |
| Avg Model Attempts | ${avgModelAttempts} |

## 数据集对比

| dataset | total | pass | warn | fail | warnRate |
|---|---:|---:|---:|---:|---:|
${datasetRows || "| baseline | 0 | 0 | 0 | 0 | 0.0% |"}

## 服务维度统计

| serviceId | total | pass | warn | fail | passRate | warnRate |
|---|---:|---:|---:|---:|---:|---:|
${serviceRows || "| unknown | 0 | 0 | 0 | 0 | 0.0% | 0.0% |"}

## 解析来源分布

| parserSource | count |
|---|---:|
${parserSourceRows || "| 无 | 0 |"}

## 决策链路分布

| decisionPath | count |
|---|---:|
${decisionPathRows || "| 无 | 0 |"}

## 规则回退原因分布

| parserFailureReason | count |
|---|---:|
${fallbackReasonRows}

## FAIL/WARN 清单

| dataset | caseId | result | question | parserSource | parserFailureReason | parserFailureDetail | latencyMs | decisionPath | reasons |
|---|---|---|---|---|---|---|---:|---|---|
${issueRows}

## 全量明细

| dataset | caseId | result | status | latencyMs | parserSource | serviceId | parserFailureReason | parserFailureDetail | attempts | retrievalHits | modelAttempts | decisionPath | gateDecision | candidateScore | chosenCandidate | targetLayer | featureCount | followUp | reasons | summary |
|---|---|---|---:|---:|---|---|---|---|---:|---:|---:|---|---|---:|---|---|---:|---|---|---|
${detailRows}
`;
}

async function runAndRecordCases(options: CliOptions): Promise<{
  reportPath: string;
  recordPath: string;
}> {
  const primaryCases = await loadCases(options.casesPath, "baseline");
  const secondaryCases = options.casesSecondaryPath
    ? await loadCases(options.casesSecondaryPath, "variant")
    : [];
  const mergedCases = [...primaryCases, ...secondaryCases];
  const cases = options.maxCases ? mergedCases.slice(0, options.maxCases) : mergedCases;
  if (cases.length === 0) {
    throw new Error("用例文件为空。");
  }

  await fs.mkdir(options.reportDir, { recursive: true });
  const runId = `chat_regression_${timestampToken()}`;
  const recordPath = path.join(options.reportDir, `${runId}.records.jsonl`);
  const reportPath = path.join(options.reportDir, `${runId}.report.md`);
  const runStartedAt = new Date().toISOString();
  let backendProcess: ChildProcess | null = null;

  try {
    const healthyBeforeStart = await isBackendHealthy(options.baseUrl);
    if (!healthyBeforeStart && options.spawnBackend) {
      backendProcess = startBackendProcess();
    }
    await waitForBackendHealth(options.baseUrl, options.healthTimeoutMs);

    for (let i = 0; i < cases.length; i += 1) {
      const testCase = cases[i];
      const startedAt = new Date().toISOString();
      let requestResult: Awaited<ReturnType<typeof requestChat>> | null = null;
      let requestError: Error | null = null;
      let attempts = 0;
      const maxAttempts = 2;
      while (attempts < maxAttempts) {
        attempts += 1;
        requestResult = null;
        requestError = null;
        try {
          requestResult = await requestChat(options.baseUrl, testCase.question, options.timeoutMs);
          break;
        } catch (error) {
          requestError = error as Error;
          const message = requestError.message ?? "";
          const retryableTimeout = /aborted|timeout/i.test(message);
          if (!(retryableTimeout && attempts < maxAttempts)) {
            break;
          }
          await sleep(1_500);
        }
      }

      const statusCode = requestResult?.statusCode ?? 0;
      const contentType = requestResult?.contentType ?? "";
      const latencyMs = requestResult?.latencyMs ?? options.timeoutMs;
      const response = requestResult?.response ?? null;
      const isJson = requestResult?.isJson ?? false;
      const failResponseSummary = requestError
        ? `请求异常：${requestError.message}`
        : requestResult?.rawBodyText ?? "";

      const assertion = evaluateAssertion(
        {
          statusCode,
          isJson,
          latencyMs,
          response: requestError
            ? {
                summary: failResponseSummary
              }
            : response
        },
        testCase.expect
      );

      const record: CaseRecord = {
        runId,
        dataset: testCase.dataset ?? "baseline",
        caseId: testCase.id,
        index: i + 1,
        total: cases.length,
        question: testCase.question,
        tags: testCase.tags ?? [],
        startedAt,
        endedAt: new Date().toISOString(),
        latencyMs,
        attempts,
        http: {
          statusCode,
          contentType
        },
        reply: {
          summary: response?.summary ?? (requestError ? failResponseSummary : null),
          followUpQuestion: response?.followUpQuestion ?? null,
          message: response?.message ?? null,
          error: response?.error ?? (requestError ? requestError.message : null),
          featureCount: Array.isArray(response?.features) ? response!.features!.length : 0
        },
        targetLayer: {
          key: response?.dsl?.targetLayer ? String(response.dsl.targetLayer) : null,
          name: response?.targetLayerName ?? null,
          serviceId: response?.dsl?.targetLayer
            ? String(response.dsl.targetLayer).split(":")[0] ?? null
            : null
        },
        parser: {
          source: response?.parserSource ?? null,
          failureReason: response?.parserFailureReason ?? null,
          failureDetail: response?.parserFailureDetail ?? null,
          isRuleFallback: response?.parserSource === "rule_fallback"
        },
        semanticMeta: {
          retrievalHits: Number(response?.semanticMeta?.retrievalHits ?? 0),
          modelAttempts: Number(response?.semanticMeta?.modelAttempts ?? 0),
          repaired: Boolean(response?.semanticMeta?.repaired),
          decisionPath: String(response?.semanticMeta?.decisionPath ?? ""),
          gateDecision:
            response?.semanticMeta?.gateDecision === "spatial" ||
            response?.semanticMeta?.gateDecision === "non_spatial" ||
            response?.semanticMeta?.gateDecision === "uncertain"
              ? response.semanticMeta.gateDecision
              : "unknown",
          candidateCount: Number(response?.semanticMeta?.candidateCount ?? 0),
          chosenCandidate:
            response?.semanticMeta?.chosenCandidate === "model" ||
            response?.semanticMeta?.chosenCandidate === "rule" ||
            response?.semanticMeta?.chosenCandidate === "repaired_model"
              ? response.semanticMeta.chosenCandidate
              : "unknown",
          candidateScore: Number(response?.semanticMeta?.candidateScore ?? 0)
        },
        dsl: response?.dsl ?? null,
        queryPlan: response?.queryPlan ?? null,
        executionMeta: response?.executionMeta ?? null,
        fullResponse: response ? (response as Record<string, unknown>) : null,
        assertion
      };

      if (requestError) {
        record.assertion.result = "FAIL";
        record.assertion.failReasons.push(`请求异常：${requestError.message}`);
      }

      await appendRecord(recordPath, record);
      console.log(
        `[${record.dataset}:${record.caseId}] ${record.assertion.result} status=${record.http.statusCode} latency=${record.latencyMs}ms parser=${record.parser.source ?? "unknown"} path=${record.semanticMeta.decisionPath || "unknown"}`
      );
    }

    const records = await loadRecords(recordPath);
    const report = buildMarkdownReport(records, {
      runId,
      baseUrl: options.baseUrl,
      casesPath: options.casesPath,
      casesSecondaryPath: options.casesSecondaryPath,
      maxCases: options.maxCases,
      recordPath,
      startedAt: runStartedAt,
      endedAt: new Date().toISOString()
    });
    await fs.writeFile(reportPath, report, "utf8");
    return { reportPath, recordPath };
  } finally {
    stopBackendProcess(backendProcess);
  }
}

async function buildReportFromExistingRecord(
  options: CliOptions,
  recordPath: string
): Promise<string> {
  const records = await loadRecords(recordPath);
  if (records.length === 0) {
    throw new Error(`记录文件为空：${recordPath}`);
  }
  await fs.mkdir(options.reportDir, { recursive: true });
  const runId = `chat_regression_rebuild_${timestampToken()}`;
  const reportPath = path.join(options.reportDir, `${runId}.report.md`);
  const report = buildMarkdownReport(records, {
    runId,
    baseUrl: options.baseUrl,
    casesPath: options.casesPath,
    casesSecondaryPath: options.casesSecondaryPath,
    maxCases: options.maxCases,
    recordPath,
    startedAt: records[0].startedAt,
    endedAt: records[records.length - 1].endedAt
  });
  await fs.writeFile(reportPath, report, "utf8");
  return reportPath;
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  if (options.fromRecordsPath) {
    const reportPath = await buildReportFromExistingRecord(options, options.fromRecordsPath);
    console.log(`报告已生成：${reportPath}`);
    return;
  }

  const { reportPath, recordPath } = await runAndRecordCases(options);
  console.log(`记录文件：${recordPath}`);
  console.log(`报告文件：${reportPath}`);
}

main().catch((error) => {
  console.error(`[chat-regression] 执行失败: ${(error as Error).message}`);
  process.exitCode = 1;
});
