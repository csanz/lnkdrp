/**
 * Workspace-wide metrics (docs/prds/lnkdrp-workspace-metrics.md): the response contract and the
 * pure helpers behind it.
 *
 * Deliberately **not** re-exporting `./query`, which imports the Mongoose models: the page client
 * imports these types, and a barrel that dragged the models in would pull the database layer into
 * the browser bundle. Server code imports `./query` directly.
 */
export * from "./types";
export * from "./range";
export * from "./shape";
