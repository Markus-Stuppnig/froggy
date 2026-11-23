import { Hono } from "hono";
import { serveStatic } from "hono/deno";
import type { Child } from "hono/jsx";
import {
  addDays,
  describeSeries,
  isList,
  KINDS,
  LIST_LABEL,
  type ListId,
  LISTS,
  parseInput,
  parseSeries,
  parseSort,
  type Prio,
  PRIOS,
  type Series,
  type Sort,
  SORT_KEYS,
  SORT_LABEL,
  sortTasks,
  type Task,
  WEEKDAYS,
} from "./model.ts";
import { mcpHandler } from "./mcp.ts";
import { Store } from "./store.ts";

const TZ = Deno.env.get("TZ") ?? "Europe/Vienna";

const todayIso = () => new Date().toLocaleDateString("sv-SE", { timeZone: TZ });

const shortDate = (iso: string) => {
  const [, m, d] = iso.split("-");
  return `${Number(d)}.${Number(m)}.`;
};

/** „heute“/„morgen“ als Wort, sonst Datum (T.M.). */
const dayLabel = (iso: string, today: string) =>
  iso === today
    ? "heute"
    : iso === addDays(today, 1)
    ? "morgen"
    : shortDate(iso);

const longDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("de-AT", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });

const EMPTY: Record<ListId, string> = {
  today: "Nichts offen. Zieh etwas aus dem Backlog oder leg etwas an.",
  tomorrow: "Leer. Zieh Tasks aus dem Backlog hierher.",
  backlog: "Der Backlog ist leer.",
  blocker: "Nichts blockiert.",
};

const Layout = (
  { children, nav }: { children: Child; nav?: boolean },
) => (
  <html lang="de">
    <head>
      <meta charset="utf-8" />
      <meta
        name="viewport"
        content="width=device-width, initial-scale=1, viewport-fit=cover"
      />
      <meta name="htmx-config" content='{"scrollIntoViewOnBoost":false}' />
      <meta name="theme-color" content="#1f6f3d" />
      <meta name="apple-mobile-web-app-capable" content="yes" />
      <meta name="mobile-web-app-capable" content="yes" />
      <title>Froggy</title>
      <link
        rel="manifest"
        href="/manifest.webmanifest"
        crossorigin="use-credentials"
      />
      <link rel="icon" href="/icon.svg" type="image/svg+xml" />
      <link rel="apple-touch-icon" href="/icon-192.png" />
      <link rel="stylesheet" href="/static/style.css" />
      <script src="/static/htmx.min.js"></script>
      <script src="/static/app.js" defer></script>
    </head>
    <body hx-boost="true" class={nav ? "has-nav" : ""}>{children}</body>
  </html>
);

const PRIO_HINT: Record<Prio, string> = {
  A: "Muss",
  B: "Sollte",
  C: "Nett",
  D: "Delegieren",
};

/** Eigenes Dropdown (statt OS-Select); Verhalten in static/app.js. */
const Dropdown = (
  { id, name, value, options, label, autosubmit, end }: {
    id?: string;
    name: string;
    value: string;
    options: { value: string; label: string }[];
    label?: string;
    autosubmit?: boolean;
    end?: boolean;
  },
) => (
  <div class={`dd${end ? " end" : ""}`}>
    <input
      type="hidden"
      name={name}
      value={value}
      data-autosubmit={autosubmit ? "" : undefined}
    />
    <button
      type="button"
      class="dd-btn"
      id={id}
      aria-haspopup="listbox"
      aria-expanded="false"
      aria-label={label}
    >
      <span class="dd-label">
        {options.find((o) => o.value === value)?.label}
      </span>
    </button>
    <ul class="dd-list" role="listbox" aria-label={label} hidden>
      {options.map((o) => (
        <li
          role="option"
          tabindex={-1}
          data-value={o.value}
          aria-selected={o.value === value ? "true" : "false"}
        >
          {o.label}
        </li>
      ))}
    </ul>
  </div>
);

const TaskForm = (
  { task, view }: { task?: Task; view: ListId },
) => {
  const list = task?.list ?? view;
  return (
    <form
      method="post"
      action={task ? `/tasks/${task.id}` : "/tasks"}
      class="taskform"
    >
      <input type="hidden" name="view" value={view} />
      <div class="field">
        <label for="f-text">Task</label>
        <input
          id="f-text"
          name="text"
          value={task?.text}
          maxlength={200}
          autocomplete="off"
          enterkeyhint="done"
          autofocus={!task}
          required
        />
        {!task && (
          <p class="hint">
            Unter 2 Minuten? Dann jetzt erledigen. Muss es überhaupt sein? Sonst
            eliminieren.
          </p>
        )}
      </div>
      <fieldset class="field seg">
        <legend>Priorität</legend>
        {PRIOS.map((p) => (
          <label class={`prio-${p}`}>
            <input
              type="radio"
              name="prio"
              value={p}
              checked={task?.prio === p}
              required
            />
            <span>
              <b>{p}</b>
              <small>{PRIO_HINT[p]}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <div class="field">
        <label for="f-list">Liste</label>
        <Dropdown
          id="f-list"
          name="list"
          value={list}
          options={LISTS.map((l) => ({ value: l, label: LIST_LABEL[l] }))}
        />
      </div>
      <div class="field blocker-field" hidden={list !== "blocker"}>
        <label for="f-blocker">Blocker</label>
        <input
          id="f-blocker"
          name="blocker"
          value={task?.blocker}
          placeholder="Worauf wartest du?"
          maxlength={200}
          required={list === "blocker"}
        />
      </div>
      <details open={!!(task?.description || task?.date || task?.deadline)}>
        <summary>Beschreibung, Tag, Deadline</summary>
        <div class="field">
          <label for="f-desc">Beschreibung</label>
          <textarea id="f-desc" name="description" rows={3}>
            {task?.description}
          </textarea>
        </div>
        <div class="field">
          <label for="f-date">Tag</label>
          <input id="f-date" type="date" name="date" value={task?.date} />
        </div>
        <div class="field">
          <label for="f-deadline">Deadline</label>
          <input
            id="f-deadline"
            type="date"
            name="deadline"
            value={task?.deadline}
          />
        </div>
      </details>
      <div class="actions">
        <button type="submit" class="primary">Speichern</button>
        {task && (
          <button type="submit" form="delete-form" class="quiet danger">
            Löschen
          </button>
        )}
      </div>
    </form>
  );
};

const FormPage = ({ view, task }: { view: ListId; task?: Task }) => (
  <Layout>
    <header class="bar">
      <a href={`/${view}`} class="back">‹ Zurück</a>
      <h1>{task ? "Task bearbeiten" : "Neuer Task"}</h1>
    </header>
    <main>
      <TaskForm task={task} view={view} />
      {task && (
        <form
          id="delete-form"
          method="post"
          action={`/tasks/${task.id}/delete`}
          hx-confirm="Task löschen?"
        >
          <input type="hidden" name="view" value={view} />
        </form>
      )}
    </main>
  </Layout>
);

const KIND_LABEL = { weekly: "Wochentage", monthly: "Monatstage" };

const SeriesForm = ({ series }: { series?: Series }) => {
  const kind = series?.kind ?? "weekly";
  return (
    <form
      method="post"
      action={series ? `/series/${series.id}` : "/series"}
      class="taskform series-form"
    >
      <div class="field">
        <label for="f-text">Task</label>
        <input
          id="f-text"
          name="text"
          value={series?.text}
          maxlength={200}
          autocomplete="off"
          autofocus={!series}
          required
        />
      </div>
      <fieldset class="field seg">
        <legend>Priorität</legend>
        {PRIOS.map((p) => (
          <label class={`prio-${p}`}>
            <input
              type="radio"
              name="prio"
              value={p}
              checked={series?.prio === p}
              required
            />
            <span>
              <b>{p}</b>
              <small>{PRIO_HINT[p]}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <div class="field">
        <label for="f-kind">Wiederholen</label>
        <Dropdown
          id="f-kind"
          name="kind"
          value={kind}
          options={KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))}
        />
      </div>
      <fieldset class="field seg wd kind-weekly" hidden={kind !== "weekly"}>
        <legend>Wochentage</legend>
        {WEEKDAYS.map((w, i) => (
          <label>
            <input
              type="checkbox"
              name="wd"
              value={i + 1}
              checked={series?.kind === "weekly" && series.days.includes(i + 1)}
            />
            <span>
              <b>{w}</b>
            </span>
          </label>
        ))}
      </fieldset>
      <div class="field kind-monthly" hidden={kind !== "monthly"}>
        <label for="f-md">Monatstage</label>
        <input
          id="f-md"
          name="md"
          value={series?.kind === "monthly" ? series.days.join(", ") : ""}
          placeholder="z. B. 1, 15, 31"
          inputmode="numeric"
          autocomplete="off"
        />
        <p class="hint">
          31 gilt auch in kürzeren Monaten (dann am Monatsende).
        </p>
      </div>
      <div class="field">
        <label for="f-desc">Beschreibung</label>
        <textarea id="f-desc" name="description" rows={3}>
          {series?.description}
        </textarea>
      </div>
      <div class="actions">
        <button type="submit" class="primary">Speichern</button>
        {series && (
          <button type="submit" form="delete-form" class="quiet danger">
            Löschen
          </button>
        )}
      </div>
    </form>
  );
};

const SeriesPage = ({ list, series }: { list?: Series[]; series?: Series }) => (
  <Layout>
    <header class="bar">
      <a href={list ? "/today" : "/series"} class="back">‹ Zurück</a>
      <h1>
        {list ? "Wiederkehrend" : series ? "Serie bearbeiten" : "Neue Serie"}
      </h1>
    </header>
    <main>
      {list
        ? (
          <>
            {list.length === 0
              ? <p class="empty">Keine Serien. Leg die erste an.</p>
              : (
                <ul class="tasks">
                  {list.map((s) => (
                    <li class="task">
                      <b class={`prio prio-${s.prio}`}>{s.prio}</b>
                      <a class="main" href={`/series/${s.id}/edit`}>
                        <span class="title">{s.text}</span>
                        <span class="meta">
                          <span>{describeSeries(s)}</span>
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            <div class="actions">
              <a class="quiet" href="/series/new">+ Neue Serie</a>
            </div>
          </>
        )
        : (
          <>
            <SeriesForm series={series} />
            {series && (
              <form
                id="delete-form"
                method="post"
                action={`/series/${series.id}/delete`}
                hx-confirm="Serie löschen? Bereits erzeugte Tasks bleiben."
              />
            )}
          </>
        )}
    </main>
  </Layout>
);

const NextDayPage = ({ store, view }: { store: Store; view: ListId }) => {
  const blockers = store.openBlockers();
  return (
    <Layout>
      <header class="bar">
        <a href={`/${view}`} class="back">‹ Zurück</a>
        <h1>Tag beenden</h1>
      </header>
      <main>
        <form method="post" action="/next-day" class="taskform">
          <input type="hidden" name="view" value={view} />
          {blockers.length > 0 && (
            <p class="hint">
              Review: Ist noch jeder Blocker aktuell? Entscheide bei jedem.
            </p>
          )}
          {blockers.map((t) => (
            <fieldset class="field seg two">
              <legend>
                {t.text}
                <small>Blocker: {t.blocker}</small>
              </legend>
              <label>
                <input type="radio" name={`b-${t.id}`} value="keep" required />
                <span>Weiter blockiert</span>
              </label>
              <label>
                <input
                  type="radio"
                  name={`b-${t.id}`}
                  value="solved"
                  required
                />
                <span>Gelöst → Heute</span>
              </label>
            </fieldset>
          ))}
          <p class="hint">
            Erledigte Tasks werden entfernt, Morgen wird zu Heute.
          </p>
          <div class="actions">
            <button type="submit" class="primary">Nächster Tag</button>
          </div>
        </form>
      </main>
    </Layout>
  );
};

const TaskRow = (
  { task, view, frog, today, grip }: {
    task: Task;
    view: ListId;
    frog: boolean;
    today: string;
    grip: boolean;
  },
) => (
  <li
    class={`task${task.done ? " done" : ""}`}
    data-id={task.id}
    data-q={`${task.text} ${task.description} ${task.blocker}`.toLowerCase()}
  >
    <b
      class={`prio prio-${task.prio}`}
      role="img"
      aria-label={`Priorität ${task.prio}`}
    >
      {task.prio}
    </b>
    {grip && (
      <span class="grip" role="img" aria-label="Verschieben" title="Ziehen">
        ⠿
      </span>
    )}
    <a class="main" href={`/tasks/${task.id}/edit?view=${view}`}>
      <span class="title">
        {frog && <span role="img" aria-label="Frosch">🐸</span>}
        {task.text}
      </span>
      <span class="meta">
        {task.date && <span>Tag {dayLabel(task.date, today)}</span>}
        {task.deadline && (
          <span class={task.deadline < today ? "late" : ""}>
            Deadline {dayLabel(task.deadline, today)}
          </span>
        )}
        {task.blocker && <span>Blocker: {task.blocker}</span>}
      </span>
    </a>
    {view === "backlog" && !task.done && (
      <form method="post" action={`/tasks/${task.id}/move`}>
        <input type="hidden" name="view" value={view} />
        <input type="hidden" name="list" value="tomorrow" />
        <button type="submit" class="pill">Morgen ›</button>
      </form>
    )}
    <form method="post" action={`/tasks/${task.id}/toggle`} class="check">
      <input type="hidden" name="view" value={view} />
      <label>
        <input
          type="checkbox"
          checked={task.done}
          data-autosubmit
          aria-label={`Erledigt: ${task.text}`}
        />
      </label>
    </form>
  </li>
);

const Toolbar = ({ view, sort }: { view: ListId; sort: Sort }) => (
  <div class="tools">
    <label class="search">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <circle
          cx="11"
          cy="11"
          r="6.5"
          stroke="currentColor"
          stroke-width="2"
          fill="none"
        />
        <path
          d="m16 16 4.5 4.5"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        />
      </svg>
      <input
        type="search"
        data-search
        placeholder="Suchen"
        aria-label="Suchen"
        autocomplete="off"
        enterkeyhint="search"
      />
    </label>
    <form method="post" action={`/${view}/sort`} class="sort">
      <Dropdown
        name="key"
        value={sort.key}
        label="Sortieren nach"
        autosubmit
        end
        options={SORT_KEYS.map((k) => ({ value: k, label: SORT_LABEL[k] }))}
      />
      <button
        type="submit"
        name="dir"
        value={sort.dir === "asc" ? "desc" : "asc"}
        class="dir"
        aria-label={sort.dir === "asc"
          ? "Aufsteigend, umkehren"
          : "Absteigend, umkehren"}
        title={sort.dir === "asc" ? "Aufsteigend" : "Absteigend"}
      >
        {sort.dir === "asc" ? "↑" : "↓"}
      </button>
    </form>
  </div>
);

const Page = ({ store, view }: { store: Store; view: ListId }) => {
  const own = store.list(view);
  const sort = store.sortOf(view);
  const tasks = sortTasks(own, sort);
  const frogId = view === "today"
    ? own.find((t) => !t.done && t.prio === "A")?.id
    : undefined;
  const dated = view === "today" || view === "tomorrow";
  return (
    <Layout nav>
      <header class="top">
        <div>
          <h1>{LIST_LABEL[view]}</h1>
          <p class="date" aria-hidden={dated ? undefined : "true"}>
            {dated
              ? longDate(view === "today" ? store.today : store.tomorrow)
              : "\u00a0"}
          </p>
        </div>
        <span class="top-actions">
          <a class="quiet" href="/series">Serien</a>
          <a class="quiet" href={`/next-day?view=${view}`}>Nächster Tag</a>
        </span>
      </header>
      <main>
        <Toolbar view={view} sort={sort} />
        {tasks.length === 0 ? <p class="empty">{EMPTY[view]}</p> : (
          <ul
            class="tasks"
            data-reorder={sort.key === "custom"
              ? `/${view}/reorder`
              : undefined}
            data-desc={sort.dir === "desc" ? "" : undefined}
          >
            {tasks.map((t) => (
              <TaskRow
                task={t}
                view={view}
                frog={t.id === frogId}
                today={store.today}
                grip={sort.key === "custom"}
              />
            ))}
          </ul>
        )}
        <p class="empty nomatch" hidden>Keine Treffer.</p>
      </main>
      <a
        class="fab"
        href={`/tasks/new?view=${view}`}
        aria-label="Neuer Task"
      >
        <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
          <path
            d="M12 5v14M5 12h14"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            fill="none"
          />
        </svg>
      </a>
      <nav aria-label="Listen">
        {LISTS.map((l) => {
          const n = store.list(l).filter((t) => !t.done).length;
          return (
            <a
              href={`/${l}`}
              aria-current={l === view ? "page" : undefined}
            >
              {LIST_LABEL[l]}
              {n > 0 && <span aria-label={`${n} offen`}>{n}</span>}
            </a>
          );
        })}
      </nav>
    </Layout>
  );
};

const ROOT_FILES = [
  "sw.js",
  "manifest.webmanifest",
  "icon.svg",
  "icon-192.png",
  "icon-512.png",
];

export function createApp(
  opts: { today?: string; db?: string; mcpToken?: string } = {},
) {
  const store = new Store(opts.today ?? todayIso(), opts.db);
  const app = new Hono();
  const render = (view: ListId) =>
    `<!DOCTYPE html>${<Page store={store} view={view} />}`;
  const back = (body: Record<string, unknown>) => {
    const v = String(body.view ?? "");
    return `/${isList(v) ? v : "today"}`;
  };

  app.use("/static/*", serveStatic({ root: "./" }));
  for (const f of ROOT_FILES) {
    app.get(`/${f}`, serveStatic({ path: `./static/${f}` }));
  }

  const viewOf = (v: string | undefined): ListId => isList(v) ? v : "today";

  app.get("/", (c) => c.html(render("today")));
  app.get("/tasks/new", (c) =>
    c.html(
      `<!DOCTYPE html>${<FormPage view={viewOf(c.req.query("view"))} />}`,
    ));
  app.get("/tasks/:id/edit", (c) => {
    const task = store.get(c.req.param("id"));
    if (!task) return c.redirect("/today", 303);
    return c.html(
      `<!DOCTYPE html>${(
        <FormPage view={viewOf(c.req.query("view"))} task={task} />
      )}`,
    );
  });
  app.get(
    "/:list{today|tomorrow|backlog|blocker}",
    (c) => c.html(render(c.req.param("list") as ListId)),
  );

  app.post("/:list{today|tomorrow|backlog|blocker}/sort", async (c) => {
    const list = c.req.param("list") as ListId;
    const body = await c.req.parseBody();
    const s = parseSort(body.key, body.dir ?? store.sortOf(list).dir);
    if (!s) return c.text("Sortierung ungültig", 400);
    store.setSort(list, s);
    return c.redirect(`/${list}`, 303);
  });

  app.post("/:list{today|tomorrow|backlog|blocker}/reorder", async (c) => {
    const list = c.req.param("list") as ListId;
    const body = await c.req.json().catch(() => null);
    const ids: unknown = body?.ids;
    if (!Array.isArray(ids) || !ids.every((i) => typeof i === "string")) {
      return c.text("ids fehlen", 400);
    }
    // Angezeigt wird bei „absteigend“ rückwärts, gespeichert wird aufsteigend.
    store.reorder(
      list,
      store.sortOf(list).dir === "desc" ? ids.reverse() : ids,
    );
    return c.body(null, 204);
  });

  app.post("/tasks", async (c) => {
    const body = await c.req.parseBody();
    const r = parseInput(body);
    if (!r.ok) return c.text(r.error, 400);
    return c.redirect(`/${store.add(r.value).list}`, 303);
  });

  app.post("/tasks/:id", async (c) => {
    const body = await c.req.parseBody();
    const r = parseInput(body);
    if (!r.ok) return c.text(r.error, 400);
    const t = store.update(c.req.param("id"), r.value);
    return c.redirect(t ? `/${t.list}` : back(body), 303);
  });

  app.post("/tasks/:id/toggle", async (c) => {
    store.toggle(c.req.param("id"));
    return c.redirect(back(await c.req.parseBody()), 303);
  });

  app.post("/tasks/:id/move", async (c) => {
    const body = await c.req.parseBody();
    if (isList(body.list)) store.move(c.req.param("id"), body.list);
    return c.redirect(back(body), 303);
  });

  app.post("/tasks/:id/delete", async (c) => {
    store.remove(c.req.param("id"));
    return c.redirect(back(await c.req.parseBody()), 303);
  });

  app.get(
    "/series",
    (c) => c.html(`<!DOCTYPE html>${<SeriesPage list={store.series} />}`),
  );
  app.get("/series/new", (c) => c.html(`<!DOCTYPE html>${<SeriesPage />}`));
  app.get("/series/:id/edit", (c) => {
    const series = store.getSeries(c.req.param("id"));
    if (!series) return c.redirect("/series", 303);
    return c.html(`<!DOCTYPE html>${<SeriesPage series={series} />}`);
  });
  app.post("/series", async (c) => {
    const r = parseSeries(await c.req.parseBody({ all: true }));
    if (!r.ok) return c.text(r.error, 400);
    store.addSeries(r.value);
    return c.redirect("/series", 303);
  });
  app.post("/series/:id", async (c) => {
    const r = parseSeries(await c.req.parseBody({ all: true }));
    if (!r.ok) return c.text(r.error, 400);
    store.updateSeries(c.req.param("id"), r.value);
    return c.redirect("/series", 303);
  });
  app.post("/series/:id/delete", (c) => {
    store.removeSeries(c.req.param("id"));
    return c.redirect("/series", 303);
  });

  app.get("/next-day", (c) =>
    c.html(
      `<!DOCTYPE html>${(
        <NextDayPage store={store} view={viewOf(c.req.query("view"))} />
      )}`,
    ));

  app.post("/next-day", async (c) => {
    const body = await c.req.parseBody();
    const solved: string[] = [];
    for (const t of store.openBlockers()) {
      const v = body[`b-${t.id}`];
      if (v === "solved") solved.push(t.id);
      else if (v !== "keep") return c.text("Blocker-Review fehlt", 400);
    }
    store.nextDay(solved);
    return c.redirect(back(body), 303);
  });

  app.get("/health", (c) => c.text("ok"));

  // MCP nur mit gesetztem Token (MCP_TOKEN); sonst existiert die Route nicht.
  const mcpToken = opts.mcpToken ?? Deno.env.get("MCP_TOKEN");
  if (mcpToken) {
    app.post("/mcp", mcpHandler(store, mcpToken));
    app.all(
      "/mcp",
      (c) => c.text("Method Not Allowed", 405, { Allow: "POST" }),
    );
  }

  return Object.assign(app, { store });
}
