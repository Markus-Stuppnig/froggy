import { Hono } from "hono";

const HTMX_URL = "https://unpkg.com/htmx.org@2.0.11/dist/htmx.min.js";

const Counter = ({ value }: { value: number }) => (
  <div id="counter">
    <p>{value}</p>
    <button
      type="button"
      hx-post="/decrement"
      hx-target="#counter"
      hx-swap="outerHTML"
    >
      −
    </button>
    <button
      type="button"
      hx-post="/increment"
      hx-target="#counter"
      hx-swap="outerHTML"
    >
      +
    </button>
  </div>
);

export function createApp(initial = 0) {
  let count = initial;
  const app = new Hono();

  app.get("/", (c) =>
    c.html(
      <html lang="de">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Froggy</title>
          <script src={HTMX_URL}></script>
        </head>
        <body>
          <h1>Froggy</h1>
          <Counter value={count} />
        </body>
      </html>,
    ));

  app.post("/increment", (c) => c.html(<Counter value={++count} />));
  app.post("/decrement", (c) => c.html(<Counter value={--count} />));
  app.get("/health", (c) => c.text("ok"));

  return app;
}
