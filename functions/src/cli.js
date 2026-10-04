import { runUpdater } from "./updater.js";

runUpdater().catch((error) => {
  console.error(`Update failed: ${error.message}`);
  process.exitCode = 1;
});
