# 价值突变雷达

Next.js 本地实战投研工作台：观察池、60/40 评分、主线雷达、持仓体检、复盘日记和可选行情刷新。

## 使用

```bash
pnpm install
pnpm dev
```

打开 `http://127.0.0.1:4173`。

## 技术栈

- Next.js App Router
- React + TypeScript
- Node 22 `node:sqlite`
- SQLite 本地数据库
- Server Actions
- 原生 CSS 工作台界面

## 数据

主数据库保存在 `data/radar.sqlite`。首次启动时，如果数据库为空，会从 `data/radar-db.json` 或内置模板初始化观察池。

页面里的模板标的只是录入格式示例；正式使用时请在数据台手动入池或导入 CSV。工具只做个人研究流程管理，不提供投资建议、收益承诺、价格预测或买卖时机。

## 命令

```bash
pnpm run check
pnpm build
```
