/**
 * Public request upload page: `/request/:token`.
 *
 * This is the preferred request-link route (alias of `/r/:token`).
 */
import RequestUploadPage from "../../r/[token]/page";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default RequestUploadPage;




