import type { CandidateInput } from "@/lib/types";

export function parseCsv(text: string): CandidateInput[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const input = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if (char === "\n" && !quoted) {
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  if (!rows.length) return [];

  const headers = rows[0].map((value) => value.trim());
  return rows.slice(1).map((values) => {
    const item: Record<string, string> = {};
    headers.forEach((header, index) => {
      item[header] = values[index] ?? "";
    });
    return item;
  });
}

export function splitTags(value: string[] | string | undefined): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return String(value || "")
    .split(/[，,;；]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function numberOr(value: unknown, fallback: number): number {
  const number = nullableNumber(value);
  return number === null ? fallback : number;
}

export function clamp(value: unknown, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

export function normalizeTrend(value: unknown): number[] {
  if (Array.isArray(value)) {
    const points = value.map(Number).filter(Number.isFinite).slice(-12);
    if (points.length >= 2) return points;
  }
  if (typeof value === "string" && value.trim()) {
    const points = value.split(/[，,;；\s]+/).map(Number).filter(Number.isFinite).slice(-12);
    if (points.length >= 2) return points;
  }
  return [40, 45, 48, 52, 55, 58, 60, 62, 65];
}
