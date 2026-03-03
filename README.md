# GIS Spatial Semantic Parser (MVP)

自然语言空间查询项目（P0 已实现）：
- 自然语言 -> 结构化 `SpatialQueryDSL`
- `DSL` -> ArcGIS FeatureLayer `/query`
- Vue 地图高亮 + 自然语言摘要回复

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

## API (P0)

- `POST /api/semantic/parse`
- `POST /api/spatial/execute`
- `POST /api/chat/query`
- `GET /api/layers/meta`
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
- `DEFAULT_RADIUS_METERS`（默认 `5000`）
- `MAX_RADIUS_METERS`（默认 `0`，`<=0` 表示不限制）
- `LLM_PROVIDER`（`rule` / `groq` / `openrouter`，默认 `rule`）
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

OpenRouter Free 接入步骤：
1. 复制 `backend/.env.example` 为 `backend/.env`
2. 设置 `LLM_PROVIDER=openrouter`
3. 填写 `OPENROUTER_API_KEY`

## Example Questions

- `鼓楼区公园有多少个`
- `列出仓山区前20个公园名称`
- `按区县统计公园数量`
- `13303000,2996000 500米内的公园`

## Notes

- 当前 P0 严格依赖公园点图层，不包含道路/区县边界图层能力。
- 对于“某街道100米内”“某县1km内”会返回补充依赖提示。
