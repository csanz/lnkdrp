/**
 * API route for `/api/replace/:token/uploads`.
 *
 * Starts a replacement upload for a specific doc using a capability token
 * (`Doc.replaceUploadToken`) and returns an `uploadSecret` for follow-up calls.
 */
import { POST as postDocUpdateUpload } from "@/app/api/doc/update/[code]/uploads/route";

export const runtime = "nodejs";
export async function POST(request: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  return await postDocUpdateUpload(request, { params: Promise.resolve({ code: token }) });
}


