/**
 * Unique indexes behind the billing idempotency guarantees, plus the `sharelinks` text index.
 *
 * Until now these existed only through Mongoose autoIndex, which fails silently and is not
 * awaited, so the first requests on a fresh database could run before the index existed (a
 * replayed Stripe webhook or a double credit grant would then insert twice). Creating them here
 * means they exist before traffic, and a duplicate already in the data (E11000) stops the runner
 * instead of being swallowed.
 *
 * Each key, name and option matches the declaration in `src/lib/models/*` exactly, so this does
 * not conflict with what autoIndex builds:
 * - `stripeevents.eventId_1` unique (StripeEvent.ts) — webhook replay protection.
 * - `creditpurchases.stripeCheckoutSessionId_1` unique (CreditPurchase.ts) — one grant per Checkout session.
 * - `creditledgers.workspaceId_1_idempotencyKey_1` unique (CreditLedger.ts) — one ledger row per charge.
 * - `creditledgers.workspaceId_1_eventType_1_cycleKey_1` partial unique (CreditLedger.ts) — one
 *   included-credits grant per workspace per cycle.
 * - `workspacecreditbalances.workspaceId_1` unique (WorkspaceCreditBalance.ts).
 * - `subscriptions.orgId_1` unique (Subscription.ts).
 * - `sharelinks.sharelinks_label_audience_text` text (ShareLink.ts) — the MCP link search errors
 *   without it.
 *
 * Safe to re-run and safe where autoIndex already built them: an index that is already present
 * with the same shape is left alone; one with the same name but a different shape is replaced.
 */
export async function up({ db }) {
  const isText = (key) => Object.values(key).some((v) => v === "text");
  const sortedJson = (obj) => JSON.stringify(Object.entries(obj ?? {}).sort(([a], [b]) => a.localeCompare(b)));

  // The server stores a text index's key as `{ _fts: "text", _ftsx: 1 }` with the fields in `weights`.
  function sameShape(existing, key, options) {
    if (isText(key)) {
      if (existing.textIndexVersion == null) return false;
      const wantWeights = Object.fromEntries(Object.keys(key).map((k) => [k, options?.weights?.[k] ?? 1]));
      return sortedJson(existing.weights) === sortedJson(wantWeights);
    }
    return (
      JSON.stringify(existing.key ?? null) === JSON.stringify(key ?? null) &&
      Boolean(existing.unique) === Boolean(options?.unique) &&
      Boolean(existing.sparse) === Boolean(options?.sparse) &&
      JSON.stringify(existing.partialFilterExpression ?? null) === JSON.stringify(options?.partialFilterExpression ?? null)
    );
  }

  async function ensureIndex(coll, key, options) {
    const name = options.name;
    const indexes = await coll
      .indexes()
      .catch((e) => (e?.code === 26 || /ns does not exist/i.test(String(e?.message)) ? [] : Promise.reject(e))); // fresh DB: collection may not exist yet
    const existing = indexes.find((i) => i?.name === name);
    if (existing) {
      if (sameShape(existing, key, options)) return; // already correct
      await coll.dropIndex(existing.name);
    } else {
      // Same index under another name (built by hand): creating it again would fail with IndexOptionsConflict.
      const equivalent = indexes.find((i) => i?.name !== "_id_" && sameShape(i, key, options));
      if (equivalent) {
        console.log(`  note: ${coll.collectionName} already has ${name} as "${equivalent.name}"; left as is`);
        return;
      }
    }
    await coll.createIndex(key, options);
  }

  await ensureIndex(db.collection("stripeevents"), { eventId: 1 }, { name: "eventId_1", unique: true });

  await ensureIndex(
    db.collection("creditpurchases"),
    { stripeCheckoutSessionId: 1 },
    { name: "stripeCheckoutSessionId_1", unique: true },
  );

  const ledgers = db.collection("creditledgers");
  await ensureIndex(ledgers, { workspaceId: 1, idempotencyKey: 1 }, { name: "workspaceId_1_idempotencyKey_1", unique: true });
  await ensureIndex(
    ledgers,
    { workspaceId: 1, eventType: 1, cycleKey: 1 },
    {
      name: "workspaceId_1_eventType_1_cycleKey_1",
      unique: true,
      partialFilterExpression: { eventType: "cycle_grant_included", cycleKey: { $type: "string" } },
    },
  );

  await ensureIndex(db.collection("workspacecreditbalances"), { workspaceId: 1 }, { name: "workspaceId_1", unique: true });

  await ensureIndex(db.collection("subscriptions"), { orgId: 1 }, { name: "orgId_1", unique: true });

  await ensureIndex(
    db.collection("sharelinks"),
    { label: "text", audience: "text" },
    { name: "sharelinks_label_audience_text", weights: { label: 5, audience: 1 } },
  );
}
