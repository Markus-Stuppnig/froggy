import type { Context } from "hono";
import { isList, LISTS, parseInput, PRIOS, sortTasks } from "./model.ts";
import type { ListId, Task } from "./model.ts";
import type { Store } from "./store.ts";

/**
 * Minimaler MCP-Server (Streamable HTTP, zustandslos, nur JSON-Antworten).
 * Reicht für Open WebUI und andere Clients, die `tools/list` und
 * `tools/call` nutzen. Auth: `Authorization: Bearer <MCP_TOKEN>`.
 */

const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

type Args = Record<string, unknown>;

class ToolError extends Error {}

const str = (a: Args, k: string) => (typeof a[k] === "string" ? a[k] : "");

const taskView = ({ pos: _pos, ...t }: Task) => t;

const LIST_ENUM = { type: "string", enum: [...LISTS] };
const PRIO_ENUM = {
  type: "string",
  enum: [...PRIOS],
  description: "A Muss, B Sollte, C Nett, D Delegieren",
};
const TASK_FIELDS = {
  text: { type: "string", description: "Titel, höchstens 200 Zeichen" },
  prio: PRIO_ENUM,
  list: LIST_ENUM,
  description: { type: "string" },
  date: { type: "string", description: "Tag, YYYY-MM-DD, leer = keiner" },
  deadline: { type: "string", description: "Deadline, YYYY-MM-DD" },
  blocker: {
    type: "string",
    description: "Worauf gewartet wird (Pflicht bei Liste blocker)",
  },
};
const ID = { type: "string", description: "Task-ID aus list_tasks" };

const TOOLS = [
  {
    name: "list_tasks",
    description:
      "Listet Tasks in der Reihenfolge der App. Ohne `list` alle vier Listen " +
      "(today, tomorrow, backlog, blocker). Liefert auch das aktuelle " +
      "„Heute“-Datum der App.",
    inputSchema: { type: "object", properties: { list: LIST_ENUM } },
  },
  {
    name: "add_task",
    description:
      "Legt einen Task an. Backlog-Tasks mit Tag oder Deadline heute/morgen " +
      "landen automatisch in Heute bzw. Morgen.",
    inputSchema: {
      type: "object",
      properties: TASK_FIELDS,
      required: ["text", "prio"],
    },
  },
  {
    name: "update_task",
    description: "Ändert einzelne Felder eines Tasks. Nicht genannte bleiben.",
    inputSchema: {
      type: "object",
      properties: { id: ID, ...TASK_FIELDS },
      required: ["id"],
    },
  },
  {
    name: "move_task",
    description:
      "Verschiebt einen Task in eine andere Liste. Für `blocker` muss " +
      "der Task schon einen Blocker-Text haben oder `blocker` mitgegeben werden.",
    inputSchema: {
      type: "object",
      properties: { id: ID, list: LIST_ENUM, blocker: TASK_FIELDS.blocker },
      required: ["id", "list"],
    },
  },
  {
    name: "toggle_task",
    description: "Hakt einen Task ab oder nimmt den Haken wieder weg.",
    inputSchema: {
      type: "object",
      properties: { id: ID },
      required: ["id"],
    },
  },
  {
    name: "delete_task",
    description: "Löscht einen Task endgültig.",
    inputSchema: {
      type: "object",
      properties: { id: ID },
      required: ["id"],
    },
  },
  {
    name: "next_day",
    description:
      "Beendet den Tag: Erledigte werden entfernt, Morgen wird zu Heute. " +
      "Offene Blocker bleiben blockiert, außer ihre ID steht in " +
      "`solved_blockers` (dann gehen sie nach Heute). Nur auf ausdrücklichen " +
      "Wunsch des Nutzers aufrufen, nicht rückgängig zu machen.",
    inputSchema: {
      type: "object",
      properties: {
        solved_blockers: { type: "array", items: { type: "string" } },
      },
    },
  },
];

function task(store: Store, a: Args): Task {
  const t = store.get(str(a, "id"));
  if (!t) throw new ToolError("Task nicht gefunden");
  return t;
}

function call(store: Store, name: string, a: Args): unknown {
  switch (name) {
    case "list_tasks": {
      const only = a.list;
      if (only !== undefined && !isList(only)) {
        throw new ToolError("Liste ungültig");
      }
      const lists: ListId[] = only ? [only] : [...LISTS];
      return {
        today: store.today,
        lists: Object.fromEntries(lists.map((l) => [
          l,
          sortTasks(store.list(l), store.sortOf(l)).map(taskView),
        ])),
      };
    }
    case "add_task": {
      const r = parseInput({ list: "backlog", ...a });
      if (!r.ok) throw new ToolError(r.error);
      return taskView(store.add(r.value));
    }
    case "update_task": {
      const { pos: _pos, id: _id, done: _done, ...cur } = task(store, a);
      const r = parseInput({ ...cur, ...a });
      if (!r.ok) throw new ToolError(r.error);
      return taskView(store.update(str(a, "id"), r.value)!);
    }
    case "move_task": {
      const t = task(store, a);
      if (!isList(a.list)) throw new ToolError("Liste ungültig");
      const blocker = str(a, "blocker").trim() || t.blocker;
      if (a.list === "blocker" && !blocker) {
        throw new ToolError("Blocker fehlt");
      }
      if (str(a, "blocker").trim()) {
        const { pos: _pos, id: _id, done: _done, ...cur } = t;
        const r = parseInput({ ...cur, list: a.list, blocker });
        if (!r.ok) throw new ToolError(r.error);
        store.update(t.id, r.value);
      } else {
        store.move(t.id, a.list);
      }
      return taskView(store.get(t.id)!);
    }
    case "toggle_task": {
      const t = task(store, a);
      store.toggle(t.id);
      return taskView(store.get(t.id)!);
    }
    case "delete_task": {
      store.remove(task(store, a).id);
      return { deleted: true };
    }
    case "next_day": {
      const solved = Array.isArray(a.solved_blockers)
        ? a.solved_blockers.map(String)
        : [];
      const open = store.openBlockers().map((t) => t.id);
      if (!solved.every((id) => open.includes(id))) {
        throw new ToolError("solved_blockers: nur offene Blocker erlaubt");
      }
      store.nextDay(solved);
      return { today: store.today };
    }
    default:
      throw new ToolError(`Unbekanntes Tool: ${name}`);
  }
}

type Id = string | number | null;
type Rpc = { id?: Id; method?: unknown; params?: unknown };

const ok = (id: Id, result: unknown) => ({ jsonrpc: "2.0", id, result });
const fail = (id: Id, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

/** Eine JSON-RPC-Nachricht; `null` für Notifications und Client-Antworten. */
function handle(store: Store, msg: unknown) {
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
    return fail(null, -32600, "Invalid Request");
  }
  const { id, method, params } = msg as Rpc;
  if (typeof method !== "string") return id === undefined ? null : ok(id, {});
  if (id === undefined) return null;
  const p =
    (typeof params === "object" && params !== null ? params : {}) as Args;
  switch (method) {
    case "initialize": {
      const v = String(p.protocolVersion);
      return ok(id, {
        protocolVersion: VERSIONS.includes(v) ? v : VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "froggy", version: "1.0.0" },
      });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: TOOLS });
    case "tools/call": {
      const args =
        (typeof p.arguments === "object" && p.arguments !== null
          ? p.arguments
          : {}) as Args;
      try {
        const out = call(store, String(p.name), args);
        return ok(id, {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        });
      } catch (e) {
        if (!(e instanceof ToolError)) throw e;
        return ok(id, {
          isError: true,
          content: [{ type: "text", text: e.message }],
        });
      }
    }
    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}

const sha256 = async (s: string) =>
  new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
  );

/** Zeitkonstanter Vergleich über SHA-256, damit Länge und Inhalt nichts verraten. */
async function tokenMatches(header: string | undefined, token: string) {
  const given = /^Bearer (.+)$/i.exec(header ?? "")?.[1] ?? "";
  const [a, b] = await Promise.all([sha256(given), sha256(token)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0 && given !== "";
}

export function mcpHandler(store: Store, token: string) {
  return async (c: Context) => {
    if (!await tokenMatches(c.req.header("authorization"), token)) {
      return c.json(fail(null, -32001, "Unauthorized"), 401, {
        "WWW-Authenticate": "Bearer",
      });
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(fail(null, -32700, "Parse error"), 400);
    }
    if (Array.isArray(body)) {
      const out = body.map((m) => handle(store, m)).filter((r) => r !== null);
      return out.length ? c.json(out) : c.body(null, 202);
    }
    const out = handle(store, body);
    return out ? c.json(out) : c.body(null, 202);
  };
}
