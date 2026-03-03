#!/usr/bin/env node
export { buildRunTreeRows } from "./cli/run/progress";
export { loadImportedModules } from "./cli/shared/paths";
export { runCli, main } from "./cli/index";

import { runCli } from "./cli/index";

if (require.main === module) {
  runCli(process.argv);
}
