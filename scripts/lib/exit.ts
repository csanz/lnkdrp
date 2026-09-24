/**
 * `process.exit`, minus the crash Windows adds to it.
 *
 * Node 23+ on Windows aborts at exit with
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c` when
 * `process.exit()` runs while `fetch` (undici) is still closing a socket — the work is done, the
 * output is printed, and the process then dies with a stack-buffer-overrun code that reads as
 * failure (nodejs/node#56645, #64322). Every script here that mails someone or calls an API and
 * then exits is exposed. A short pause lets the socket finish closing; on other platforms it is a
 * no-op.
 */
export async function exit(code: number): Promise<never> {
  if (process.platform === "win32") await new Promise((r) => setTimeout(r, 150));
  process.exit(code);
}
