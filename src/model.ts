export const LISTS = ["today", "tomorrow", "backlog", "blocker"] as const;
export type ListId = typeof LISTS[number];

export const LIST_LABEL: Record<ListId, string> = {
  today: "Heute",
  tomorrow: "Morgen",
  backlog: "Backlog",
  blocker: "Blocker",
};

export const PRIOS = ["A", "B", "C", "D"] as const;
export type Prio = typeof PRIOS[number];

/** Datumsfelder sind ISO-Strings (YYYY-MM-DD), leer = nicht gesetzt. */
export interface Task {
  id: string;
  text: string;
  prio: Prio;
  list: ListId;
  description: string;
  date: string;
  deadline: string;
  blocker: string;
  done: boolean;
  /** Position in der eigenen (Drag-and-drop-)Reihenfolge. */
  pos: number;
}

export type TaskInput = Omit<Task, "id" | "done" | "pos">;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

const MAX_SHORT = 200;
const MAX_DESCRIPTION = 5000;

/** Echtes Kalenderdatum (YYYY-MM-DD), nicht nur das Format. */
export function isIsoDate(v: string): boolean {
  if (!ISO.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().startsWith(v);
}

export const isList = (v: unknown): v is ListId => LISTS.includes(v as ListId);

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Frühester gesetzter Tag aus Datum und Deadline. */
export function dueDay(t: Pick<Task, "date" | "deadline">): string | null {
  const days = [t.date, t.deadline].filter(Boolean).sort();
  return days[0] ?? null;
}

/** Liste, in die ein Task wegen Datum/Deadline gehört (null = keine). */
export function routeByDate(
  t: Pick<Task, "date" | "deadline">,
  today: string,
): ListId | null {
  const due = dueDay(t);
  if (!due) return null;
  if (due <= today) return "today";
  if (due === addDays(today, 1)) return "tomorrow";
  return null;
}

export type ParseResult =
  | { ok: true; value: TaskInput }
  | { ok: false; error: string };

export function parseInput(form: Record<string, unknown>): ParseResult {
  const str = (k: string) => String(form[k] ?? "").trim();
  const text = str("text");
  if (!text) return { ok: false, error: "Task fehlt" };
  if (text.length > MAX_SHORT) return { ok: false, error: "Task zu lang" };
  const prio = str("prio");
  if (!PRIOS.includes(prio as Prio)) {
    return { ok: false, error: "Priorität fehlt" };
  }
  const list = str("list");
  if (!isList(list)) return { ok: false, error: "Liste fehlt" };
  const blocker = str("blocker");
  if (list === "blocker" && !blocker) {
    return { ok: false, error: "Blocker fehlt" };
  }
  if (blocker.length > MAX_SHORT) {
    return { ok: false, error: "Blocker zu lang" };
  }
  const description = str("description");
  if (description.length > MAX_DESCRIPTION) {
    return { ok: false, error: "Beschreibung zu lang" };
  }
  const date = str("date");
  const deadline = str("deadline");
  for (const d of [date, deadline]) {
    if (d && !isIsoDate(d)) return { ok: false, error: "Ungültiges Datum" };
  }
  return {
    ok: true,
    value: {
      text,
      prio: prio as Prio,
      list,
      description,
      date,
      deadline,
      blocker,
    },
  };
}

export const SORT_KEYS = ["prio", "alpha", "due", "custom"] as const;
export type SortKey = typeof SORT_KEYS[number];
export type SortDir = "asc" | "desc";
export interface Sort {
  key: SortKey;
  dir: SortDir;
}

export const SORT_LABEL: Record<SortKey, string> = {
  prio: "Priorität",
  alpha: "A–Z",
  due: "Fällig",
  custom: "Eigene",
};

export const DEFAULT_SORT: Sort = { key: "prio", dir: "asc" };

export function parseSort(key: unknown, dir: unknown): Sort | null {
  if (!SORT_KEYS.includes(key as SortKey)) return null;
  if (dir !== "asc" && dir !== "desc") return null;
  return { key: key as SortKey, dir };
}

/**
 * Sortiert Tasks (Eingabe in Custom-Reihenfolge). Erledigte stehen immer am
 * Ende, in Reihenfolge des Abhakens (zuletzt erledigt ganz unten, siehe
 * Store.toggle); sie werden nicht umsortiert. Gleichstand behält die eigene
 * Reihenfolge. Tasks ohne Fälligkeit stehen bei „Fälligkeit“ in beiden
 * Richtungen hinten.
 */
export function sortTasks(tasks: Task[], { key, dir }: Sort): Task[] {
  const sign = dir === "asc" ? 1 : -1;
  const cmp = (a: Task, b: Task): number => {
    if (key === "prio") return sign * a.prio.localeCompare(b.prio);
    if (key === "alpha") {
      return sign * a.text.localeCompare(b.text, "de", { sensitivity: "base" });
    }
    if (key === "due") {
      const x = dueDay(a), y = dueDay(b);
      if (x === y) return 0;
      if (!x) return 1;
      if (!y) return -1;
      return sign * (x < y ? -1 : 1);
    }
    return 0;
  };
  const open = tasks.filter((t) => !t.done).sort(cmp);
  if (key === "custom" && dir === "desc") open.reverse();
  return [...open, ...tasks.filter((t) => t.done)];
}

/** Wiederkehrende Vorlage: erzeugt Tasks mit gesetztem Tag. */
export const KINDS = ["weekly", "monthly"] as const;
export type Kind = typeof KINDS[number];

export interface Series {
  id: string;
  text: string;
  prio: Prio;
  description: string;
  kind: Kind;
  /** weekly: Wochentage 1 (Mo) bis 7 (So); monthly: Monatstage 1 bis 31. */
  days: number[];
  /** Letzter Tag, für den Tasks erzeugt wurden. */
  last: string;
}

export type SeriesInput = Omit<Series, "id" | "last">;

export const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"] as const;

/** Fällt `iso` auf einen Tag der Serie? Monatstage > Monatslänge → Monatsende. */
export function occursOn(s: Pick<Series, "kind" | "days">, iso: string) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (s.kind === "weekly") return s.days.includes(d.getUTCDay() || 7);
  const day = d.getUTCDate();
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
    .getUTCDate();
  return s.days.includes(day) || (day === last && s.days.some((x) => x > last));
}

export function describeSeries(s: Pick<Series, "kind" | "days">): string {
  const days = [...s.days].sort((a, b) => a - b);
  if (s.kind === "weekly") {
    return days.length === 7
      ? "Täglich"
      : `Wöchentlich ${days.map((d) => WEEKDAYS[d - 1]).join(", ")}`;
  }
  return `Monatlich am ${days.map((d) => `${d}.`).join(", ")}`;
}

export type SeriesResult =
  | { ok: true; value: SeriesInput }
  | { ok: false; error: string };

/** `wd`: Wochentage (mehrfach), `md`: Monatstage als „1, 15“. */
export function parseSeries(form: Record<string, unknown>): SeriesResult {
  const base = parseInput({ ...form, list: "backlog" });
  if (!base.ok) return base;
  const kind = String(form.kind ?? "");
  if (!KINDS.includes(kind as Kind)) {
    return { ok: false, error: "Rhythmus fehlt" };
  }
  const raw = kind === "weekly"
    ? [form.wd ?? []].flat().map(String)
    : String(form.md ?? "").split(/[\s,;]+/).filter(Boolean);
  const max = kind === "weekly" ? 7 : 31;
  const days = [...new Set(raw.map(Number))];
  if (days.length === 0) {
    return {
      ok: false,
      error: kind === "weekly" ? "Wochentag fehlt" : "Monatstag fehlt",
    };
  }
  if (days.some((n) => !Number.isInteger(n) || n < 1 || n > max)) {
    return { ok: false, error: "Ungültiger Tag" };
  }
  const { text, prio, description } = base.value;
  return {
    ok: true,
    value: { text, prio, description, kind: kind as Kind, days },
  };
}
