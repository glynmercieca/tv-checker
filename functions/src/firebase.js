import { onSchedule } from "firebase-functions/v2/scheduler";
import { runUpdater } from "./updater.js";

export const updateTvPrices = onSchedule(
  {
    schedule: "17 7 * * *",
    timeZone: "Europe/Malta",
    region: "europe-west1",
    timeoutSeconds: 540,
    memory: "512MiB",
    maxInstances: 1,
    secrets: ["BREVO_SMTP_USER", "BREVO_SMTP_KEY", "EMAIL_TO", "EMAIL_FROM"],
  },
  async () => runUpdater(),
);
