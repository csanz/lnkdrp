# Tests

This repo has a few different “test” entrypoints depending on what you’re validating.

## Unit suites (the gate)

```bash
npm test
```

Runs the three deterministic vitest suites in order: `tests/lib`, `tests/credits`, `tests/upload`. This is what `.github/workflows/test.yml` runs on every pull request and push to `main`, after `tsc --noEmit` and `npm run lint`. Each suite can still be run alone (`npm run tests:lib:vitest` etc.), or one file with `npx vitest run --config tests/lib/vitest.config.ts tests/lib/stripeWebhook.test.ts`.

`tests:agent:vitest` is **not** part of `npm test` on purpose: it is a live-model eval that calls OpenAI (needs `OPENAI_API_KEY`), spends credits, and can fail on model drift. Run it by hand when you change a prompt.

The Mongo-backed cases (`it.skipIf(!canRun())`) need `MONGODB_URI` and `API_TEST_USER_ID`; the vitest configs read them from `./tmp/.env*`, which is not checked in, so those cases skip by default.

## App route tests (HTTP, no UI/cache)

```bash
npm run tests:routes -- --path tests/routes/sidebar-snapshot.mjs
```

```bash
npm run tests:routes -- --path tests/routes/received-vs-projects.mjs
```

## Agent tests

```bash
npm run tests:agent
```

```bash
npm run tests:agent:vitest
```

## Other scripts

```bash
npm run blob:test
```

```bash
npm run test:pdf2txt
```

```bash
npm run test:pdf2png
```




