import { runUpdater } from "./updater.js";

runUpdater().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
