/**
 * What an upload secret may still do, by the upload's status.
 *
 * A recipient uploading through a request link or a replace link holds an `uploadSecret` instead of
 * a session. The secret is minted with the Upload row and never rotated, and the recipient's page
 * keeps using it after the upload completes: it polls `GET /api/uploads/:id` with it until the
 * document is ready. So the secret cannot simply be cleared on completion.
 *
 * What it must not do is write after completion. Every write surface used to check only
 * `{ _id, uploadSecret, isDeleted }`, so a recipient who kept the secret could, weeks later, mint a
 * new Blob token for the same pathname, PATCH the row back to `uploaded` with the new bytes, and
 * trigger processing again. The claim succeeded (`uploaded -> processing`), the job re-extracted
 * text from the swapped file and rewrote `blobUrl` in place: no new version, no `DocChange` row, no
 * email (deduped on `uploadId`). The owner's completed document silently became something else.
 *
 * The rule: a secret may write while the upload is still being uploaded, and may start processing
 * once it is uploaded (or retry after a failure, or re-claim a stale run). Once the row is
 * `completed`, the secret is read-only. The statuses below are the ones each surface matches in its
 * own Mongo filter, so the check and the write are one operation.
 */

/** Statuses in which the Blob token route and `PATCH /api/uploads/:id` accept the secret. */
export const SECRET_WRITABLE_STATUSES = ["uploading", "uploaded"] as const;

/** Statuses in which `POST /api/uploads/:id/process` accepts the secret. */
export const SECRET_PROCESSABLE_STATUSES = ["uploaded", "processing", "failed"] as const;

/** Mongo filter fragment for a secret-authorised write: the row must still be writable. */
export function secretWritableFilter(): { status: { $in: readonly string[] } } {
  return { status: { $in: SECRET_WRITABLE_STATUSES } };
}

/** Mongo filter fragment for a secret-authorised processing request. */
export function secretProcessableFilter(): { status: { $in: readonly string[] } } {
  return { status: { $in: SECRET_PROCESSABLE_STATUSES } };
}
