import { DatabaseSync } from "node:sqlite";
import {
  addDays,
  DEFAULT_SORT,
  type ListId,
  occursOn,
  parseSort,
  routeByDate,
  type Series,
  type SeriesInput,
  type Sort,
  type Task,
  type TaskInput,
} from "./model.ts";

type Row = Omit<Task, "done"> & { done: number };

const toTask = (r: Row): Task => ({ ...r, done: r.done === 1 });

const SCHEMA = `
  create table if not exists tasks (
    id text primary key,
    text text not null,
    prio text not null,
    list text not null,
    description text not null default '',
    date text not null default '',
    deadline text not null default '',
    blocker text not null default '',
    done integer not null default 0,
    pos integer not null default 0
  );
  create table if not exists series (
    id text primary key,
    text text not null,
    prio text not null,
    description text not null default '',
    kind text not null,
    days text not null,
    last text not null
  );
  create table if not exists meta (
    key text primary key,
    value text not null
  );
`;

/** SQLite-Store. `path` ist eine Datei oder ":memory:". */
export class Store {
  #db: DatabaseSync;

  constructor(today: string, path = ":memory:") {
    this.#db = new DatabaseSync(path);
    this.#db.exec("pragma journal_mode = wal");
    this.#db.exec(SCHEMA);
    const cols = this.#db.prepare("pragma table_info(tasks)").all() as {
      name: string;
    }[];
    if (!cols.some((c) => c.name === "pos")) {
      this.#db.exec(
        "alter table tasks add column pos integer not null default 0",
      );
      this.#db.exec("update tasks set pos = rowid");
    }
    this.#db.prepare("insert or ignore into meta values ('today', ?)").run(
      today,
    );
  }

  /** „Heute“ läuft nur durch nextDay() weiter, nie durch die Uhr. */
  get today(): string {
    const r = this.#db.prepare("select value from meta where key = 'today'")
      .get() as { value: string };
    return r.value;
  }

  get tomorrow(): string {
    return addDays(this.today, 1);
  }

  get tasks(): Task[] {
    return (this.#db.prepare("select * from tasks order by rowid")
      .all() as unknown as Row[]).map(toTask);
  }

  get(id: string): Task | undefined {
    const r = this.#db.prepare("select * from tasks where id = ?").get(id) as
      | Row
      | undefined;
    return r && toTask(r);
  }

  /** Tasks einer Liste in der eigenen Reihenfolge (Sortierung: sortTasks). */
  list(list: ListId): Task[] {
    return (this.#db
      .prepare("select * from tasks where list = ? order by pos, rowid")
      .all(list) as unknown as Row[]).map(toTask);
  }

  sortOf(list: ListId): Sort {
    const r = this.#db.prepare("select value from meta where key = ?")
      .get(`sort:${list}`) as { value: string } | undefined;
    const [key, dir] = (r?.value ?? "").split(":");
    return parseSort(key, dir) ?? DEFAULT_SORT;
  }

  setSort(list: ListId, s: Sort) {
    this.#db.prepare("insert or replace into meta values (?, ?)").run(
      `sort:${list}`,
      `${s.key}:${s.dir}`,
    );
  }

  /** Speichert die eigene Reihenfolge; `ids` in Soll-Reihenfolge (aufsteigend). */
  reorder(list: ListId, ids: string[]) {
    const inList = this.list(list).map((t) => t.id);
    const rest = inList.filter((id) => !ids.includes(id));
    const order = [...ids.filter((id) => inList.includes(id)), ...rest];
    this.#db.exec("begin");
    try {
      const up = this.#db.prepare("update tasks set pos = ? where id = ?");
      order.forEach((id, i) => up.run(i + 1, id));
      this.#db.exec("commit");
    } catch (e) {
      this.#db.exec("rollback");
      throw e;
    }
  }

  #toSeries(r: Record<string, unknown>): Series {
    return { ...r, days: String(r.days).split(",").map(Number) } as Series;
  }

  get series(): Series[] {
    return (this.#db.prepare("select * from series order by rowid").all())
      .map((r) => this.#toSeries(r));
  }

  getSeries(id: string): Series | undefined {
    const r = this.#db.prepare("select * from series where id = ?").get(id);
    return r && this.#toSeries(r);
  }

  addSeries(input: SeriesInput): Series {
    const id = crypto.randomUUID();
    this.#db.prepare(
      "insert into series values (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id,
      input.text,
      input.prio,
      input.description,
      input.kind,
      input.days.join(","),
      addDays(this.today, -1),
    );
    this.#generate();
    return this.getSeries(id)!;
  }

  updateSeries(id: string, input: SeriesInput) {
    this.#db.prepare(
      `update series set text = ?, prio = ?, description = ?, kind = ?,
         days = ? where id = ?`,
    ).run(
      input.text,
      input.prio,
      input.description,
      input.kind,
      input.days.join(","),
      id,
    );
  }

  removeSeries(id: string) {
    this.#db.prepare("delete from series where id = ?").run(id);
  }

  /**
   * Erzeugt Tasks für alle Serien bis einschließlich morgen. Der Tag steht
   * im Task; add() legt ihn in Heute oder Morgen. `last` verhindert Doppelte.
   */
  #generate() {
    const until = this.tomorrow;
    for (const s of this.series) {
      for (let d = addDays(s.last, 1); d <= until; d = addDays(d, 1)) {
        if (!occursOn(s, d)) continue;
        this.add({
          text: s.text,
          prio: s.prio,
          list: "backlog",
          description: s.description,
          date: d,
          deadline: "",
          blocker: "",
        });
      }
      this.#db.prepare("update series set last = ? where id = ?").run(
        until,
        s.id,
      );
    }
  }

  /** Offene Blocker, die vor dem Tageswechsel reviewt werden müssen. */
  openBlockers(): Task[] {
    return this.list("blocker").filter((t) => !t.done);
  }

  /**
   * Beim Speichern wandert ein Backlog-Task mit Datum/Deadline heute oder
   * morgen direkt in Heute bzw. Morgen. Eine explizit gewählte andere Liste
   * bleibt. Blocker lösen sich erst beim Tageswechsel.
   */
  #place(t: Task) {
    if (t.list === "backlog") t.list = routeByDate(t, this.today) ?? t.list;
  }

  add(input: TaskInput): Task {
    const t: Task = { ...input, id: crypto.randomUUID(), done: false, pos: 0 };
    this.#place(t);
    this.#db.prepare(
      `insert into tasks (id, text, prio, list, description, date, deadline, blocker, done, pos)
       values (?, ?, ?, ?, ?, ?, ?, ?, 0,
         (select coalesce(max(pos), 0) + 1 from tasks))`,
    ).run(
      t.id,
      t.text,
      t.prio,
      t.list,
      t.description,
      t.date,
      t.deadline,
      t.blocker,
    );
    return this.get(t.id)!;
  }

  update(id: string, input: TaskInput): Task | undefined {
    const t = this.get(id);
    if (!t) return;
    Object.assign(t, input);
    this.#place(t);
    this.#db.prepare(
      `update tasks set text = ?, prio = ?, list = ?, description = ?,
         date = ?, deadline = ?, blocker = ? where id = ?`,
    ).run(
      t.text,
      t.prio,
      t.list,
      t.description,
      t.date,
      t.deadline,
      t.blocker,
      id,
    );
    return t;
  }

  toggle(id: string) {
    // Beim Abhaken ganz ans Ende (höchste pos), damit es unten landet.
    this.#db.prepare(
      `update tasks set done = 1 - done,
         pos = case when done = 0
           then (select coalesce(max(pos), 0) + 1 from tasks) else pos end
       where id = ?`,
    ).run(id);
  }

  move(id: string, list: ListId) {
    this.#db.prepare("update tasks set list = ? where id = ?").run(list, id);
  }

  remove(id: string) {
    this.#db.prepare("delete from tasks where id = ?").run(id);
  }

  /**
   * Nächster Tag (nur per User-Aktion): Erledigte fliegen raus, Morgen →
   * Heute, offene Heute-Tasks bleiben, Backlog und Blocker wandern bei
   * erreichtem Datum/Deadline nach Heute bzw. Morgen. Das Blocker-Feld
   * bleibt dabei erhalten. `solved`: Blocker, die im Review als gelöst
   * markiert wurden und nach Heute gehen. Läuft in einer Transaktion.
   */
  nextDay(solved: string[] = []) {
    this.#db.exec("begin");
    try {
      for (const id of solved) this.move(id, "today");
      this.#db.exec("delete from tasks where done = 1");
      const today = addDays(this.today, 1);
      this.#db.prepare("update meta set value = ? where key = 'today'").run(
        today,
      );
      this.#db.exec("update tasks set list = 'today' where list = 'tomorrow'");
      this.#generate();
      for (const t of this.tasks) {
        if (t.list !== "backlog" && t.list !== "blocker") continue;
        const to = routeByDate(t, today);
        if (to) this.move(t.id, to);
      }
      this.#db.exec("commit");
    } catch (e) {
      this.#db.exec("rollback");
      throw e;
    }
  }
}
