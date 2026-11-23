import { assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.tsx";

const TOKEN = "test-token-123";

const setup = () => createApp({ today: "2026-11-23", mcpToken: TOKEN });

const rpc = (
  app: ReturnType<typeof setup>,
  body: unknown,
  auth: string | null = `Bearer ${TOKEN}`,
) =>
  app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: auth } : {}),
    },
    body: JSON.stringify(body),
  });

const tool = async (
  app: ReturnType<typeof setup>,
  name: string,
  args: Record<string, unknown> = {},
) => {
  const res = await rpc(app, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  assertEquals(res.status, 200);
  const { result } = await res.json();
  const text: string = result.content[0].text;
  return {
    error: !!result.isError,
    text,
    // deno-lint-ignore no-explicit-any
    data: (result.isError ? null : JSON.parse(text)) as any,
  };
};

Deno.test("MCP: ohne Token existiert die Route nicht", async () => {
  const app = createApp({ today: "2026-11-23", mcpToken: "" });
  const res = await app.request("/mcp", { method: "POST", body: "{}" });
  assertEquals(res.status, 404);
});

Deno.test("MCP: Auth per Bearer-Token", async () => {
  const app = setup();
  const msg = { jsonrpc: "2.0", id: 1, method: "ping" };
  assertEquals((await rpc(app, msg, null)).status, 401);
  assertEquals((await rpc(app, msg, "Bearer falsch")).status, 401);
  assertEquals((await rpc(app, msg, "Bearer ")).status, 401);
  assertEquals((await rpc(app, msg, TOKEN)).status, 401);
  assertEquals((await rpc(app, msg)).status, 200);
  assertEquals((await app.request("/mcp")).status, 405);
});

Deno.test("MCP: initialize, tools/list, Notification", async () => {
  const app = setup();
  const init = await (await rpc(app, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26" },
  })).json();
  assertEquals(init.result.protocolVersion, "2025-03-26");
  assertEquals(init.result.serverInfo.name, "froggy");
  const list = await (await rpc(app, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  })).json();
  const names = list.result.tools.map((t: { name: string }) => t.name);
  assertEquals(names, [
    "list_tasks",
    "add_task",
    "update_task",
    "move_task",
    "toggle_task",
    "delete_task",
    "next_day",
  ]);
  const note = await rpc(app, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  assertEquals(note.status, 202);
  const unknown = await (await rpc(app, {
    jsonrpc: "2.0",
    id: 3,
    method: "nope",
  })).json();
  assertEquals(unknown.error.code, -32601);
  const bad = await app.request("/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
    body: "{kaputt",
  });
  assertEquals(bad.status, 400);
});

Deno.test("MCP: Tasks anlegen, ändern, verschieben, abhaken, löschen", async () => {
  const app = setup();
  const added = await tool(app, "add_task", { text: "Steuer", prio: "A" });
  assertEquals(added.data.list, "backlog");
  const id: string = added.data.id;

  const upd = await tool(app, "update_task", { id, deadline: "2026-11-23" });
  assertEquals(upd.data.list, "today"); // Deadline heute → Heute
  assertEquals(upd.data.text, "Steuer");
  assertEquals(upd.data.prio, "A");

  const listed = await tool(app, "list_tasks", { list: "today" });
  assertEquals(listed.data.today, "2026-11-23");
  assertEquals(Object.keys(listed.data.lists), ["today"]);
  assertEquals(listed.data.lists.today[0].id, id);
  assertEquals("pos" in listed.data.lists.today[0], false);

  const noBlocker = await tool(app, "move_task", { id, list: "blocker" });
  assertEquals(noBlocker.error, true);
  assertStringIncludes(noBlocker.text, "Blocker fehlt");
  const moved = await tool(app, "move_task", {
    id,
    list: "blocker",
    blocker: "wartet auf Amt",
  });
  assertEquals(moved.data.list, "blocker");
  assertEquals(moved.data.blocker, "wartet auf Amt");

  const back = await tool(app, "move_task", { id, list: "tomorrow" });
  assertEquals(back.data.list, "tomorrow");

  const done = await tool(app, "toggle_task", { id });
  assertEquals(done.data.done, true);

  assertEquals((await tool(app, "delete_task", { id })).data.deleted, true);
  assertEquals(app.store.tasks.length, 0);
  assertEquals((await tool(app, "delete_task", { id })).error, true);
});

Deno.test("MCP: ungültige Eingaben werden als Tool-Fehler gemeldet", async () => {
  const app = setup();
  assertEquals((await tool(app, "add_task", { text: "x" })).error, true);
  assertEquals(
    (await tool(app, "add_task", { text: "x", prio: "Z" })).error,
    true,
  );
  assertEquals(
    (await tool(app, "add_task", { text: "x", prio: "A", date: "2026-02-30" }))
      .error,
    true,
  );
  assertEquals((await tool(app, "list_tasks", { list: "foo" })).error, true);
  assertEquals((await tool(app, "gibtsnicht")).error, true);
  assertEquals(app.store.tasks.length, 0);
});

Deno.test("MCP: next_day mit gelöstem Blocker", async () => {
  const app = setup();
  const t = await tool(app, "add_task", {
    text: "b",
    prio: "B",
    list: "blocker",
    blocker: "wartet",
  });
  const fremd = await tool(app, "next_day", { solved_blockers: ["x"] });
  assertEquals(fremd.error, true);
  assertEquals(app.store.today, "2026-11-23");
  const r = await tool(app, "next_day", { solved_blockers: [t.data.id] });
  assertEquals(r.data.today, "2026-11-24");
  assertEquals(app.store.get(t.data.id)?.list, "today");
});
