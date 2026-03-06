# GIS Spatial Semantic Parser (MVP)

自然语言空间查询项目（P1 已实现）：
- 自然语言 -> 结构化 `SpatialQueryDSL`
- `DSL` -> ArcGIS FeatureLayer `/query`
- Vue 地图高亮 + 自然语言摘要回复
- Gemini 优先（失败回退 OpenRouter，再回退规则）
- 支持 `search/count/group_stat/buffer_search/nearest`
- 支持空间关系查询 / 空间 Join 计数 / 多环缓冲统计（P1）

## Tech Stack

- Frontend: `Vue 3 + Vite + TypeScript + @arcgis/core`
- Backend: `Node.js + Fastify + TypeScript`
- Shared: `@gis/shared`（DSL 类型和 Schema）

## Workspace Structure

- `shared`: DSL 与通用类型
- `backend`: 语义解析、查询编译、ArcGIS 执行 API
- `frontend`: 聊天面板、DSL 展示、地图高亮
- `docs/spatial-semantic-design.md`: 设计文档
- `Agent.md`: 实现总纲

## API (P1)

- `POST /api/semantic/parse`
- `POST /api/spatial/execute`
- `POST /api/chat/query`
- `GET /api/layers/catalog`
- `POST /api/layers/catalog/register`
- `DELETE /api/layers/catalog/service/:serviceId`
- `PATCH /api/layers/catalog/layer/:layerKey`
- `GET /api/layers/meta`（兼容，支持 `layerKey` 查询参数）
- `GET /health`

## Quick Start

1. 安装依赖

```bash
npm install
```

2. 启动后端

```bash
npm run dev:backend
```

说明：该命令会先自动构建 `shared` 再启动后端。

3. 启动前端

```bash
npm run dev:frontend
```

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:3300`

## Environment Variables (Backend)

- `PORT`（默认 `3300`）
- `HOST`（默认 `0.0.0.0`）
- `ARCGIS_PARKS_LAYER_URL`（默认福州市公园点图层）
- `LAYER_REGISTRY_PATH`（图层注册表落盘路径，默认 `backend/data/layer-registry.json`）
- `LAYER_META_TIMEOUT_MS`（图层元数据请求超时，默认 `8000`）
- `ALLOWED_LAYER_HOSTS`（允许注册的图层域名白名单，逗号分隔）
- `MAX_REGISTERED_SERVICES`（最大可注册服务数，默认 `20`）
- `DEFAULT_RADIUS_METERS`（默认 `5000`）
- `MAX_RADIUS_METERS`（默认 `0`，`<=0` 表示不限制）
- `LLM_PROVIDER`（`rule` / `gemini` / `groq` / `openrouter`，默认 `rule`）
- `GEMINI_API_KEY`（启用 Gemini 必填）
- `GEMINI_BASE_URL`（默认 `https://generativelanguage.googleapis.com/v1beta/openai`）
- `GEMINI_MODEL`（默认 `gemini-2.0-flash`）
- `GEMINI_TIMEOUT_MS`（默认 `12000`）
- `GROQ_API_KEY`（启用 Groq 必填）
- `GROQ_BASE_URL`（默认 `https://api.groq.com/openai/v1`）
- `GROQ_MODEL`（默认 `llama-3.1-8b-instant`）
- `GROQ_TIMEOUT_MS`（默认 `12000`）
- `OPENROUTER_API_KEY`（启用 OpenRouter 必填）
- `OPENROUTER_BASE_URL`（默认 `https://openrouter.ai/api/v1`）
- `OPENROUTER_MODEL`（默认 `openrouter/free`）
- `OPENROUTER_TIMEOUT_MS`（默认 `12000`）
- `OPENROUTER_SITE_URL`（可选，站点 URL）
- `OPENROUTER_APP_NAME`（可选，应用名，默认 `gis-semantic-query`）

Gemini 优先（失败回退 OpenRouter Free）接入步骤：
1. 复制 `backend/.env.example` 为 `backend/.env`
2. 设置 `LLM_PROVIDER=gemini`
3. 填写 `GEMINI_API_KEY`
4. 填写 `OPENROUTER_API_KEY`（作为 Gemini 失败时的自动回退）

## Example Questions

- `鼓楼区公园有多少个`
- `列出仓山区前20个公园名称`
- `按区县统计公园数量`
- `13303000,2996000 500米内的公园`
- `标准名称为南二环的道路街巷相交的门牌号码`
- `每个宗地院落内门牌号码数量前5个`
- `x:13303000,y:2996000 500米、1公里、2公里内公园数量对比`
- `x:13303000,y:2996000 1000米内最近的公园前5个`

## Notes

- 支持手动添加多个 `FeatureServer`，自动发现子图层并可显示/隐藏。
- 语义查询采用“自动图层路由 + 歧义追问”，当前版本一次仅执行单图层查询。
- 图层配置会持久化到 `backend/data/layer-registry.json`。
- 语义 RAG 语料位于 `backend/training/semantic-corpus.jsonl`，失败样本自动沉淀到 `backend/training/semantic-failures.jsonl`。
- `disjoint(相离)` 关系受 ArcGIS 服务能力影响，若服务不支持会返回友好提示而非 500。

## 自动回归测试（100 条问句）

用例文件：
- `backend/testcases/chat-query-cases.json`
- `backend/testcases/chat-query-cases-variant.json`（变体句式，可选）
- `backend/testcases/chat-query-cases-p0.json`（P0 新能力专项，可选）
- `backend/testcases/chat-query-cases-p1.json`（P1 空间分析专项）

一键执行（会自动拉起 backend，并逐条写记录再生成报告）：

```bash
npm run test:chat
```
默认会同时执行基线 + 变体双数据集。

P1 专项回归：

```bash
npm run test:chat:p1
```

默认输出目录：
- 记录文件：`docs/test-reports/chat_regression_YYYYMMDD_HHmmss.records.jsonl`
- 报告文件：`docs/test-reports/chat_regression_YYYYMMDD_HHmmss.report.md`

说明：
- 每条问句执行后会立刻追加一行 JSON 记录（JSONL）。
- 每条记录至少包含：`reply`、`targetLayer`、`parser`（含回退失败原因）、`dsl`、`queryPlan`、`fullResponse`。
- 每条记录还包含：`semanticMeta`（`retrievalHits/modelAttempts/repaired/decisionPath/gateDecision/candidateScore/chosenCandidate`）。
- 最终 Markdown 报告是从该记录文件聚合生成。
- 报告会额外输出 `serviceId` 维度通过率，便于观察新接入服务的稳定性。

可选参数（示例）：

```bash
npm run test:chat -- --timeout-ms=60000 --base-url=http://127.0.0.1:3300
npm run test:chat -- --max-cases=20
npm run test:chat-regression -w backend -- --cases=backend/testcases/chat-query-cases-p0.json --spawn-backend=true
```

仅根据已有记录文件重建报告：

```bash
npm run test:chat -- --from-records=docs/test-reports/chat_regression_xxx.records.jsonl
```

## 新服务 onboarding smoke cases

用于“新图层零补丁”场景：注册新服务后自动生成回归冒烟问句（eq/like/count/group/in/not in/buffer/nearest）。

```bash
# 使用 registry 中最后一个服务
npm run test:chat:onboarding

# 指定 serviceId + 自定义输出文件
npm run test:chat:onboarding -- --service-id=svc_xxx --output=backend/testcases/chat-query-cases-onboarding-svc_xxx.json
```
