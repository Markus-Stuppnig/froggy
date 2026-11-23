import { assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.tsx";

const form = (data: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(data),
});

Deno.test("GET / renders Heute with nav", async () => {
  const res = await createApp({ today: "2026-11-23" }).request("/");
  assertEquals(res.status, 200);
  const html = await res.text();
  assertStringIncludes(html, "<!DOCTYPE html>");
  assertStringIncludes(html, "Heute");
  assertStringIncludes(html, 'href="/backlog"');
});

Deno.test("add, toggle, next day via HTTP", async () => {
  const app = createApp({ today: "2026-11-23" });
  const add = await app.request(
    "/tasks",
    form({ text: "Steuer", prio: "A", list: "tomorrow", view: "today" }),
  );
  assertEquals(add.status, 303);
  assertEquals(add.headers.get("location"), "/tomorrow");
  const id = app.store.tasks[0].id;
  await app.request(`/tasks/${id}/toggle`, form({ view: "tomorrow" }));
  assertEquals(app.store.tasks[0].done, true);
  await app.request("/next-day", form({ view: "today" }));
  assertEquals(app.store.tasks.length, 0);
  assertEquals(app.store.today, "2026-11-24");
});

Deno.test("invalid input is rejected", async () => {
  const app = createApp({ today: "2026-11-23" });
  const res = await app.request(
    "/tasks",
    form({ text: "x", prio: "A", list: "blocker" }),
  );
  assertEquals(res.status, 400);
  assertEquals(app.store.tasks.length, 0);
});

Deno.test("static files and /health", async () => {
  const app = createApp();
  assertEquals((await app.request("/health")).status, 200);
  for (
    const p of [
      "/sw.js",
      "/manifest.webmanifest",
      "/static/style.css",
      "/icon-192.png",
    ]
  ) {
    const res = await app.request(p);
    assertEquals(res.status, 200, p);
    await res.arrayBuffer();
  }
});

Deno.test("next day erzwingt Blocker-Review", async () => {
  const app = createApp({ today: "2026-11-23" });
  await app.request(
    "/tasks",
    form({ text: "b", prio: "B", list: "blocker", blocker: "wartet" }),
  );
  const id = app.store.tasks[0].id;
  const page = await (await app.request("/next-day?view=today")).text();
  assertStringIncludes(page, `name="b-${id}"`);
  const no = await app.request("/next-day", form({ view: "today" }));
  assertEquals(no.status, 400);
  assertEquals(app.store.today, "2026-11-23");
  const ok = await app.request(
    "/next-day",
    form({ view: "today", [`b-${id}`]: "solved" }),
  );
  assertEquals(ok.status, 303);
  assertEquals(app.store.today, "2026-11-24");
  assertEquals(app.store.tasks[0].list, "today");
});

Deno.test("Suche und Sortierung auf allen vier Seiten, Sortierung bleibt", async () => {
  const app = createApp({ today: "2026-11-23" });
  for (const l of ["today", "tomorrow", "backlog", "blocker"]) {
    const html = await (await app.request(`/${l}`)).text();
    assertStringIncludes(html, "data-search");
    assertStringIncludes(html, `action="/${l}/sort"`);
  }
  const r = await app.request(
    "/backlog/sort",
    form({ key: "alpha", dir: "desc" }),
  );
  assertEquals(r.status, 303);
  assertEquals(app.store.sortOf("backlog"), { key: "alpha", dir: "desc" });
  assertEquals(
    (await app.request("/backlog/sort", form({ key: "x", dir: "asc" }))).status,
    400,
  );
});

Deno.test("Drag-and-drop-Reihenfolge wird gespeichert", async () => {
  const app = createApp({ today: "2026-11-23" });
  for (const text of ["eins", "zwei"]) {
    await app.request("/tasks", form({ text, prio: "B", list: "today" }));
  }
  const [x, y] = app.store.list("today").map((t) => t.id);
  await app.request("/today/sort", form({ key: "custom", dir: "asc" }));
  const res = await app.request("/today/reorder", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [y, x] }),
  });
  assertEquals(res.status, 204);
  assertEquals(app.store.list("today").map((t) => t.id), [y, x]);
  const html = await (await app.request("/today")).text();
  assertStringIncludes(html, 'data-reorder="/today/reorder"');
});

Deno.test("Tag/Deadline heute und morgen als Wort", async () => {
  const app = createApp({ today: "2026-11-23" });
  await app.request(
    "/tasks",
    form({ text: "a", prio: "A", list: "today", deadline: "2026-11-23" }),
  );
  await app.request(
    "/tasks",
    form({ text: "b", prio: "B", list: "today", date: "2026-11-24" }),
  );
  await app.request(
    "/tasks",
    form({ text: "c", prio: "C", list: "today", deadline: "2026-11-30" }),
  );
  const html = await (await app.request("/today")).text();
  assertStringIncludes(html, "Deadline heute");
  assertStringIncludes(html, "Tag morgen");
  assertStringIncludes(html, "Deadline 30.11.");
});

Deno.test("Serie erzeugt Tasks beim Tageswechsel", async () => {
  const app = createApp({ today: "2026-11-23" }); // Montag
  const res = await app.request(
    "/series",
    new Request("http://x/series", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "text=Sport&prio=B&kind=weekly&wd=2&wd=3",
    }),
  );
  assertEquals(res.status, 303);
  // Dienstag ist morgen → sofort in Morgen
  assertEquals(app.store.list("tomorrow").map((t) => t.text), ["Sport"]);
  assertEquals(app.store.list("today").length, 0);
  await app.request("/next-day", form({ view: "today" })); // Di
  assertEquals(app.store.list("today").map((t) => t.date), ["2026-11-24"]);
  assertEquals(app.store.list("tomorrow").map((t) => t.date), ["2026-11-25"]);
  const html = await (await app.request("/series")).text();
  assertStringIncludes(html, "Wöchentlich Di, Mi");
});
