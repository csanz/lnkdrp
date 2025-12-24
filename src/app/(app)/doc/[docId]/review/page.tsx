"use client";

import { use } from "react";
import DocReviewPageClient from "./pageClient";

export default function DocReviewPage(props: { params: Promise<{ docId: string }> }) {
  const { docId } = use(props.params);
  return <DocReviewPageClient docId={docId} />;
}


