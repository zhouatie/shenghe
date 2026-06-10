# benbenjiucai-skill 使用说明

## 这是什么

`benbenjiucai-skill` 不是股票分析软件，而是一个“股票分析风格/框架 Skill”。

它的作用是让 AI 用“笨笨的韭菜”的视角回答投资问题，比如个股、仓位、止盈、季报、产业链、宏观、市场情绪等。核心产物是 `SKILL.md`，里面定义了触发词、角色口吻、投资框架和免责声明。

## 是否用来分析股票

可以用来分析股票，但它偏“框架分析”，不是实时行情终端，也不是荐股工具。

它会按类似这些逻辑分析：

- 政策 -> 产业 -> 公司
- 纯度 -> 估值 -> 壁垒
- 景气度三段论
- 破线纪律
- 仓位和止盈规则
- 季报三指标：毛利率、合同负债、扣非利润

如果要分析真实当下的股票，最好配合实时数据源。仓库里有量化增强模块，配置示例在 `.env.example`，需要 `TUSHARE_PROXY_KEY` 和 `TUSHARE_PROXY_URL`。否则它主要基于截至 2026-05-13 的蒸馏知识和定性框架。

## 如何使用

需要把这个目录作为 Skill 加载到支持 Skill/OMC 的 Agent 环境里。加载后，用户这样问就会触发：

```text
用笨总的角度看看中芯国际
笨笨的韭菜会怎么看智能驾驶
帮我用笨韭框架分析一下这个票
我被套了，仓位要不要动
这个行业产业链谁最受益
季报出来了，怎么看毛利率和扣非
```

主 Skill 会提供基础人格和核心框架，`.omc/skills/` 下面的子 Skill 会按关键词自动补充：

- `benbenjiucai-stock`：个股分析
- `benbenjiucai-portfolio`：仓位管理
- `benbenjiucai-market`：市场环境
- `benbenjiucai-industry`：产业链
- `benbenjiucai-quarterly`：季报
- `benbenjiucai-take-profit`：止盈
- `benbenjiucai-macro`：宏观
- `benbenjiucai-quant`：量化增强
- `benben-stock-guide`：交互式选股导航

## 工程结构

- `SKILL.md`：主 Skill，包含触发描述、风险提示、角色扮演规则、身份卡、子模块索引、核心模型、启发式和合规声明。
- `modules/core/`：核心知识源文件，拆成身份、心智模型、启发式。
- `modules/on-demand/`：按需模块源文件，覆盖个股、仓位、心态、市场、产业链、季报、止盈、宏观、量化增强。
- `.omc/skills/`：实际给 OMC 条件加载的子 Skill。
- `references/`：调研、提炼、验证、评审过程文档；原始素材目录 `references/sources/` 被 `.gitignore` 排除。
- `scripts/`：工程化脚本，主要是 OMC 同步、质量校验、预提炼、截图。

## 维护流程

正常更新路径：

1. 先改 `modules/core` 或 `modules/on-demand` 源文件。
2. 运行 `python3 scripts/sync_omc.py` 同步 `.omc/skills`。
3. 运行 `python3 scripts/validate_skill.py` 做质量检查。
4. 更新 `SKILL.md`、`CHANGELOG.md` 和 README 中的统计信息。

## 注意事项

- 这是“把笨笨的韭菜的投资思维做成 AI Skill”，可以辅助做股票、行业、仓位分析。
- 不应该把它当成荐股工具、投资咨询系统或交易决策系统。
- 输出内容受 `SKILL.md` 头部风险提示与免责声明约束。
