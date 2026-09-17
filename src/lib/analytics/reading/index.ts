/**
 * Read-time math for document reading analytics. Pure: no database, framework or DOM imports, so
 * the API routes, the audit script and unit tests all share one implementation.
 */
export * from "./constants";
export * from "./types";
export * from "./normalize";
export * from "./people";
export * from "./pageTable";
export * from "./attention";
export * from "./verdict";
export * from "./format";
export * from "./identity";
export * from "./pageLabels";
export * from "./days";
export * from "./response";
