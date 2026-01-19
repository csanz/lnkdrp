import React from "react";

type StripePricingTableElementProps = React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
  "pricing-table-id"?: string;
  "publishable-key"?: string;
  "client-reference-id"?: string;
  "customer-email"?: string;
};

// With `jsx: "react-jsx"`, the `JSX` namespace is provided by `react/jsx-runtime`,
// so we augment that module (and the dev runtime) instead of `declare global`.
declare module "react/jsx-runtime" {
  namespace JSX {
    interface IntrinsicElements {
      /**
       * Stripe-hosted pricing table web component.
       * Loaded via `https://js.stripe.com/v3/pricing-table.js`.
       */
      "stripe-pricing-table": StripePricingTableElementProps;
    }
  }
}

declare module "react/jsx-dev-runtime" {
  namespace JSX {
    interface IntrinsicElements {
      /**
       * Stripe-hosted pricing table web component.
       * Loaded via `https://js.stripe.com/v3/pricing-table.js`.
       */
      "stripe-pricing-table": StripePricingTableElementProps;
    }
  }
}

export {};
