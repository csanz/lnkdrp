# lnkdrp MCP server image.
#
# Build from the REPO ROOT (the server imports src/lib/realtime/ticket.ts):
#   docker build -f mcp/Dockerfile -t lnkdrp-mcp .
# Run:
#   docker run --rm -p 8787:8787 \
#     -e LNKDRP_API_URL=https://lnkdrp.com -e MCP_PUBLIC_URL=https://mcp.lnkdrp.com \
#     -e NEXT_PUBLIC_REALTIME_URL=wss://realtime.lnkdrp.com -e REALTIME_SECRET=… \
#     lnkdrp-mcp
#
# The server is a thin translator to the REST API (no Mongo, no Next build), so the image installs
# only its runtime packages instead of the whole app's node_modules. Keep the version ranges below
# in sync with the root package.json.
FROM node:22-alpine

ENV NODE_ENV=production \
    MCP_PORT=8787

WORKDIR /app

RUN printf '%s\n' \
      '{"name":"lnkdrp-mcp","private":true,"dependencies":{' \
      '"@modelcontextprotocol/sdk":"^1.30.0",' \
      '"express":"^5.2.1",' \
      '"zod":"^4.1.5",' \
      '"ws":"^8.21.3",' \
      '"tsx":"^4.21.0"' \
      '}}' > package.json \
 && npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force

COPY tsconfig.json ./tsconfig.json
COPY src/lib/realtime/ticket.ts ./src/lib/realtime/ticket.ts
COPY mcp ./mcp

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${MCP_PORT}/healthz" > /dev/null || exit 1

CMD ["node", "--import", "tsx", "mcp/src/main.ts"]
