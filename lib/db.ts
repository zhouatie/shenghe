import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  buildMarketSuggestion,
  buildPlateCandidateDrafts,
  emptyPlateState,
  fetchPlateDetail,
  fetchPlateRotationSnapshot,
} from "@/lib/plate-rotation";
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
  PlateCandidateDraft,
  PlateCurve,
  PlateDetail,
  PlateRankingItem,
  PlateRefreshResult,
  PlateRefreshStatus,
  PlateRotationSource,
  PlateRotationState,
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

type PlateRankingRow = Row & {
  source: PlateRotationSource;
  trade_date: string;
  rank: number;
  code: string;
  name: string;
  value: string;
  numeric_value: number | null;
  value_type: "score" | "pct";
  color: "red" | "green";
  refreshed_at: string;
};

type PlatePayloadRow = Row & {
  kind: string;
  source: string;
  plate_code: string;
  payload_json: string;
  status: string;
  message: string;
  refreshed_at: string;
};

type LegacyDb = {
  settings?: Partial<Settings>;
  candidates?: Array<Record<string, unknown>>;
  holdings?: Array<Record<string, unknown>>;
  journal?: Array<Record<string, unknown>>;
};

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
  const plate = readPlateState(db, candidates);
  const dueToday = new Date().toISOString().slice(0, 10);

  return {
    version: 4,
    updatedAt: readSetting(db, "updatedAt", new Date().toISOString()),
    settings,
    candidates,
    themes,
    plate,
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

export async function refreshPlateRotationData(): Promise<PlateRefreshResult> {
  const db = getDb();
  const snapshot = await fetchPlateRotationSnapshot();
  writePlateRankings(db, [...snapshot.rankings.kaipan, ...snapshot.rankings.ths]);
  if (snapshot.curves.kaipan) writePlatePayload(db, "curve", "kaipan", "", snapshot.curves.kaipan, snapshot.status);
  if (snapshot.curves.ths) writePlatePayload(db, "curve", "ths", "", snapshot.curves.ths, snapshot.status);
  for (const detail of snapshot.details) writePlatePayload(db, "detail", detail.source, detail.plateCode, detail, snapshot.status);
  writePlatePayload(db, "status", "all", "", snapshot.status, snapshot.status);
  touch(db);
  const updated =
    snapshot.rankings.kaipan.length +
    snapshot.rankings.ths.length +
    snapshot.details.length +
    Number(Boolean(snapshot.curves.kaipan)) +
    Number(Boolean(snapshot.curves.ths));
  return {
    ok: snapshot.status.ok,
    updated,
    message: snapshot.status.message,
    state: await getAppState(),
  };
}

export async function refreshPlateDetailData(plateCode: string, plateName = ""): Promise<PlateRefreshResult> {
  const db = getDb();
  const detail = await fetchPlateDetail(plateCode, plateName);
  const status: PlateRefreshStatus = {
    ok: true,
    message: `已刷新 ${detail.plateName} 龙头和强度数据`,
    refreshedAt: detail.refreshedAt,
  };
  writePlatePayload(db, "detail", detail.source, detail.plateCode, detail, status);
  writePlatePayload(db, "status", "all", "", status, status);
  touch(db);
  return { ok: true, updated: 1, message: status.message, state: await getAppState() };
}

export async function applyCandidateMarketSuggestion(candidateId: string): Promise<AppState> {
  const db = getDb();
  const candidate = findCandidateById(db, candidateId);
  if (!candidate) throw new Error("标的不存在");
  const suggestion = buildMarketSuggestion(candidate, readPlateState(db, [candidate]));
  if (!suggestion) throw new Error("暂无可采纳的板块市场建议");
  const next: Candidate = {
    ...candidate,
    market: suggestion.market,
    updatedAt: new Date().toISOString(),
    scores: { market: 0, fundamental: 0, risk: 0, total: 0 },
  };
  next.scores = scoreCandidate(next);
  writeCandidate(db, next);
  touch(db);
  return getAppState();
}

export async function confirmPlateCandidateDraft(draft: PlateCandidateDraft): Promise<AppState> {
  await upsertCandidate({
    name: draft.name,
    code: draft.code,
    theme: draft.theme,
    tags: draft.tags,
    thesis: draft.thesis,
    riskNotes: draft.riskNotes,
    rs: draft.market.rs,
    themeScore: draft.market.theme,
    flow: draft.market.flow,
    structure: draft.market.structure,
    catalyst: draft.market.catalyst,
    sample: false,
  });
  return getAppState();
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
    CREATE TABLE IF NOT EXISTS plate_rankings (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      rank INTEGER NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      value TEXT NOT NULL,
      numeric_value REAL,
      value_type TEXT NOT NULL,
      color TEXT NOT NULL,
      refreshed_at TEXT NOT NULL,
      UNIQUE(source, trade_date, rank, code)
    );
    CREATE INDEX IF NOT EXISTS idx_plate_rankings_latest
      ON plate_rankings(source, refreshed_at, rank);
    CREATE TABLE IF NOT EXISTS plate_payloads (
      kind TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT '',
      plate_code TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      refreshed_at TEXT NOT NULL,
      PRIMARY KEY(kind, source, plate_code)
    );
  `);
  removeMockCandidates(db);
  seedIfEmpty(db);
}

function seedIfEmpty(db: DatabaseSync): void {
  const count = Number(db.prepare("SELECT COUNT(*) AS count FROM candidates").get()?.count || 0);
  if (count > 0) return;

  const legacy = readLegacyDb();
  const legacyCandidates = (legacy?.candidates || []).filter(isRealLegacyCandidate);
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

function removeMockCandidates(db: DatabaseSync): void {
  const ids = db
    .prepare("SELECT id FROM candidates WHERE sample = 1 OR code LIKE 'DEMO-%'")
    .all()
    .map((row) => String((row as { id: string }).id || ""))
    .filter(Boolean);
  for (const id of ids) {
    db.prepare("DELETE FROM holdings WHERE candidate_id = ?").run(id);
    db.prepare("DELETE FROM journal WHERE candidate_id = ?").run(id);
  }
  db.prepare("DELETE FROM candidates WHERE sample = 1 OR code LIKE 'DEMO-%'").run();
}

function isRealLegacyCandidate(item: Record<string, unknown>): boolean {
  const code = String(item.code || "").trim();
  return Boolean(item.name && code && item.theme && !item.sample && !code.toUpperCase().startsWith("DEMO-"));
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

function writePlateRankings(db: DatabaseSync, rankings: PlateRankingItem[]): void {
  const statement = db.prepare(
    `INSERT INTO plate_rankings (
      id, source, trade_date, rank, code, name, value, numeric_value, value_type, color, refreshed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, trade_date, rank, code) DO UPDATE SET
      name = excluded.name,
      value = excluded.value,
      numeric_value = excluded.numeric_value,
      value_type = excluded.value_type,
      color = excluded.color,
      refreshed_at = excluded.refreshed_at`,
  );
  for (const item of rankings) {
    statement.run(
      `${item.source}:${item.tradeDate}:${item.rank}:${item.code}`,
      item.source,
      item.tradeDate,
      item.rank,
      item.code,
      item.name,
      item.value,
      item.numericValue,
      item.valueType,
      item.color,
      item.refreshedAt,
    );
  }
}

function writePlatePayload(
  db: DatabaseSync,
  kind: string,
  source: string,
  plateCode: string,
  payload: unknown,
  status: PlateRefreshStatus,
): void {
  db.prepare(
    `INSERT INTO plate_payloads (
      kind, source, plate_code, payload_json, status, message, refreshed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(kind, source, plate_code) DO UPDATE SET
      payload_json = excluded.payload_json,
      status = excluded.status,
      message = excluded.message,
      refreshed_at = excluded.refreshed_at`,
  ).run(kind, source, plateCode, JSON.stringify(payload), status.ok ? "ok" : "error", status.message, status.refreshedAt);
}

function readPlateState(db: DatabaseSync, candidates: Candidate[]): PlateRotationState {
  const state = emptyPlateState();
  state.rankings.kaipan = readLatestPlateRankings(db, "kaipan");
  state.rankings.ths = readLatestPlateRankings(db, "ths");
  state.curves.kaipan = readPlatePayload<PlateCurve>(db, "curve", "kaipan", "");
  state.curves.ths = readPlatePayload<PlateCurve>(db, "curve", "ths", "");
  state.details = readPlateDetails(db);
  state.status = readPlatePayload<PlateRefreshStatus>(db, "status", "all", "");
  state.suggestions = candidates
    .map((candidate) => buildMarketSuggestion(candidate, state))
    .filter((suggestion): suggestion is NonNullable<typeof suggestion> => Boolean(suggestion));
  state.drafts = buildPlateCandidateDrafts(state);
  return state;
}

function readLatestPlateRankings(db: DatabaseSync, source: PlateRotationSource): PlateRankingItem[] {
  const latest = db
    .prepare("SELECT refreshed_at FROM plate_rankings WHERE source = ? ORDER BY refreshed_at DESC LIMIT 1")
    .get(source) as { refreshed_at?: string } | undefined;
  if (!latest?.refreshed_at) return [];
  return db
    .prepare("SELECT * FROM plate_rankings WHERE source = ? AND refreshed_at = ? ORDER BY rank ASC")
    .all(source, latest.refreshed_at)
    .map((row) => plateRankingFromRow(row as PlateRankingRow));
}

function plateRankingFromRow(row: PlateRankingRow): PlateRankingItem {
  return {
    source: row.source,
    tradeDate: row.trade_date,
    rank: Number(row.rank),
    code: row.code,
    name: row.name,
    value: row.value,
    numericValue: nullableNumber(row.numeric_value),
    valueType: row.value_type,
    color: row.color,
    refreshedAt: row.refreshed_at,
  };
}

function readPlatePayload<T>(db: DatabaseSync, kind: string, source: string, plateCode: string): T | null {
  const row = db
    .prepare("SELECT payload_json FROM plate_payloads WHERE kind = ? AND source = ? AND plate_code = ?")
    .get(kind, source, plateCode) as { payload_json?: string } | undefined;
  return row?.payload_json ? safeJson<T>(row.payload_json, null as T) : null;
}

function readPlateDetails(db: DatabaseSync): PlateDetail[] {
  return db
    .prepare("SELECT * FROM plate_payloads WHERE kind = 'detail' ORDER BY refreshed_at DESC LIMIT 10")
    .all()
    .map((row) => safeJson<PlateDetail>((row as PlatePayloadRow).payload_json, null as unknown as PlateDetail))
    .filter((detail): detail is PlateDetail => Boolean(detail?.plateCode));
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
