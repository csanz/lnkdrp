"use client";

import { use } from "react";
import ProjectPageClient from "./pageClient";

export default function ProjectPage(props: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = use(props.params);
  return <ProjectPageClient projectSlug={projectSlug} />;
}


