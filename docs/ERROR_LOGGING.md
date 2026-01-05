## Error logging (MongoDB `ErrorEvent`)

This repo supports **best-effort, safe-by-default error tracking** to MongoDB via the `ErrorEvent` collection.

### Environment variables

- **`ERROR_LOGGING_ENABLED=true|false`**
  - **Production default**: `false` unless explicitly set `true`
  - **Development default**: `true` unless explicitly set `false`
- **`ERROR_LOGGING_ALLOWED_ENVS`**
  - Optional comma-separated allowlist for where MongoDB error logging may run.
  - Example: `production,development`
  - When set: only those envs are allowed.
  - When unset (defaults):
    - production: allowed
    - development: allowed
    - preview: disallowed
- **`ADMIN_LOCALHOST_BYPASS=true|false`**
  - Controls the localhost-only bypass for admin endpoints in **development**.
  - Default: `false`
- **`ERROR_LOGGING_MIN_SEVERITY=error|warn|info`**
  - Default: `error`
- **`ERROR_LOGGING_SAMPLE_RATE=0.0..1.0`**
  - When set: overrides sampling for all severities
  - When unset: defaults are `error=1.0`, `warn=0.25`, `info=0.0`
- **`ERROR_LOGGING_TTL_DAYS=14`**
  - Default: `14`
  - Note: changing retention requires a TTL **index migration** (drop + recreate).
    - Use: `tsx scripts/recreate-error-ttl-index.ts`
  - Note: the shipped `ErrorEvent` schema uses a **fixed 14-day TTL index**; this env var only takes effect after you recreate the index.
- **`ERROR_LOGGING_CAPTURE_STACK=true|false`**
  - When unset: defaults are `error=true`, `warn=false`, `info=false`
- **`ERROR_LOGGING_CAPTURE_META=true|false`**
  - Default: `true` (meta is always sanitized + truncated)
- **`ERROR_LOGGING_MAX_STACK_CHARS=8000`**
  - Default: `8000`
- **`ERROR_LOGGING_MAX_MESSAGE_CHARS=1000`**
  - Default: `1000`
- **`ERROR_LOGGING_MAX_META_CHARS=8000`**
  - Default: `8000`

### Safety rules (always)

- Never store secrets/tokens/auth headers/cookies/raw bodies/raw third-party payloads.
- Meta is sanitized and size-bounded; long strings are truncated.
- Logging failures never crash request/job paths (swallowed).

### Recommended env values

Production:

```env
ERROR_LOGGING_ENABLED=true
ERROR_LOGGING_ALLOWED_ENVS=production
ERROR_LOGGING_MIN_SEVERITY=error
ERROR_LOGGING_SAMPLE_RATE=1
ERROR_LOGGING_CAPTURE_STACK=true
ERROR_LOGGING_CAPTURE_META=true
ERROR_LOGGING_TTL_DAYS=14
```

Preview:

```env
ERROR_LOGGING_ENABLED=false
ERROR_LOGGING_ALLOWED_ENVS=preview
ERROR_LOGGING_MIN_SEVERITY=error
ERROR_LOGGING_SAMPLE_RATE=0.2
ERROR_LOGGING_CAPTURE_STACK=true
ERROR_LOGGING_CAPTURE_META=false
```

Development:

```env
ERROR_LOGGING_ENABLED=true
ERROR_LOGGING_ALLOWED_ENVS=development
ERROR_LOGGING_MIN_SEVERITY=warn
ERROR_LOGGING_SAMPLE_RATE=1
ERROR_LOGGING_CAPTURE_STACK=true
ERROR_LOGGING_CAPTURE_META=true
```


