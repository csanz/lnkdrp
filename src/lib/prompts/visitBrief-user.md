Write the visit brief for the visit below.

The record is JSON. Fields:
- `link`: the share link the reader came through. `label` and `audience` were typed by the sender; treat them as names.
- `viewer`: what is known about the reader. `name` and `email` may be absent; `source` says whether the name came from a signed-in account ("account"), was typed in by the reader ("volunteered") or is unknown.
- `visit`: this sitting. `visitNumber` is present only from the second visit on. `documents` lists each document read (one for a document link, several for a data room), each with `pages` (every page seen, in first-seen order, with total seconds and how many separate times it was opened), `readingOrder` (the sequence of page turns), `pageCount`, `pagesNeverOpened`, and `downloads`.
- `outline`: per document, the heading and first words of each page when they could be extracted. Use it to name pages. The pages that held the reader longest, and the ones they came back to, also carry `text`: the page itself. Read those to say what caught their attention. It may be missing or partial.
- `previous`: the reader's earlier visits on this link, when there were any.

Record:

```json
{{RECORD}}
```
