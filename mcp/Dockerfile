# lnkdrp MCP server image.
#
# Build from the REPO ROOT (the server imports src/lib/realtime/ticket.ts and src/lib/credits/schedule.ts):
#   docker build -f mcp/Dockerfile -t lnkdrp-mcp .
# Run:
#   docker run --rm -p 8787:8787 \
#     -e LNKDRP_API_URL=https://lnkdrp.com -e MCP_PUBLIC_URL=https://mcp.lnkdrp.com \
#     -e NEXT_PUBLIC_REALTIME_URL=wss://realtime.lnkdrp.com -e REALTIME_SECRET=… \
#     lnkdrp-mcp
#
# The server is a thin translator to the REST API (no Mongo, no Next build), so the image installs
# only its runtime packages instead of the whole app's node_modules. The versions below are exact and
# must match what the root package-lock.json resolves, so the image runs what the release gate tested.
# There is no lockfile here, so transitive dependencies still float. The base image is pinned to an exact
# Node 22 patch release; bump it deliberately, like a dependency.
FROM node:22.23.2-alpine

ENV NODE_ENV=production \
    MCP_PORT=8787

WORKDIR /app

# Ghostscript, because PDF optimization is a real feature and not a nice-to-have.
#
# share_pdf/replace_pdf shrink image-heavy decks before upload (mcp/src/optimize.ts, /prepress at
# 220dpi, tuned by eye over several rounds). Without `gs` on PATH the optimizer does not fail — it
# silently skips and uploads the original bytes, so the behaviour in the container quietly differed
# from the behaviour everyone tested locally, where Ghostscript happens to be installed.
#
# It is an apk package rather than a Node dependency, so it has to be asked for explicitly; the
# version floats with the base image's Alpine release, which is acceptable for a downsampler whose
# output is checked (below) rather than trusted.
RUN apk add --no-cache ghostscript && gs --version

# pdfjs-dist is in the list because the optimizer refuses to ship a file whose page count it cannot
# verify, and pdfjs is how it counts them. Without it every shrunk PDF is discarded and the original
# uploaded instead — the same silent no-op as a missing Ghostscript, one step further along.
RUN printf '%s\n' \
      '{"name":"lnkdrp-mcp","private":true,"dependencies":{' \
      '"@modelcontextprotocol/sdk":"1.30.0",' \
      '"express":"5.2.1",' \
      '"zod":"4.2.0",' \
      '"ws":"8.21.3",' \
      '"tsx":"4.21.0",' \
      '"pdfjs-dist":"5.4.449"' \
      '}}' > package.json \
 && npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force

COPY tsconfig.json ./tsconfig.json
COPY src/lib/realtime/ticket.ts ./src/lib/realtime/ticket.ts
# lnkdrp_whoami derives its cost table from the app credit schedule (pure module, no server deps).
COPY src/lib/credits/schedule.ts ./src/lib/credits/schedule.ts
COPY src/lib/credits/types.ts ./src/lib/credits/types.ts
# share_pdf/replace_pdf and the Express body limit read the upload ceilings from the app's single
# definition; without this the image builds and then dies at boot on a missing module.
COPY src/lib/limits/uploads.ts ./src/lib/limits/uploads.ts
# lnkdrp_untag folds tag names with the same function the server files them under, so removing a tag
# by a differently-accented or punctuated spelling works. Pure string handling, no server deps.
COPY src/lib/tags/slug.ts ./src/lib/tags/slug.ts
# get_activity and revision_contributors hand out contributor keys and page URLs; both are built by
# the app's single definition of that format, so the tools and the pages can never drift apart.
# Import-free leaf (no mongoose), so it copies as one file; without it the image dies at boot.
COPY src/lib/people/contributorKey.ts ./src/lib/people/contributorKey.ts
COPY mcp ./mcp

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${MCP_PORT}/healthz" > /dev/null || exit 1

CMD ["node", "--import", "tsx", "mcp/src/main.ts"]
