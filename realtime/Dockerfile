# lnkdrp realtime (WebSocket) server image.
#
# Build from the REPO ROOT (the server imports src/lib/realtime/ticket.ts):
#   docker build -f realtime/Dockerfile -t lnkdrp-realtime .
# Run:
#   docker run --rm -p 8788:8788 \
#     -e MONGODB_URI='mongodb+srv://…' -e REALTIME_SECRET=… \
#     lnkdrp-realtime
#
# Needs a Mongo replica set (Atlas is one) because it uses change streams. Holds long-lived
# sockets, so it runs on a host that allows that (Fly, Railway, a VM), never as a Vercel function.
#
# The versions below are exact and must match what the root package-lock.json resolves, so the image
# runs what the release gate tested. There is no lockfile here, so transitive dependencies still
# float. The base image is pinned to an exact Node 22 patch release; bump it deliberately.
FROM node:22.23.2-alpine

ENV NODE_ENV=production \
    REALTIME_PORT=8788

WORKDIR /app

RUN printf '%s\n' \
      '{"name":"lnkdrp-realtime","private":true,"dependencies":{' \
      '"mongoose":"8.20.3",' \
      '"ws":"8.21.3",' \
      '"tsx":"4.21.0"' \
      '}}' > package.json \
 && npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force

COPY tsconfig.json ./tsconfig.json
COPY src/lib/realtime/ticket.ts ./src/lib/realtime/ticket.ts
COPY realtime ./realtime

USER node
EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${REALTIME_PORT}/healthz" > /dev/null || exit 1

CMD ["node", "--import", "tsx", "realtime/server.ts"]
