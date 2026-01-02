# Tests

This repo has a few different “test” entrypoints depending on what you’re validating.

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




