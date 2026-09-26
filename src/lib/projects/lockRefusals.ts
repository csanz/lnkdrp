/**
 * The named refusals a lock can answer with (docs/prds/lnkdrp-locked-projects.md, decision 10).
 *
 * A request inbox cannot be locked, and the refusal is a named 400 rather than a validation failure.
 * `Project.ts`'s `pre("validate")` request-repo invariant refuses the same state as a backstop, but
 * that reaches the client shaped like a 500, and "the server broke" is the wrong sentence for "this
 * kind of project cannot be private". Request inboxes are recipient-facing surfaces gated by
 * capability tokens: a member clause anywhere near `/api/requests/[token]/uploads`, `/guide` or
 * `/request-view/[token]` breaks inbound uploads, which is why the refusal is the design and not an
 * omission.
 *
 * One file so the code is a string one grep finds, and so the review route and the write answer with
 * the same body.
 */
import { NextResponse } from "next/server";

/** The one machine-readable code for "this project cannot be locked". */
export const LOCK_NOT_SUPPORTED_ON_REQUEST = "LOCK_NOT_SUPPORTED_ON_REQUEST";

/** The 400 both the review and the write answer for a request inbox. */
export function lockNotSupportedOnRequestResponse(): NextResponse {
  return NextResponse.json(
    {
      error: "A request inbox cannot be made private: people outside the workspace upload into it through its link.",
      code: LOCK_NOT_SUPPORTED_ON_REQUEST,
    },
    { status: 400 },
  );
}
