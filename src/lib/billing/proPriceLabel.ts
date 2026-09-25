import { unstable_cache, revalidateTag } from "next/cache";

import { connectMongo } from "@/lib/mongodb";
import { BillingConfigModel } from "@/lib/models/BillingConfig";
import { debugError } from "@/lib/debug";
import { readProPriceLabelsFromStripe } from "@/lib/billing/proPriceFromStripe";

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
 * When the row has no monthly label yet (nobody has pressed "refresh from Stripe" on the admin
 * billing page), the labels are read from Stripe once, written to the row, and returned, so a
 * fresh deployment's `/pricing` shows the price and not "price shown at checkout". If Stripe
 * cannot be read the nulls stand and the cache retries after an hour; the page copes with null.
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
    const fromRow: ProPriceLabels = {
      proPriceLabel: str(doc?.proPriceLabel),
      proAnnualPriceLabel: str(doc?.proAnnualPriceLabel),
      proAnnualPerMonthLabel: str(doc?.proAnnualPerMonthLabel),
      updatedDate,
    };
    if (fromRow.proPriceLabel) return fromRow;

    try {
      const fromStripe = await readProPriceLabelsFromStripe();
      if (!fromStripe) return fromRow;
      await BillingConfigModel.updateOne(
        { key: "global" },
        { $setOnInsert: { key: "global" }, $set: fromStripe },
        { upsert: true },
      );
      return { ...fromStripe, updatedDate: new Date().toISOString() };
    } catch (err) {
      debugError(1, "[billing] pro price labels: Stripe read failed; showing none", {
        error: err instanceof Error ? err.message : String(err),
      });
      return fromRow;
    }
  },
  ["billing:pro-price-label:v3"],
  { tags: [BILLING_PRO_PRICE_LABEL_TAG], revalidate: 3600 },
);

/** Invalidate the cached Pro price labels so the next read pulls from MongoDB. */
export function revalidateBillingProPriceLabel() {
  revalidateTag(BILLING_PRO_PRICE_LABEL_TAG, "max");
}
