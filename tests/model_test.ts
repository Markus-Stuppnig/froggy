import { assertEquals } from "@std/assert";
import {
  occursOn,
  parseInput,
  parseSeries,
  sortTasks,
  type TaskInput,
} from "../src/model.ts";
import { Store } from "../src/store.ts";

const input = (o: Partial<TaskInput> = {}): TaskInput => ({
  text: "t",
  prio: "B",
  list: "backlog",
  description: "",
  date: "",
  deadline: "",
  blocker: "",
  ...o,
});

Deno.test("next day: Morgen -> Heute, Heute bleibt, Erledigte weg", () => {
  const s = new Store("2026-11-23");
  s.add(input({ text: "h", list: "today" }));
  s.add(input({ text: "m", list: "tomorrow" }));
  const d = s.add(input({ text: "done", list: "today" }));
  s.toggle(d.id);
  s.nextDay();
  assertEquals(s.list("today").map((t) => t.text), ["h", "m"]);
  assertEquals(s.tasks.length, 2);
});

Deno.test("Backlog wandert nach Datum/Deadline", () => {
  const s = new Store("2026-11-23");
  s.add(input({ text: "dl", deadline: "2026-11-25" }));
  const d = s.add(input({ text: "date", date: "2026-11-25" }));
  s.add(input({ text: "far", date: "2026-12-24" }));
  s.move(d.id, "backlog");
  assertEquals(s.list("backlog").length, 3);
  s.nextDay(); // heute = 24.
  assertEquals(s.list("tomorrow").map((t) => t.text).sort(), ["date", "dl"]);
  s.nextDay(); // heute = 25.
  assertEquals(s.list("today").map((t) => t.text).sort(), ["date", "dl"]);
  assertEquals(s.list("backlog").map((t) => t.text), ["far"]);
});

Deno.test("Beim Anlegen: Backlog mit Deadline heute/morgen wird geroutet", () => {
  const s = new Store("2026-11-23");
  assertEquals(s.add(input({ deadline: "2026-11-23" })).list, "today");
  assertEquals(s.add(input({ date: "2026-11-24" })).list, "tomorrow");
  assertEquals(s.add(input({ date: "2026-11-30" })).list, "backlog");
  // explizit gewählte Liste bleibt
  assertEquals(
    s.add(input({ list: "tomorrow", deadline: "2026-11-23" })).list,
    "tomorrow",
  );
});

Deno.test("Blocker wandert bei erreichtem Datum, Blocker-Feld bleibt", () => {
  const s = new Store("2026-11-23");
  const t = s.add(
    input({
      list: "blocker",
      blocker: "wartet auf Anna",
      deadline: "2026-11-24",
    }),
  );
  assertEquals(t.list, "blocker");
  s.nextDay();
  assertEquals(s.get(t.id)?.list, "today");
  assertEquals(s.get(t.id)?.blocker, "wartet auf Anna");
});

Deno.test("parseInput validiert Pflichtfelder", () => {
  const ok = { text: "a", prio: "A", list: "today" };
  assertEquals(parseInput(ok).ok, true);
  assertEquals(parseInput({ ...ok, text: " " }).ok, false);
  assertEquals(parseInput({ ...ok, prio: "E" }).ok, false);
  assertEquals(parseInput({ ...ok, list: "blocker" }).ok, false);
  assertEquals(parseInput({ ...ok, list: "blocker", blocker: "x" }).ok, true);
  assertEquals(parseInput({ ...ok, date: "morgen" }).ok, false);
});

Deno.test("Blocker-Review: gelöste Blocker gehen nach Heute", () => {
  const s = new Store("2026-11-23");
  const a = s.add(input({ list: "blocker", blocker: "x" }));
  const b = s.add(input({ list: "blocker", blocker: "y" }));
  assertEquals(s.openBlockers().length, 2);
  s.nextDay([a.id]);
  assertEquals(s.get(a.id)?.list, "today");
  assertEquals(s.get(a.id)?.blocker, "x");
  assertEquals(s.get(b.id)?.list, "blocker");
});

Deno.test("Daten und Tag überleben einen Neustart (SQLite-Datei)", () => {
  const path = Deno.makeTempFileSync({ suffix: ".db" });
  try {
    const a = new Store("2026-11-23", path);
    const t = a.add(input({ text: "bleibt", list: "today" }));
    a.nextDay();
    const b = new Store("2030-01-01", path); // Startwert wird ignoriert
    assertEquals(b.today, "2026-11-24");
    assertEquals(b.get(t.id)?.text, "bleibt");
  } finally {
    for (const f of ["", "-wal", "-shm"]) {
      try {
        Deno.removeSync(path + f);
      } catch { /* nicht vorhanden */ }
    }
  }
});

Deno.test("sortTasks: Priorität, alphabetisch, Fälligkeit, eigene, Richtung", async () => {
  const { Store } = await import("../src/store.ts");
  const { sortTasks } = await import("../src/model.ts");
  const s = new Store("2026-11-23");
  const mk = (text: string, prio: "A" | "B" | "C" | "D", deadline = "") =>
    s.add({
      text,
      prio,
      list: "backlog",
      description: "",
      date: "",
      deadline,
      blocker: "",
    });
  const c = mk("Cäsar", "C", "2026-12-24");
  const a = mk("anna", "A");
  const b = mk("Bert", "B", "2026-12-01");
  s.toggle(a.id);
  const names = (
    key: "prio" | "alpha" | "due" | "custom",
    dir: "asc" | "desc",
  ) => sortTasks(s.list("backlog"), { key, dir }).map((t) => t.text);
  // Erledigte immer am Ende
  assertEquals(names("prio", "asc"), ["Bert", "Cäsar", "anna"]);
  assertEquals(names("prio", "desc"), ["Cäsar", "Bert", "anna"]);
  assertEquals(names("alpha", "asc"), ["Bert", "Cäsar", "anna"]);
  assertEquals(names("alpha", "desc"), ["Cäsar", "Bert", "anna"]);
  assertEquals(names("due", "asc"), ["Bert", "Cäsar", "anna"]);
  assertEquals(names("due", "desc"), ["Cäsar", "Bert", "anna"]);
  assertEquals(names("custom", "asc"), ["Cäsar", "Bert", "anna"]);
  s.reorder("backlog", [b.id, a.id, c.id]);
  assertEquals(names("custom", "asc"), ["Bert", "Cäsar", "anna"]);
  assertEquals(names("custom", "desc"), ["Cäsar", "Bert", "anna"]);
  // Standard und Persistenz
  assertEquals(s.sortOf("today"), { key: "prio", dir: "asc" });
  s.setSort("today", { key: "alpha", dir: "desc" });
  assertEquals(s.sortOf("today"), { key: "alpha", dir: "desc" });
});

Deno.test("Abgehakt: zuletzt erledigter Task steht ganz unten", () => {
  const s = new Store("2026-11-23");
  const a = s.add(input({ text: "a", prio: "A", list: "today" }));
  const b = s.add(input({ text: "b", prio: "B", list: "today" }));
  const c = s.add(input({ text: "c", prio: "C", list: "today" }));
  s.toggle(b.id);
  s.toggle(a.id);
  const order = sortTasks(s.list("today"), { key: "prio", dir: "asc" });
  assertEquals(order.map((t) => t.text), ["c", "b", "a"]);
  s.toggle(c.id);
  assertEquals(
    sortTasks(s.list("today"), { key: "prio", dir: "asc" }).map((t) => t.text),
    ["b", "a", "c"],
  );
});

Deno.test("parseInput lehnt unmögliche Daten und zu lange Texte ab", () => {
  const base = { text: "x", prio: "A", list: "today" };
  assertEquals(parseInput({ ...base, date: "2026-13-45" }).ok, false);
  assertEquals(parseInput({ ...base, deadline: "2026-02-30" }).ok, false);
  assertEquals(parseInput({ ...base, date: "2028-02-29" }).ok, true);
  assertEquals(parseInput({ ...base, text: "x".repeat(201) }).ok, false);
  assertEquals(
    parseInput({ ...base, description: "x".repeat(5001) }).ok,
    false,
  );
});

Deno.test("occursOn: Wochentage und Monatsende", () => {
  // 2026-11-23 ist ein Montag
  assertEquals(occursOn({ kind: "weekly", days: [1] }, "2026-11-23"), true);
  assertEquals(occursOn({ kind: "weekly", days: [1] }, "2026-11-24"), false);
  assertEquals(occursOn({ kind: "weekly", days: [7] }, "2026-11-29"), true);
  assertEquals(occursOn({ kind: "monthly", days: [31] }, "2026-11-30"), true);
  assertEquals(occursOn({ kind: "monthly", days: [31] }, "2026-11-29"), false);
  assertEquals(occursOn({ kind: "monthly", days: [15] }, "2026-12-15"), true);
});

Deno.test("parseSeries validiert", () => {
  const base = { text: "Müll", prio: "C" };
  assertEquals(parseSeries({ ...base, kind: "weekly" }).ok, false);
  assertEquals(
    parseSeries({ ...base, kind: "weekly", wd: ["1", "3"] }).ok,
    true,
  );
  assertEquals(parseSeries({ ...base, kind: "monthly", md: "32" }).ok, false);
  assertEquals(parseSeries({ ...base, kind: "monthly", md: "1, 15" }).ok, true);
});
