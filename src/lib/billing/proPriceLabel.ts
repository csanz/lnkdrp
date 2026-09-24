import { unstable_cache, revalidateTag } from "next/cache";

import { connectMongo } from "@/lib/mongodb";
import { BillingConfigModel } from "@/lib/models/BillingConfig";

const BILLING_PRO_PRICE_LABEL_TAG = "billing:pro-price-label";

export type ProPriceLabels = {
  /** Monthly Pro, e.g. "$29/mo". */
  proPriceLabel: string | null;
  /** Yearly Pro, e.g. "$290/yr"; `null` when the deployment sells monthly only. */
  proAnnualPriceLabel: string | null;
  /** The yearly price per month, e.g. "$24/mo", for "billed yearly" copy. */
  proAnnualPerMonthLabel: string | null;
  updatedDate: string | null;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Read the Pro price labels from MongoDB (cached) so dashboard reads avoid calling Stripe.
 *
 * Cache invalidation should happen via `revalidateBillingProPriceLabel()`.
 */
export const getBillingProPriceLabel = unstable_cache(
  async (): Promise<ProPriceLabels> => {
    await connectMongo();
    const doc = (await BillingConfigModel.findOne({ key: "global" })
      .select({ proPriceLabel: 1, proAnnualPriceLabel: 1, proAnnualPerMonthLabel: 1, updatedDate: 1 })
      .lean()) as Record<string, unknown> | null;
    const updatedDate = doc?.updatedDate instanceof Date ? doc.updatedDate.toISOString() : null;
    return {
      proPriceLabel: str(doc?.proPriceLabel),
      proAnnualPriceLabel: str(doc?.proAnnualPriceLabel),
      proAnnualPerMonthLabel: str(doc?.proAnnualPerMonthLabel),
      updatedDate,
    };
  },
  ["billing:pro-price-label:v2"],
  { tags: [BILLING_PRO_PRICE_LABEL_TAG] },
);

/** Invalidate the cached Pro price labels so the next read pulls from MongoDB. */
export function revalidateBillingProPriceLabel() {
  revalidateTag(BILLING_PRO_PRICE_LABEL_TAG, "max");
}
