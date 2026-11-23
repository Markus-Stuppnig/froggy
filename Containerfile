FROM docker.io/denoland/deno:alpine-2.9.8
WORKDIR /app
COPY deno.json main.ts ./
COPY src ./src
RUN deno cache main.ts
USER deno
EXPOSE 8000
CMD ["deno", "run", "--allow-net", "--allow-env", "main.ts"]
