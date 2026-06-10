import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { parseCsv, clamp, nullableNumber, normalizeTrend, numberOr, splitTags } from "@/lib/parse";
import { deriveThemes, healthFor, scoreCandidate } from "@/lib/scoring";
import type {
  AppState,
  Candidate,
  CandidateInput,
  CsvImportResult,
  FundamentalScores,
  Holding,
  HoldingInput,
  JournalEntry,
  JournalInput,
  MarketScores,
  QuoteRefreshResult,
  Settings,
} from "@/lib/types";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "radar.sqlite");
const LEGACY_JSON_PATH = path.join(DATA_DIR, "radar-db.json");

type Row = Record<string, unknown>;

type CandidateRow = Row & {
  id: string;
  name: string;
  code: string;
  symbol: string;
  theme: string;
  tags_json: string;
  thesis: string;
  risk_notes: string;
  market_json: string;
  fundamental_json: string;
  risk_penalty: number;
  price: number | null;
  change_pct: number | null;
  volume: number | null;
  last_quote_at: string | null;
  quote_source: string | null;
  trend_json: string;
  sample: number;
  created_at: string;
  updated_at: string;
};

type HoldingRow = Row & {
  id: string;
  candidate_id: string;
  custom_name: string;
  cost: number;
  quantity: number;
  target_weight: number;
  conviction: string;
  stage: string;
  created_at: string;
};

type JournalRow = Row & {
  id: string;
  candidate_id: string;
  decision: string;
  thesis: string;
  mutation: string;
  verification: string;
  invalidation: string;
  review_date: string;
  created_at: string;
};

type LegacyDb = {
  settings?: Partial<Settings>;
  candidates?: Array<Record<string, unknown>>;
  holdings?: Array<Record<string, unknown>>;
  journal?: Array<Record<string, unknown>>;
};

const seedCandidates: CandidateInput[] = [
  {
    name: "算力设备模板",
    code: "DEMO-001",
    theme: "AI 算力",
    tags: ["订单密度", "国产替代"],
    thesis: "推理算力扩容带动订单密度提升，股价先于利润表反应。",
    riskNotes: "拥挤度、交付延迟、估值透支",
    rs: 19,
    themeScore: 10,
    flow: 9,
    structure: 8,
    catalyst: 9,
    growth: 11,
    position: 8,
    valuation: 6,
    cashflow: 5,
    governance: 5,
    riskPenalty: 9,
    trend: [48, 52, 57, 65, 71, 76, 82, 87, 91],
    sample: true,
  },
  {
    name: "机器人部件模板",
    code: "DEMO-002",
    theme: "机器人",
    tags: ["量产验证", "弹性"],
    thesis: "机器人量产预期从概念扩散到核心部件订单，变化率优于静态利润。",
    riskNotes: "量产不及预期、客户议价、技术路线切换",
    rs: 17,
    themeScore: 9,
    flow: 8,
    structure: 8,
    catalyst: 8,
    growth: 9,
    position: 8,
    valuation: 7,
    cashflow: 5,
    governance: 5,
    riskPenalty: 8,
    trend: [38, 43, 49, 53, 61, 68, 76, 82, 85],
    sample: true,
  },
  {
    name: "高股息模板",
    code: "DEMO-003",
    theme: "高股息",
    tags: ["防守", "现金流"],
    thesis: "弱市中用现金流和分红稳定组合波动，不追求价值突变速度。",
    riskNotes: "利率反转、盈利下修、周期回落",
    rs: 12,
    themeScore: 7,
    flow: 5,
    structure: 7,
    catalyst: 5,
    growth: 5,
    position: 7,
    valuation: 9,
    cashflow: 8,
    governance: 6,
    riskPenalty: 4,
    trend: [61, 63, 64, 65, 66, 65, 67, 68, 68],
    sample: true,
  },
];

let database: DatabaseSync | undefined;

export function getDb(): DatabaseSync {
  if (!database) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    database = new DatabaseSync(DB_PATH);
    initialize(database);
  }
  return database;
}

export async function getAppState(): Promise<AppState> {
  const db = getDb();
  const settings = readSettings(db);
  const candidates = readCandidates(db);
  const candidateMap = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const holdings = readHoldings(db, candidateMap, settings);
  const journal = readJournal(db);
  const themes = deriveThemes(candidates);
  const dueToday = new Date().toISOString().slice(0, 10);

  return {
    version: 3,
    updatedAt: readSetting(db, "updatedAt", new Date().toISOString()),
    settings,
    candidates,
    themes,
    holdings,
    journal,
    metrics: {
      candidateCount: candidates.length,
      topTheme: themes[0]?.name || "无",
      avgScore: candidates.length
        ? Math.round(candidates.reduce((sum, candidate) => sum + candidate.scores.total, 0) / candidates.length)
        : 0,
      highRiskCount: candidates.filter((candidate) => candidate.scores.risk >= 10).length,
      exposure: holdings.reduce((sum, holding) => sum + holding.value, 0),
      dueJournal: journal.filter((entry) => entry.reviewDate && entry.reviewDate <= dueToday).length,
    },
  };
}

export async function upsertCandidate(input: CandidateInput): Promise<Candidate> {
  const db = getDb();
  const existing = input.id
    ? findCandidateById(db, input.id)
    : input.code
      ? findCandidateByCode(db, String(input.code))
      : undefined;
  const candidate = normalizeCandidate(input, existing);
  writeCandidate(db, candidate);
  touch(db);
  return candidate;
}

export async function deleteCandidate(id: string): Promise<void> {
  const db = getDb();
  db.prepare("DELETE FROM candidates WHERE id = ?").run(id);
  db.prepare("DELETE FROM holdings WHERE candidate_id = ?").run(id);
  db.prepare("DELETE FROM journal WHERE candidate_id = ?").run(id);
  touch(db);
}

export async function importCandidatesCsv(csv: string): Promise<CsvImportResult> {
  const rows = parseCsv(csv);
  let imported = 0;
  for (const row of rows) {
    if (row.name && row.code && row.theme) {
      await upsertCandidate(row);
      imported += 1;
    }
  }
  return { imported, state: await getAppState() };
}

export async function addHolding(input: HoldingInput): Promise<void> {
  const db = getDb();
  db.prepare(
    `INSERT INTO holdings (
      id, candidate_id, custom_name, cost, quantity, target_weight, conviction, stage, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    String(input.candidateId || ""),
    String(input.customName || "").trim(),
    numberOr(input.cost, 0),
    numberOr(input.quantity, 0),
    numberOr(input.targetWeight, 0),
    String(input.conviction || "中"),
    String(input.stage || "验证"),
    new Date().toISOString(),
  );
  touch(db);
}

export async function deleteHolding(id: string): Promise<void> {
  const db = getDb();
  db.prepare("DELETE FROM holdings WHERE id = ?").run(id);
  touch(db);
}

export async function addJournal(input: JournalInput): Promise<void> {
  const db = getDb();
  db.prepare(
    `INSERT INTO journal (
      id, candidate_id, decision, thesis, mutation, verification, invalidation, review_date, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    String(input.candidateId || ""),
    String(input.decision || "观察"),
    String(input.thesis || "").trim(),
    String(input.mutation || "").trim(),
    String(input.verification || "").trim(),
    String(input.invalidation || "").trim(),
    String(input.reviewDate || ""),
    new Date().toISOString(),
  );
  touch(db);
}

export async function deleteJournal(id: string): Promise<void> {
  const db = getDb();
  db.prepare("DELETE FROM journal WHERE id = ?").run(id);
  touch(db);
}

export async function clearJournal(): Promise<void> {
  const db = getDb();
  db.prepare("DELETE FROM journal").run();
  touch(db);
}

export async function exportJson(): Promise<AppState> {
  return getAppState();
}

export async function refreshQuotes(): Promise<QuoteRefreshResult> {
  const db = getDb();
  const candidates = readCandidates(db);
  const symbolMap = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const symbol = deriveYahooSymbol(candidate);
    if (symbol && !symbol.startsWith("DEMO")) symbolMap.set(symbol, candidate);
  }

  const symbols = [...symbolMap.keys()].slice(0, 50);
  if (!symbols.length) return { updated: 0, skipped: candidates.length, message: "no_symbols", state: await getAppState() };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(","))}`;
    const response = await fetch(url, {
      headers: { "User-Agent": "mutation-radar/1.0" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`quote_http_${response.status}`);
    const payload = (await response.json()) as {
      quoteResponse?: {
        result?: Array<{
          symbol: string;
          regularMarketPrice?: number;
          regularMarketChangePercent?: number;
          regularMarketVolume?: number;
        }>;
      };
    };
    const now = new Date().toISOString();
    let updated = 0;
    for (const quote of payload.quoteResponse?.result || []) {
      const candidate = symbolMap.get(quote.symbol);
      if (!candidate) continue;
      const last = candidate.trend[candidate.trend.length - 1] ?? 60;
      const change = nullableNumber(quote.regularMarketChangePercent);
      writeCandidate(db, {
        ...candidate,
        price: nullableNumber(quote.regularMarketPrice),
        changePct: change,
        volume: nullableNumber(quote.regularMarketVolume),
        lastQuoteAt: now,
        quoteSource: "Yahoo Finance",
        trend: normalizeTrend([...candidate.trend, clamp(last + (change || 0), 0, 100)]),
        updatedAt: now,
      });
      updated += 1;
    }
    touch(db);
    return { updated, requested: symbols.length, source: "Yahoo Finance", state: await getAppState() };
  } finally {
    clearTimeout(timer);
  }
}

function initialize(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS candidates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      symbol TEXT NOT NULL DEFAULT '',
      theme TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      thesis TEXT NOT NULL DEFAULT '',
      risk_notes TEXT NOT NULL DEFAULT '',
      market_json TEXT NOT NULL,
      fundamental_json TEXT NOT NULL,
      risk_penalty REAL NOT NULL DEFAULT 0,
      price REAL,
      change_pct REAL,
      volume REAL,
      last_quote_at TEXT,
      quote_source TEXT,
      trend_json TEXT NOT NULL,
      sample INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS holdings (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL DEFAULT '',
      custom_name TEXT NOT NULL DEFAULT '',
      cost REAL NOT NULL DEFAULT 0,
      quantity REAL NOT NULL DEFAULT 0,
      target_weight REAL NOT NULL DEFAULT 0,
      conviction TEXT NOT NULL DEFAULT '中',
      stage TEXT NOT NULL DEFAULT '验证',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS journal (
      id TEXT PRIMARY KEY,
      candidate_id TEXT NOT NULL DEFAULT '',
      decision TEXT NOT NULL DEFAULT '观察',
      thesis TEXT NOT NULL DEFAULT '',
      mutation TEXT NOT NULL DEFAULT '',
      verification TEXT NOT NULL DEFAULT '',
      invalidation TEXT NOT NULL DEFAULT '',
      review_date TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
  `);
  seedIfEmpty(db);
}

function seedIfEmpty(db: DatabaseSync): void {
  const count = Number(db.prepare("SELECT COUNT(*) AS count FROM candidates").get()?.count || 0);
  if (count > 0) return;

  const legacy = readLegacyDb();
  const legacyCandidates = legacy?.candidates?.length ? legacy.candidates : seedCandidates;
  for (const item of legacyCandidates) {
    writeCandidate(db, normalizeCandidate(mapLegacyCandidate(item as CandidateInput)));
  }

  const settings: Settings = {
    marketPhase: String(legacy?.settings?.marketPhase || "均衡"),
    maxSingleWeight: numberOr(legacy?.settings?.maxSingleWeight, 20),
    weakMarketMaxWeight: numberOr(legacy?.settings?.weakMarketMaxWeight, 8),
  };
  writeSetting(db, "marketPhase", settings.marketPhase);
  writeSetting(db, "maxSingleWeight", String(settings.maxSingleWeight));
  writeSetting(db, "weakMarketMaxWeight", String(settings.weakMarketMaxWeight));
  touch(db);
}

function readLegacyDb(): LegacyDb | undefined {
  if (!fs.existsSync(LEGACY_JSON_PATH)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(LEGACY_JSON_PATH, "utf8")) as LegacyDb;
  } catch {
    return undefined;
  }
}

function mapLegacyCandidate(item: Record<string, unknown>): CandidateInput {
  const market = (item.market || {}) as Record<string, unknown>;
  const fundamental = (item.fundamental || {}) as Record<string, unknown>;
  return {
    id: String(item.id || ""),
    name: String(item.name || ""),
    code: String(item.code || ""),
    symbol: String(item.symbol || ""),
    theme: String(item.theme || ""),
    tags: (item.tags || []) as string[],
    thesis: String(item.thesis || ""),
    riskNotes: String(item.riskNotes || item.risk_notes || ""),
    rs: market.rs as string | number | undefined,
    themeScore: market.theme as string | number | undefined,
    flow: market.flow as string | number | undefined,
    structure: market.structure as string | number | undefined,
    catalyst: market.catalyst as string | number | undefined,
    growth: fundamental.growth as string | number | undefined,
    position: fundamental.position as string | number | undefined,
    valuation: fundamental.valuation as string | number | undefined,
    cashflow: fundamental.cashflow as string | number | undefined,
    governance: fundamental.governance as string | number | undefined,
    riskPenalty: item.riskPenalty as string | number | undefined,
    price: item.price as string | number | null | undefined,
    changePct: item.changePct as string | number | null | undefined,
    volume: item.volume as string | number | null | undefined,
    trend: item.trend as number[] | string | undefined,
    sample: Boolean(item.sample),
  };
}

function normalizeCandidate(input: CandidateInput, previous?: Candidate): Candidate {
  const now = new Date().toISOString();
  const market: MarketScores = {
    rs: clamp(input.rs ?? previous?.market.rs ?? 0, 0, 20),
    theme: clamp(input.themeScore ?? previous?.market.theme ?? 0, 0, 10),
    flow: clamp(input.flow ?? previous?.market.flow ?? 0, 0, 10),
    structure: clamp(input.structure ?? previous?.market.structure ?? 0, 0, 10),
    catalyst: clamp(input.catalyst ?? previous?.market.catalyst ?? 0, 0, 10),
  };
  const fundamental: FundamentalScores = {
    growth: clamp(input.growth ?? previous?.fundamental.growth ?? 0, 0, 12),
    position: clamp(input.position ?? previous?.fundamental.position ?? 0, 0, 8),
    valuation: clamp(input.valuation ?? previous?.fundamental.valuation ?? 0, 0, 8),
    cashflow: clamp(input.cashflow ?? previous?.fundamental.cashflow ?? 0, 0, 6),
    governance: clamp(input.governance ?? previous?.fundamental.governance ?? 0, 0, 6),
  };
  const candidate: Candidate = {
    id: previous?.id || input.id || randomUUID(),
    name: String(input.name ?? previous?.name ?? "").trim(),
    code: String(input.code ?? previous?.code ?? "").trim(),
    symbol: String(input.symbol ?? previous?.symbol ?? "").trim(),
    theme: String(input.theme ?? previous?.theme ?? "").trim(),
    tags: splitTags(input.tags ?? previous?.tags),
    thesis: String(input.thesis ?? previous?.thesis ?? "").trim(),
    riskNotes: String(input.riskNotes ?? previous?.riskNotes ?? "").trim(),
    market,
    fundamental,
    riskPenalty: clamp(input.riskPenalty ?? previous?.riskPenalty ?? 0, 0, 30),
    price: nullableNumber(input.price ?? previous?.price),
    changePct: nullableNumber(input.changePct ?? previous?.changePct),
    volume: nullableNumber(input.volume ?? previous?.volume),
    lastQuoteAt: previous?.lastQuoteAt || null,
    quoteSource: previous?.quoteSource || null,
    trend: normalizeTrend(input.trend ?? previous?.trend),
    sample: Boolean(input.sample ?? previous?.sample ?? false),
    createdAt: previous?.createdAt || now,
    updatedAt: now,
    scores: { market: 0, fundamental: 0, risk: 0, total: 0 },
  };
  candidate.scores = scoreCandidate(candidate);
  return candidate;
}

function writeCandidate(db: DatabaseSync, candidate: Candidate): void {
  db.prepare(
    `INSERT INTO candidates (
      id, name, code, symbol, theme, tags_json, thesis, risk_notes, market_json, fundamental_json,
      risk_penalty, price, change_pct, volume, last_quote_at, quote_source, trend_json, sample, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET
      id = excluded.id,
      name = excluded.name,
      symbol = excluded.symbol,
      theme = excluded.theme,
      tags_json = excluded.tags_json,
      thesis = excluded.thesis,
      risk_notes = excluded.risk_notes,
      market_json = excluded.market_json,
      fundamental_json = excluded.fundamental_json,
      risk_penalty = excluded.risk_penalty,
      price = excluded.price,
      change_pct = excluded.change_pct,
      volume = excluded.volume,
      last_quote_at = excluded.last_quote_at,
      quote_source = excluded.quote_source,
      trend_json = excluded.trend_json,
      sample = excluded.sample,
      updated_at = excluded.updated_at`,
  ).run(
    candidate.id,
    candidate.name,
    candidate.code,
    candidate.symbol,
    candidate.theme,
    JSON.stringify(candidate.tags),
    candidate.thesis,
    candidate.riskNotes,
    JSON.stringify(candidate.market),
    JSON.stringify(candidate.fundamental),
    candidate.riskPenalty,
    candidate.price,
    candidate.changePct,
    candidate.volume,
    candidate.lastQuoteAt,
    candidate.quoteSource,
    JSON.stringify(candidate.trend),
    candidate.sample ? 1 : 0,
    candidate.createdAt,
    candidate.updatedAt,
  );
}

function readCandidates(db: DatabaseSync): Candidate[] {
  return db
    .prepare("SELECT * FROM candidates ORDER BY sample ASC, updated_at DESC, created_at DESC")
    .all()
    .map((row) => candidateFromRow(row as CandidateRow));
}

function findCandidateById(db: DatabaseSync, id: string): Candidate | undefined {
  const row = db.prepare("SELECT * FROM candidates WHERE id = ?").get(id);
  return row ? candidateFromRow(row as CandidateRow) : undefined;
}

function findCandidateByCode(db: DatabaseSync, code: string): Candidate | undefined {
  const row = db.prepare("SELECT * FROM candidates WHERE code = ?").get(code);
  return row ? candidateFromRow(row as CandidateRow) : undefined;
}

function candidateFromRow(row: CandidateRow): Candidate {
  const candidate: Candidate = {
    id: row.id,
    name: row.name,
    code: row.code,
    symbol: row.symbol,
    theme: row.theme,
    tags: safeJson<string[]>(row.tags_json, []),
    thesis: row.thesis,
    riskNotes: row.risk_notes,
    market: safeJson<MarketScores>(row.market_json, { rs: 0, theme: 0, flow: 0, structure: 0, catalyst: 0 }),
    fundamental: safeJson<FundamentalScores>(row.fundamental_json, {
      growth: 0,
      position: 0,
      valuation: 0,
      cashflow: 0,
      governance: 0,
    }),
    riskPenalty: Number(row.risk_penalty || 0),
    price: nullableNumber(row.price),
    changePct: nullableNumber(row.change_pct),
    volume: nullableNumber(row.volume),
    lastQuoteAt: row.last_quote_at,
    quoteSource: row.quote_source,
    trend: safeJson<number[]>(row.trend_json, [40, 45, 50]),
    sample: Boolean(row.sample),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    scores: { market: 0, fundamental: 0, risk: 0, total: 0 },
  };
  candidate.scores = scoreCandidate(candidate);
  return candidate;
}

function readHoldings(db: DatabaseSync, candidates: Map<string, Candidate>, settings: Settings): Holding[] {
  return db
    .prepare("SELECT * FROM holdings ORDER BY created_at DESC")
    .all()
    .map((row) => {
      const item = row as HoldingRow;
      const candidate = candidates.get(item.candidate_id);
      const value = Number(item.cost || 0) * Number(item.quantity || 0);
      return {
        id: item.id,
        candidateId: item.candidate_id,
        customName: item.custom_name,
        cost: Number(item.cost || 0),
        quantity: Number(item.quantity || 0),
        targetWeight: Number(item.target_weight || 0),
        conviction: item.conviction,
        stage: item.stage,
        createdAt: item.created_at,
        value,
        candidateName: candidate?.name || item.custom_name,
        theme: candidate?.theme || "未归类",
        health: healthFor(candidate, { targetWeight: Number(item.target_weight || 0), stage: item.stage } as Holding, settings),
      };
    });
}

function readJournal(db: DatabaseSync): JournalEntry[] {
  return db
    .prepare("SELECT * FROM journal ORDER BY created_at DESC")
    .all()
    .map((row) => {
      const item = row as JournalRow;
      return {
        id: item.id,
        candidateId: item.candidate_id,
        decision: item.decision,
        thesis: item.thesis,
        mutation: item.mutation,
        verification: item.verification,
        invalidation: item.invalidation,
        reviewDate: item.review_date,
        createdAt: item.created_at,
      };
    });
}

function readSettings(db: DatabaseSync): Settings {
  return {
    marketPhase: readSetting(db, "marketPhase", "均衡"),
    maxSingleWeight: Number(readSetting(db, "maxSingleWeight", "20")),
    weakMarketMaxWeight: Number(readSetting(db, "weakMarketMaxWeight", "8")),
  };
}

function readSetting(db: DatabaseSync, key: string, fallback: string): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row?.value ? String(row.value) : fallback;
}

function writeSetting(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
}

function touch(db: DatabaseSync): void {
  writeSetting(db, "updatedAt", new Date().toISOString());
}

function safeJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function deriveYahooSymbol(candidate: Candidate): string {
  const raw = String(candidate.symbol || candidate.code || "").trim().toUpperCase();
  if (!raw) return "";
  if (raw.includes(".")) return raw;
  if (/^HK\d{4,5}$/.test(raw)) return `${raw.replace(/^HK/, "").padStart(4, "0")}.HK`;
  if (/^\d{5}$/.test(raw)) return `${raw}.HK`;
  if (/^6\d{5}$/.test(raw)) return `${raw}.SS`;
  if (/^[03]\d{5}$/.test(raw)) return `${raw}.SZ`;
  return raw;
}

export async function backupSqlite(): Promise<string> {
  const target = path.join(DATA_DIR, `radar-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);
  await fsp.copyFile(DB_PATH, target);
  return target;
}
