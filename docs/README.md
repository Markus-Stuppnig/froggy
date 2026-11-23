# Froggy

Froggy (aktuell ein Counter als Platzhalter): Deno 2.9 + Hono 4.13 + htmx 2.0,
ausgeliefert via Podman Quadlet hinter Caddy 2.11.

## Struktur

| Pfad               | Inhalt                                                       |
| ------------------ | ------------------------------------------------------------ |
| `main.ts`          | Einstiegspunkt, startet `Deno.serve`                         |
| `src/app.tsx`      | Hono-App (Routen `/`, `/increment`, `/decrement`, `/health`) |
| `tests/`           | Tests (`deno task test`)                                     |
| `Containerfile`    | Image auf Basis `denoland/deno:alpine`                       |
| `deploy/Caddyfile` | Reverse-Proxy-Konfiguration                                  |
| `deploy/quadlet/`  | Quadlet-Units (Netzwerk, Build, App, Caddy)                  |

## Entwicklung

```sh
deno task dev     # http://localhost:8000
deno task test
deno task check   # fmt, lint, typecheck
```

Der Zähler liegt im Speicher und geht beim Neustart verloren.

## Deployment (rootless Podman)

Das Repo muss unter `~/froggy` liegen (die Units referenzieren `%h/froggy`).

```sh
mkdir -p ~/.config/containers/systemd
cp deploy/quadlet/* ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user start caddy   # zieht froggy, froggy-build und das Netzwerk nach
```

Aufruf: http://localhost:8080. Für eine echte Domain in `caddy.container`
`SITE_ADDRESS=example.org` setzen und die Ports auf 80/443 mappen (rootless:
`net.ipv4.ip_unprivileged_port_start=80`). Caddy holt dann automatisch
Zertifikate.

Autostart ohne Login: `loginctl enable-linger $USER`.
