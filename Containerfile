FROM docker.io/denoland/deno:alpine-2.9.8
WORKDIR /app
COPY deno.json deno.lock main.ts ./
COPY src ./src
COPY static ./static
RUN deno cache main.ts
RUN mkdir /data && chown deno /data
ENV DB_PATH=/data/froggy.db
USER deno
EXPOSE 8000
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read=static,/data", "--allow-write=/data", "main.ts"]
