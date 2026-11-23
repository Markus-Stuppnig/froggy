import { dirname } from "@std/path";
import { createApp } from "./src/app.tsx";

const port = Number(Deno.env.get("PORT") ?? 8000);
const db = Deno.env.get("DB_PATH") ?? "data/froggy.db";
Deno.mkdirSync(dirname(db), { recursive: true });

Deno.serve({ port, hostname: "0.0.0.0" }, createApp({ db }).fetch);
