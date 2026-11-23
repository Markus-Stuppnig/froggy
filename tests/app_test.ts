import { assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "../src/app.tsx";

Deno.test("GET / renders the page", async () => {
  const res = await createApp().request("/");
  assertEquals(res.status, 200);
  assertStringIncludes(await res.text(), 'id="counter"');
});

Deno.test("increment and decrement change the value", async () => {
  const app = createApp(5);
  const up = await app.request("/increment", { method: "POST" });
  assertStringIncludes(await up.text(), "<p>6</p>");
  const down = await app.request("/decrement", { method: "POST" });
  assertStringIncludes(await down.text(), "<p>5</p>");
});

Deno.test("GET /health", async () => {
  const res = await createApp().request("/health");
  assertEquals(await res.text(), "ok");
});
