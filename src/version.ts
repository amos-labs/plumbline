import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * The CLI's own package version, read at runtime so the tsc layout
 * (dist/version.js) and the esbuild bundle (dist/index.js) both resolve
 * ../package.json to the package root. Stamped into receipts and compared
 * against the repo's pinned gate version so a producer/gate version skew is
 * diagnosable in one read (#69's producer-side ask).
 */
export const PLUMB_VERSION: string = require("../package.json").version;
