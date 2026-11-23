# Froggy

Froggy: einfache „Eat that frog“-Todo-App (PWA). Deno 2.9 + Hono 4.13 + htmx
2.0, ausgeliefert via Podman Quadlet hinter Caddy 2.11.

## Konzept

- Vier Listen, je eine eigene Ansicht: **Heute, Morgen, Backlog, Blocker**. Die
  Liste wird per Dropdown gewählt (im Formular und als Schnellwechsel pro
  Zeile).
- Pflicht: Task-Text und Priorität (A Muss, B Sollte, C Nett, D Delegieren). Bei
  Blocker zusätzlich das Feld Blocker. Optional: Beschreibung, Tag, Deadline.
- Der erste offene A-Task in Heute ist der Frosch 🐸.
- **Nächster Tag** (nur per Klick): Erledigte werden entfernt, Morgen → Heute,
  offene Heute-Tasks bleiben. Backlog und Blocker wandern nach Heute/Morgen,
  wenn Tag oder Deadline (frühester Wert) heute bzw. morgen erreicht ist; das
  Blocker-Feld bleibt erhalten.
- Beim Speichern wandert ein Backlog-Task mit Tag/Deadline heute/morgen sofort
  in die passende Liste. Eine explizit gewählte andere Liste bleibt.
- **Serien** (`/series`, Link „Serien“ im Kopf): wiederkehrende Vorlagen mit
  Text, Priorität, Beschreibung und Rhythmus: Wochentage (Mo–So, alle sieben =
  täglich) oder Monatstage (31 = auch Monatsende in kürzeren Monaten). Beim
  Anlegen und bei „Nächster Tag“ erzeugt der Store Tasks mit gesetztem Tag bis
  einschließlich morgen; sie landen per Datums-Routing in Heute/Morgen. Löschen
  einer Serie lässt bereits erzeugte Tasks stehen.
- Logik: `src/model.ts` (rein), Persistenz: `src/store.ts` (SQLite über
  `node:sqlite`). Pfad per `DB_PATH` (Default `data/froggy.db`, im Container
  `/data/froggy.db` auf dem Volume `froggy-data`). Auch „Heute“ liegt in der DB.
- „Heute“ ist ein Zähler im Store, der nur durch „Nächster Tag“ weiterläuft.
  Startwert: aktuelles Datum in `TZ` (Default `Europe/Vienna`).

## Struktur

| Pfad               | Inhalt                                                        |
| ------------------ | ------------------------------------------------------------- |
| `main.ts`          | Einstiegspunkt, startet `Deno.serve`                          |
| `src/model.ts`     | Tasks, Listen-Logik, Tageswechsel                             |
| `src/app.tsx`      | Hono-App, Views und Routen                                    |
| `src/mcp.ts`       | MCP-Endpunkt `/mcp` (Tools für Open WebUI)                    |
| `static/`          | CSS, JS, htmx (vendored), PWA-Manifest, Service Worker, Icons |
| `scripts/`         | `gen-icons.ts` erzeugt die PNG-Icons                          |
| `tests/`           | Tests (`deno task test`)                                      |
| `Containerfile`    | Image auf Basis `denoland/deno:alpine`                        |
| `deploy/Caddyfile` | Reverse-Proxy mit Basic Auth                                  |
| `deploy/quadlet/`  | Quadlet-Units (Netzwerk, Volume, Build, App)                  |
| `deploy/local/`    | `caddy.container` nur für lokale Tests                        |

## Entwicklung

```sh
deno task dev     # http://localhost:8000
deno task test
deno task check   # fmt, lint, typecheck
```

## Deployment (rootless Podman)

Das Repo muss unter `~/zukunftssicher/froggy` liegen (die Units referenzieren
`%h/zukunftssicher/froggy`, bei anderem Pfad dort anpassen). Einen eigenen Caddy
bringt man selbst mit (siehe unten).

```sh
cp deploy/secrets.env.example deploy/secrets.env   # MCP_TOKEN setzen
mkdir -p ~/.config/containers/systemd
cp deploy/quadlet/* ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user start froggy   # zieht froggy-build, Volume und Netzwerk nach
podman network connect froggy caddy   # bestehenden Caddy anbinden
```

Nur für lokale Tests mit mitgeliefertem Caddy (http://localhost:8080):
`cp deploy/local/caddy.container ~/.config/containers/systemd/` und
`systemctl --user start caddy`. Für eine echte Domain `SITE_ADDRESS=example.org`
setzen und Ports auf 80/443 mappen.

Autostart ohne Login: `loginctl enable-linger $USER`.

## Zugriffsschutz und Secrets

Die App kennt keine Nutzer. Den Schutz übernimmt der Reverse-Proxy (`basic_auth`
im Caddy). Deshalb darf `froggy` keinen `PublishPort` haben und nur über das
gemeinsame Podman-Netzwerk erreichbar sein.

Secrets liegen in `deploy/secrets.env` (nicht im Git, Vorlage:
`deploy/secrets.env.example`) und werden von beiden Quadlet-Units geladen. Die
Datei muss vor dem Start existieren.

- `BASIC_AUTH_USER`, `BASIC_AUTH_HASH`: Login für die Web-App, Hash per
  `caddy hash-password`.
- `MCP_TOKEN`: Bearer-Token für `/mcp` (`openssl rand -hex 32`). Ohne Token gibt
  es die Route nicht.

Das Manifest wird mit `crossorigin="use-credentials"` geladen, sonst bekommt die
PWA hinter Basic Auth ein 401.

### Eigener Caddy in Produktion

Läuft vor `froggy` ein anderer Caddy, entfällt der Caddy aus diesem Repo (er
bleibt für lokale Tests). Der Prod-Caddy muss im selben Netzwerk wie `froggy`
hängen:

```caddy
froggy.example.org {
	respond /mcp* 404   # MCP nur intern, siehe unten

	basic_auth {
		markus <Hash>
	}
	reverse_proxy froggy:8000
}
```

## MCP (Open WebUI)

`POST /mcp` spricht MCP über Streamable HTTP (zustandslos, JSON-Antworten) mit
`Authorization: Bearer <MCP_TOKEN>`. Tools: `list_tasks`, `add_task`,
`update_task`, `move_task`, `toggle_task`, `delete_task`, `next_day` (Code:
`src/mcp.ts`).

In Open WebUI unter Einstellungen → Externe Tools (Admin) einen Server
hinzufügen:

- Typ **MCP (Streamable HTTP)**, URL `http://froggy:8000/mcp`
- Auth **Bearer**, Wert = `MCP_TOKEN`

`froggy:8000` funktioniert, wenn Open WebUI im Netzwerk `froggy` hängt (im
Quadlet von Open WebUI `Network=froggy.network`). Dann bleibt `/mcp` öffentlich
gesperrt. Läuft Open WebUI woanders, `/mcp` im Caddy ohne `basic_auth` freigeben
und `respond /mcp* 404` entfernen:

```caddy
@mcp path /mcp*
handle @mcp {
	reverse_proxy froggy:8000
}
handle {
	basic_auth { ... }
	reverse_proxy froggy:8000
}
```

Testen:

```sh
curl -s http://froggy:8000/mcp -H "Authorization: Bearer $MCP_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
