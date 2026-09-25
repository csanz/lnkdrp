/**
 * JSON that is safe to place inside an inline `<script>` element. Extracted from the workspace
 * switch route, which is the only place the app renders a script from request data; Next refuses
 * non-handler exports from a route module, and the escaping test needs to import this.
 */
/**
 * Serialises a value for embedding inside an inline `<script>`.
 *
 * `JSON.stringify` alone is NOT safe here, and that was a live XSS on this route. It escapes
 * quotes and backslashes but leaves `<` and `/` untouched, so a `returnTo` of
 * `/</script><script>alert(1)</script>` survived `safeReturnTo` (which only rejects values that do
 * not start with a single `/`), and the literal `</script>` inside the JSON string closed the
 * element for the HTML parser. Everything after it was parsed as markup, on this origin, in the
 * victim's authenticated session — reachable by sending a colleague a link.
 *
 * Escaping `<` and `>` as unicode escapes keeps the value byte-identical once JavaScript parses it
 * while making it impossible to terminate the element. `&` is escaped for the same reason in HTML
 * contexts, and U+2028/U+2029 because they are literal line terminators in JavaScript source.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
