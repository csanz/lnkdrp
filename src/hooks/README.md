# `src/hooks`

Shared React hooks live here.

Rules:

- If the logic has **side effects** (events/timers/network/storage/observers), it should be a **hook**.
- If a hook becomes domain-specific and tightly coupled to a domain library (e.g. billing/credits), it may live under `src/lib/<domain>/...` instead.

See `docs/CODE_QUALITY.md` for extraction heuristics and required documentation rules.

