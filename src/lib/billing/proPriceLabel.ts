import { unstable_cache, revalidateTag } from "next/cache";

import { connectMongo } from "@/lib/mongodb";
import { BillingConfigModel } from "@/lib/models/BillingConfig";

const BILLING_PRO_PRICE_LABEL_TAG = "billing:pro-price-label";

/**
 * Read the Pro price label from MongoDB (cached) so dashboard reads avoid calling Stripe.
 *
 * Cache invalidation should happen via `revalidateBillingProPriceLabel()`.
 */
export const getBillingProPriceLabel = unstable_cache(
  async (): Promise<{ proPriceLabel: string | null; updatedDate: string | null }> => {
    await connectMongo();
    const doc = await BillingConfigModel.findOne({ key: "global" })
      .select({ proPriceLabel: 1, updatedDate: 1 })
      .lean();
    const proPriceLabel = typeof (doc as any)?.proPriceLabel === "string" ? String((doc as any).proPriceLabel).trim() : "";
    const updatedDate = (doc as any)?.updatedDate instanceof Date ? (doc as any).updatedDate.toISOString() : null;
    return { proPriceLabel: proPriceLabel || null, updatedDate };
  },
  ["billing:pro-price-label:v1"],
  { tags: [BILLING_PRO_PRICE_LABEL_TAG] },
);

/** Invalidate the cached Pro price label so the next read pulls from MongoDB. */
export function revalidateBillingProPriceLabel() {
  revalidateTag(BILLING_PRO_PRICE_LABEL_TAG);
}


