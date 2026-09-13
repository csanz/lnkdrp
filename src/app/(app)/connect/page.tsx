/**
 * Page for `/connect` (authenticated app shell).
 *
 * "Connect your agent": create API keys, add lnkdrp to an MCP client, verify the connection.
 */
import ConnectPageClient from "./pageClient";

/** Render the Connect page. */
export default function ConnectPage() {
  return <ConnectPageClient />;
}
