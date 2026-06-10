"use client";

import { FormEvent, ReactNode, useMemo, useState, useTransition } from "react";
import {
  addHoldingAction,
  addJournalAction,
  clearJournalAction,
  createCandidateAction,
  deleteCandidateAction,
  deleteHoldingAction,
  deleteJournalAction,
  importCsvAction,
  refreshQuotesAction,
} from "@/app/actions";
import { themeColor } from "@/lib/scoring";
import type { AppState, Candidate, CandidateInput, HoldingInput, JournalInput, ThemeSummary } from "@/lib/types";

type Props = {
  initialState: AppState;
};

export default function Dashboard({ initialState }: Props) {
  const [state, setState] = useState(initialState);
  const [selectedCandidateId, setSelectedCandidateId] = useState(initialState.candidates[0]?.id || "");
  const [activeTheme, setActiveTheme] = useState("全部");
  const [themeMode, setThemeMode] = useState("全部");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("score");
  const [notice, setNotice] = useState("SQLite 已连接");
  const [isPending, startTransition] = useTransition();

  const selectedCandidate =
    state.candidates.find((candidate) => candidate.id === selectedCandidateId) || state.candidates[0];

  const visibleThemes = useMemo(
    () => state.themes.filter((theme) => themeMode === "全部" || theme.mode === themeMode),
    [state.themes, themeMode],
  );

  const visibleCandidates = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return state.candidates
      .filter((candidate) => {
        const matchesTheme = activeTheme === "全部" || candidate.theme === activeTheme;
        const text = [
          candidate.name,
          candidate.code,
          candidate.symbol,
          candidate.theme,
          candidate.thesis,
          candidate.riskNotes,
          ...candidate.tags,
        ]
          .join(" ")
          .toLowerCase();
        return matchesTheme && (!needle || text.includes(needle));
      })
      .sort((a, b) => {
        if (sort === "market") return b.scores.market - a.scores.market;
        if (sort === "fundamental") return b.scores.fundamental - a.scores.fundamental;
        if (sort === "risk") return a.scores.risk - b.scores.risk;
        return b.scores.total - a.scores.total;
      });
  }, [activeTheme, query, sort, state.candidates]);

  function run(task: () => Promise<AppState | void>, success?: string) {
    startTransition(async () => {
      try {
        const result = await task();
        if (result) setState(result);
        if (success) setNotice(success);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "操作失败");
      }
    });
  }

  function replaceState(next: AppState, message: string) {
    setState(next);
    if (!next.candidates.some((candidate) => candidate.id === selectedCandidateId)) {
      setSelectedCandidateId(next.candidates[0]?.id || "");
    }
    setNotice(message);
  }

  async function onCandidateSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = objectFromForm<CandidateInput>(form);
    startTransition(async () => {
      try {
        const next = await createCandidateAction(payload);
        const saved = next.candidates.find((candidate) => candidate.code === payload.code) || next.candidates[0];
        setState(next);
        setSelectedCandidateId(saved?.id || "");
        form.reset();
        setNotice("已入池");
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "保存失败");
      }
    });
  }

  async function onCsvSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const csv = String(new FormData(form).get("csv") || "");
    startTransition(async () => {
      try {
        const result = await importCsvAction(csv);
        setState(result.state);
        form.reset();
        setNotice(`已导入 ${result.imported} 行`);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "导入失败");
      }
    });
  }

  async function onHoldingSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = objectFromForm<HoldingInput>(form);
    run(async () => {
      const next = await addHoldingAction(payload);
      form.reset();
      return next;
    }, "持仓观察已保存");
  }

  async function onJournalSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = objectFromForm<JournalInput>(form);
    run(async () => {
      const next = await addJournalAction(payload);
      form.reset();
      return next;
    }, "复盘已记录");
  }

  function draftJournal(candidate: Candidate) {
    const form = document.querySelector<HTMLFormElement>("#journalForm");
    if (!form) return;
    form.candidateId.value = candidate.id;
    form.thesis.value = candidate.thesis || `${candidate.theme} 主线观察`;
    form.mutation.value = mutationText(candidate);
    form.verification.value = verificationText(candidate);
    form.invalidation.value = splitRisk(candidate.riskNotes).join("；");
    document.querySelector("#journal")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function addSelectedHolding(candidate: Candidate) {
    run(
      () =>
        addHoldingAction({
          candidateId: candidate.id,
          cost: candidate.price || 0,
          quantity: 0,
          targetWeight: 0,
          conviction: "中",
          stage: "观察",
        }),
      "已加入持仓观察",
    );
    document.querySelector("#holdings")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="主导航">
        <div className="brand">
          <span className="brand-mark">◎</span>
          <div>
            <h1>价值突变雷达</h1>
            <p>Next.js 实战版</p>
          </div>
        </div>
        <nav className="nav-stack">
          {[
            ["data", "数据台"],
            ["radar", "主线雷达"],
            ["candidates", "候选池"],
            ["logic", "逻辑卡"],
            ["holdings", "持仓体检"],
            ["journal", "复盘日记"],
          ].map(([id, label]) => (
            <a href={`#${id}`} className="nav-link" key={id}>
              <span className="nav-icon">▣</span>
              <span>{label}</span>
            </a>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="status-dot" />
          <span>SQLite 本地数据库 · 人工决策</span>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <p className="eyebrow">动态价值重估实战台</p>
            <h2>观察池扫描、持仓体检、复盘闭环</h2>
          </div>
          <div className="topbar-meta">
            <span>{new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date())}</span>
            <span>{isPending ? "处理中" : `已保存 ${formatDate(state.updatedAt)}`}</span>
          </div>
        </header>

        <section className="metric-strip" aria-label="核心指标">
          <Metric label="最强主线" value={state.metrics.topTheme} sub={`${state.themes[0]?.strength || 0} 强度`} />
          <Metric label="观察池" value={state.metrics.candidateCount} sub={`均分 ${state.metrics.avgScore}`} />
          <Metric label="高风险样本" value={state.metrics.highRiskCount} sub="风险扣分 ≥ 10" />
          <Metric label="复盘到期" value={state.metrics.dueJournal} sub={`持仓 ${formatMoney(state.metrics.exposure)}`} />
        </section>

        <div className="workspace-grid">
          <div className="workspace-main">
            <section className="tool-section" id="data">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Data Desk</p>
                  <h3>数据台</h3>
                </div>
                <div className="button-row">
                  <button
                    className="command-button"
                    type="button"
                    onClick={() =>
                      startTransition(async () => {
                        try {
                          const result = await refreshQuotesAction();
                          setState(result.state);
                          setNotice(`行情刷新完成，更新 ${result.updated || 0} 个标的`);
                        } catch (error) {
                          setNotice(error instanceof Error ? `行情刷新失败：${error.message}` : "行情刷新失败");
                        }
                      })
                    }
                  >
                    刷新行情
                  </button>
                  <a className="icon-button" href="/api/export" title="导出数据" aria-label="导出数据">
                    ↓
                  </a>
                </div>
              </div>

              <div className="data-grid">
                <form className="candidate-form" onSubmit={onCandidateSubmit}>
                  <input name="name" placeholder="名称" autoComplete="off" required />
                  <input name="code" placeholder="代码" autoComplete="off" required />
                  <input name="symbol" placeholder="行情符号" autoComplete="off" />
                  <input name="theme" placeholder="主线" autoComplete="off" required />
                  <input name="tags" placeholder="标签，逗号分隔" autoComplete="off" />
                  <input name="price" type="number" min="0" step="0.001" placeholder="价格" />
                  <input name="changePct" type="number" step="0.01" placeholder="涨跌%" />
                  <input name="volume" type="number" min="0" step="1" placeholder="成交量" />
                  <textarea name="thesis" placeholder="一句话逻辑" />
                  <textarea name="riskNotes" placeholder="风险和证伪点" />
                  <ScoreFieldset title="市场 60" fields={marketFields} />
                  <ScoreFieldset title="基本面 40" fields={fundamentalFields} />
                  <button className="command-button" type="submit">
                    入池
                  </button>
                </form>

                <form className="import-form" onSubmit={onCsvSubmit}>
                  <textarea
                    name="csv"
                    placeholder="code,name,symbol,theme,rs,themeScore,flow,structure,catalyst,growth,position,valuation,cashflow,governance,riskPenalty,price,changePct,volume,tags,thesis,riskNotes"
                  />
                  <button className="command-button" type="submit">
                    导入 CSV
                  </button>
                  <p className="notice">{notice}</p>
                </form>
              </div>
            </section>

            <section className="tool-section" id="radar">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Theme Radar</p>
                  <h3>主线雷达</h3>
                </div>
                <div className="segmented" role="group" aria-label="主线筛选">
                  {["全部", "进攻", "防守"].map((mode) => (
                    <button
                      className={`segment ${themeMode === mode ? "is-active" : ""}`}
                      key={mode}
                      onClick={() => {
                        setThemeMode(mode);
                        setActiveTheme("全部");
                      }}
                      type="button"
                    >
                      {mode}
                    </button>
                  ))}
                </div>
              </div>
              <div className="theme-grid">
                {visibleThemes.map((theme) => (
                  <ThemeCard key={theme.id} theme={theme} active={activeTheme === theme.name} onClick={() => setActiveTheme(theme.name)} />
                ))}
              </div>
            </section>

            <section className="tool-section" id="candidates">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Mutation Pool</p>
                  <h3>价值突变候选池</h3>
                </div>
                <div className="toolbar">
                  <label className="search-box" title="搜索名称、代码或标签">
                    <span>⌕</span>
                    <input value={query} onChange={(event) => setQuery(event.target.value)} type="search" placeholder="搜索" />
                  </label>
                  <select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="排序">
                    <option value="score">总分</option>
                    <option value="market">市场 60</option>
                    <option value="fundamental">基本面 40</option>
                    <option value="risk">风险扣分</option>
                  </select>
                </div>
              </div>
              <div className="table-wrap">
                <table className="candidate-table">
                  <thead>
                    <tr>
                      <th>标的</th>
                      <th>主线</th>
                      <th>总分</th>
                      <th>市场</th>
                      <th>基本面</th>
                      <th>风险</th>
                      <th>价格</th>
                      <th>涨跌</th>
                      <th>趋势</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {visibleCandidates.map((candidate) => (
                      <CandidateRow
                        candidate={candidate}
                        key={candidate.id}
                        selected={candidate.id === selectedCandidateId}
                        onSelect={() => setSelectedCandidateId(candidate.id)}
                        onDelete={() =>
                          run(async () => {
                            const next = await deleteCandidateAction(candidate.id);
                            replaceState(next, "标的已删除");
                          })
                        }
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="tool-section" id="holdings">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Position Check</p>
                  <h3>持仓体检</h3>
                </div>
              </div>
              <form className="entry-form" onSubmit={onHoldingSubmit}>
                <select name="candidateId" aria-label="观察标的">
                  <option value="">自定义标的</option>
                  {state.candidates.map((candidate) => (
                    <option value={candidate.id} key={candidate.id}>
                      {candidate.name} · {candidate.code}
                    </option>
                  ))}
                </select>
                <input name="customName" placeholder="名称" autoComplete="off" />
                <input name="cost" type="number" min="0" step="0.001" placeholder="成本" />
                <input name="quantity" type="number" min="0" step="1" placeholder="数量" />
                <input name="targetWeight" type="number" min="0" max="100" step="0.1" placeholder="目标%" />
                <select name="conviction" aria-label="把握度">
                  <option value="中">把握度: 中</option>
                  <option value="高">把握度: 高</option>
                  <option value="低">把握度: 低</option>
                </select>
                <select name="stage" aria-label="阶段">
                  <option value="验证">阶段: 验证</option>
                  <option value="加速">阶段: 加速</option>
                  <option value="防守">阶段: 防守</option>
                  <option value="观察">阶段: 观察</option>
                </select>
                <button className="command-button" type="submit">
                  保存
                </button>
              </form>
              <div className="holding-layout">
                <div className="holding-list">
                  {state.holdings.length ? (
                    state.holdings.map((holding) => (
                      <article className="holding-card" key={holding.id}>
                        <div>
                          <h4>{holding.candidateName || holding.customName || "自定义标的"}</h4>
                          <p>
                            {holding.theme} · {holding.stage} · 把握度 {holding.conviction}
                          </p>
                        </div>
                        <div>
                          <span className={`health ${holding.health.className}`}>{holding.health.text}</span>
                        </div>
                        <div>
                          <strong>{formatMoney(holding.value)}</strong>
                          <p>
                            {formatNumber(holding.quantity, "0")} 股 · 目标 {formatNumber(holding.targetWeight, "0")}%
                          </p>
                        </div>
                        <button
                          className="icon-button danger"
                          type="button"
                          title="删除"
                          aria-label="删除"
                          onClick={() => run(() => deleteHoldingAction(holding.id), "持仓观察已删除")}
                        >
                          ×
                        </button>
                      </article>
                    ))
                  ) : (
                    <div className="empty-state">暂无持仓观察</div>
                  )}
                </div>
                <ExposurePanel state={state} />
              </div>
            </section>

            <section className="tool-section" id="journal">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Review Log</p>
                  <h3>复盘日记</h3>
                </div>
                <div className="button-row">
                  <a className="icon-button" href="/api/export" title="导出 JSON" aria-label="导出 JSON">
                    ↓
                  </a>
                  <button className="icon-button danger" type="button" title="清空复盘" aria-label="清空复盘" onClick={() => run(clearJournalAction, "复盘已清空")}>
                    ×
                  </button>
                </div>
              </div>
              <form className="journal-form" id="journalForm" onSubmit={onJournalSubmit}>
                <select name="candidateId" aria-label="复盘标的">
                  {state.candidates.map((candidate) => (
                    <option value={candidate.id} key={candidate.id}>
                      {candidate.name} · {candidate.code}
                    </option>
                  ))}
                </select>
                <select name="decision" aria-label="研究结论">
                  <option value="观察">观察</option>
                  <option value="提高关注">提高关注</option>
                  <option value="降低关注">降低关注</option>
                  <option value="移出观察">移出观察</option>
                </select>
                <textarea name="thesis" placeholder="时代逻辑" />
                <textarea name="mutation" placeholder="价值突变点" />
                <textarea name="verification" placeholder="市场验证" />
                <textarea name="invalidation" placeholder="证伪信号" />
                <input name="reviewDate" type="date" aria-label="下次复盘日期" />
                <button className="command-button" type="submit">
                  记录
                </button>
              </form>
              <div className="journal-list">
                {state.journal.length ? (
                  state.journal.map((entry) => {
                    const candidate = state.candidates.find((item) => item.id === entry.candidateId);
                    const due = entry.reviewDate && entry.reviewDate <= new Date().toISOString().slice(0, 10);
                    return (
                      <article className="journal-entry" key={entry.id}>
                        <div className="journal-head">
                          <div>
                            <h4>{candidate?.name || "自定义记录"}</h4>
                            <div className="journal-meta">
                              <span className="chip">{entry.decision}</span>
                              <span className="chip">记录 {formatDate(entry.createdAt)}</span>
                              <span className={due ? "risk-chip" : "chip"}>复盘 {entry.reviewDate || "未设置"}</span>
                            </div>
                          </div>
                          <button
                            className="icon-button danger"
                            type="button"
                            title="删除"
                            aria-label="删除复盘"
                            onClick={() => run(() => deleteJournalAction(entry.id), "复盘已删除")}
                          >
                            ×
                          </button>
                        </div>
                        <div className="journal-body">
                          <JournalField label="时代逻辑" value={entry.thesis} />
                          <JournalField label="价值突变点" value={entry.mutation} />
                          <JournalField label="市场验证" value={entry.verification} />
                          <JournalField label="证伪信号" value={entry.invalidation} />
                        </div>
                      </article>
                    );
                  })
                ) : (
                  <div className="empty-state">暂无复盘记录</div>
                )}
              </div>
            </section>
          </div>

          <aside className="logic-panel" id="logic" aria-label="个股逻辑卡">
            {selectedCandidate ? (
              <LogicCard candidate={selectedCandidate} onAddHolding={addSelectedHolding} onDraftJournal={draftJournal} />
            ) : (
              <article className="logic-card">
                <div className="empty-state">先在数据台加入标的</div>
              </article>
            )}
          </aside>
        </div>

        <footer className="risk-footer">
          本工具仅用于个人研究流程管理。所有评分来自你录入或导入的数据，不提供收益承诺、价格预测、买卖时机或具体投资建议。
        </footer>
      </main>
    </div>
  );
}

const marketFields = [
  ["rs", "相对强度", 12, 20],
  ["themeScore", "主线强度", 6, 10],
  ["flow", "资金流", 5, 10],
  ["structure", "趋势结构", 6, 10],
  ["catalyst", "催化密度", 5, 10],
];

const fundamentalFields = [
  ["growth", "增长加速", 6, 12],
  ["position", "产业位置", 5, 8],
  ["valuation", "估值匹配", 5, 8],
  ["cashflow", "现金流", 4, 6],
  ["governance", "治理透明", 4, 6],
  ["riskPenalty", "风险扣分", 8, 30],
];

function ScoreFieldset({ title, fields }: { title: string; fields: Array<(string | number)[]> }) {
  return (
    <fieldset className="score-fieldset">
      <legend>{title}</legend>
      {fields.map(([name, label, value, max]) => (
        <label key={String(name)}>
          {label}
          <input name={String(name)} type="number" min="0" max={Number(max)} defaultValue={Number(value)} />
        </label>
      ))}
    </fieldset>
  );
}

function Metric({ label, value, sub }: { label: string; value: ReactNode; sub: string }) {
  return (
    <article className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{sub}</small>
    </article>
  );
}

function ThemeCard({ theme, active, onClick }: { theme: ThemeSummary; active: boolean; onClick: () => void }) {
  return (
    <button className={`theme-card ${active ? "is-active" : ""}`} type="button" onClick={onClick}>
      <div className="theme-top">
        <div>
          <p className="eyebrow">{theme.mode}</p>
          <h4 className="theme-name">{theme.name}</h4>
        </div>
        <span className="theme-score">{theme.strength}</span>
      </div>
      <Sparkline points={theme.trend} color={theme.color} />
      <div className="theme-meta">
        <div className="mini-stat">
          <span>入池样本</span>
          <strong>{theme.breadth}</strong>
        </div>
        <div className="mini-stat">
          <span>平均涨跌</span>
          <strong>{formatPercent(theme.turnover)}</strong>
        </div>
      </div>
      <div className="theme-tags">
        {theme.catalysts.map((tag) => (
          <span className="chip" key={tag}>
            {tag}
          </span>
        ))}
        <span className="risk-chip">{theme.risk}</span>
      </div>
    </button>
  );
}

function CandidateRow({
  candidate,
  selected,
  onSelect,
  onDelete,
}: {
  candidate: Candidate;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  return (
    <tr className={selected ? "is-selected" : ""} onClick={onSelect}>
      <td>
        <div className="candidate-name">
          <strong>{candidate.name}</strong>
          <span>
            {candidate.code} {candidate.sample ? "· 模板" : ""}
          </span>
        </div>
      </td>
      <td>{candidate.theme}</td>
      <td>
        <span className={`score-chip ${scoreClass(candidate.scores.total)}`}>{candidate.scores.total}</span>
      </td>
      <td>
        <Bar value={candidate.scores.market} max={60} color="#087f8c" />
      </td>
      <td>
        <Bar value={candidate.scores.fundamental} max={40} color="#285cc4" />
      </td>
      <td>
        <span className="risk-chip">-{candidate.scores.risk}</span>
      </td>
      <td>{formatNumber(candidate.price)}</td>
      <td>
        <span className={Number(candidate.changePct) < 0 ? "down-text" : "up-text"}>{formatPercent(candidate.changePct)}</span>
      </td>
      <td>
        <Sparkline points={candidate.trend} color={themeColor(candidate.theme)} />
      </td>
      <td>
        <button
          className="icon-button danger"
          type="button"
          title="删除标的"
          aria-label="删除标的"
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
        >
          ×
        </button>
      </td>
    </tr>
  );
}

function LogicCard({
  candidate,
  onAddHolding,
  onDraftJournal,
}: {
  candidate: Candidate;
  onAddHolding: (candidate: Candidate) => void;
  onDraftJournal: (candidate: Candidate) => void;
}) {
  return (
    <article className="logic-card">
      <div className="logic-title">
        <div>
          <p className="eyebrow">{candidate.theme}</p>
          <h3>{candidate.name}</h3>
          <p>
            {candidate.code} {candidate.symbol ? `· ${candidate.symbol}` : ""}
          </p>
        </div>
        <span className={`score-chip ${scoreClass(candidate.scores.total)}`}>{candidate.scores.total}</span>
      </div>
      <div className="chip-row">
        {candidate.tags.map((tag) => (
          <span className="chip" key={tag}>
            {tag}
          </span>
        ))}
        <span className="risk-chip">风险 -{candidate.scores.risk}</span>
      </div>
      <p className="logic-summary">{candidate.thesis || "尚未填写一句话逻辑。"}</p>
      <div className="logic-blocks">
        <LogicBlock title="时代需求">
          {candidate.theme} 主线正在被纳入观察，需用政策、订单、价格、业绩或资金数据继续验证。
        </LogicBlock>
        <LogicBlock title="价值突变">{mutationText(candidate)}</LogicBlock>
        <LogicBlock title="市场验证">{verificationText(candidate)}</LogicBlock>
        <LogicBlock title="基本面解释">
          增长加速 {candidate.fundamental.growth}/12，产业位置 {candidate.fundamental.position}/8，估值匹配{" "}
          {candidate.fundamental.valuation}/8。
        </LogicBlock>
        <LogicBlock title="仓位线索">{positionText(candidate)}</LogicBlock>
        <div className="logic-block">
          <h4>关键风险</h4>
          <ul>
            {splitRisk(candidate.riskNotes).map((risk) => (
              <li key={risk}>{risk}</li>
            ))}
          </ul>
        </div>
        <div className="logic-block">
          <h4>跟踪点</h4>
          <div className="checkpoint-grid">
            {["30天", "60天", "90天"].map((period, index) => (
              <div className="checkpoint" key={period}>
                <strong>{period}</strong>
                <span>{checkpointText(candidate, index)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="logic-actions">
        <button className="command-button" type="button" onClick={() => onAddHolding(candidate)}>
          加入观察
        </button>
        <button className="command-button" type="button" onClick={() => onDraftJournal(candidate)}>
          写入复盘
        </button>
      </div>
    </article>
  );
}

function LogicBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="logic-block">
      <h4>{title}</h4>
      <p>{children}</p>
    </div>
  );
}

function ExposurePanel({ state }: { state: AppState }) {
  const byTheme = new Map<string, number>();
  for (const holding of state.holdings) byTheme.set(holding.theme, (byTheme.get(holding.theme) || 0) + holding.value);
  const total = [...byTheme.values()].reduce((sum, value) => sum + value, 0);
  const rows = [...byTheme.entries()].sort((a, b) => b[1] - a[1]);
  return (
    <div className="exposure-panel">
      <div>
        <p className="eyebrow">Exposure</p>
        <h3>{formatMoney(total)}</h3>
      </div>
      {rows.length ? (
        rows.map(([name, value]) => {
          const width = total ? (value / total) * 100 : 0;
          return (
            <div className="exposure-row" key={name}>
              <span>{name}</span>
              <div className="bar-track">
                <div className="bar-fill" style={{ width: `${width}%` }} />
              </div>
              <strong>{Math.round(width)}%</strong>
            </div>
          );
        })
      ) : (
        <div className="empty-state">暂无敞口</div>
      )}
    </div>
  );
}

function JournalField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <p>{value || "未记录"}</p>
    </div>
  );
}

function Sparkline({ points, color }: { points: number[]; color: string }) {
  const data = points.length ? points : [40, 45, 50, 55, 60];
  const width = 160;
  const height = 34;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const spread = Math.max(1, max - min);
  const step = width / Math.max(1, data.length - 1);
  const path = data
    .map((point, index) => {
      const x = index * step;
      const y = height - ((point - min) / spread) * (height - 5) - 2;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <path d={path} stroke={color} strokeWidth="3" fill="none" />
    </svg>
  );
}

function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  const width = Math.max(0, Math.min(100, (Number(value || 0) / max) * 100));
  return (
    <div className="bar-track" title={`${value} / ${max}`}>
      <div className="bar-fill" style={{ width: `${width}%`, background: color }} />
    </div>
  );
}

function mutationText(candidate: Candidate): string {
  if (candidate.scores.market >= 45 && candidate.scores.fundamental >= 28) return "市场和基本面同时高分，属于优先验证的价值变化样本。";
  if (candidate.scores.market >= 45) return "市场先行明显，下一步重点验证基本面是否跟上。";
  if (candidate.scores.fundamental >= 28) return "基本面得分较强，但市场验证不足，需要等待资金和趋势确认。";
  return "变化信号还不够强，适合低频观察或继续补数据。";
}

function verificationText(candidate: Candidate): string {
  const quote = candidate.lastQuoteAt
    ? `行情 ${formatNumber(candidate.price)}，涨跌 ${formatPercent(candidate.changePct)}，${candidate.quoteSource || "数据源"} 更新。`
    : "行情尚未刷新。";
  return `${quote} 市场评分 ${candidate.scores.market}/60，其中相对强度 ${candidate.market.rs}/20，资金流 ${candidate.market.flow}/10。`;
}

function positionText(candidate: Candidate): string {
  if (candidate.scores.risk >= 14) return "风险扣分偏高，单票仓位宜低于常规上限，并设置明确证伪点。";
  if (candidate.scores.total >= 78) return "综合评分较强，但仍需按市场阶段控制单票和行业集中度。";
  return "当前更适合观察仓或验证仓，等待主线强度和基本面数据继续确认。";
}

function checkpointText(candidate: Candidate, index: number): string {
  return [
    `复核 ${candidate.theme} 主线强度、相对强度和成交变化。`,
    "对照财报、订单、价格、产能或行业数据，确认变化不是情绪波动。",
    "比较同主线替代标的，若评分下降或证伪点出现则降级观察。",
  ][index];
}

function splitRisk(value: string): string[] {
  const items = String(value || "")
    .split(/[，,;；\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : ["风险点未填写", "上涨逻辑尚未证伪", "数据源需要继续补充"];
}

function objectFromForm<T>(form: HTMLFormElement): T {
  return Object.fromEntries(new FormData(form).entries()) as T;
}

function formatMoney(value: number): string {
  if (value >= 100000000) return `${(value / 100000000).toFixed(2)}亿`;
  if (value >= 10000) return `${(value / 10000).toFixed(1)}万`;
  return Number(value || 0).toLocaleString("zh-CN", { maximumFractionDigits: 0 });
}

function formatNumber(value: number | null, fallback = "-"): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return number.toLocaleString("zh-CN", { maximumFractionDigits: 3 });
}

function formatPercent(value: number | null): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  const prefix = number > 0 ? "+" : "";
  return `${prefix}${number.toFixed(2)}%`;
}

function formatDate(value: string): string {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date(value));
}

function scoreClass(score: number): string {
  if (score >= 78) return "";
  if (score >= 64) return "warn";
  return "risk";
}
