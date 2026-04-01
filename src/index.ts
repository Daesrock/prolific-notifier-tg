import pino from "pino";
import { loadConfig } from "./config/env";
import { createLogger } from "./logging/logger";
import { TelegramNotifier } from "./notify/telegram";
import { AuthenticationError, CaptchaOrBlockError, ProlificSessionManager } from "./prolific/session";
import { StudyStore } from "./store/sqlite";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);

  const studyStore = new StudyStore(config.DATABASE_PATH);
  const telegram = new TelegramNotifier(config.TELEGRAM_BOT_TOKEN, config.TELEGRAM_CHAT_ID, logger.child({ module: "telegram" }));
  const prolific = new ProlificSessionManager(config, logger.child({ module: "prolific" }));

  let shuttingDown = false;
  let paused = false;
  let pauseReason = "";
  const lastAlertAtByKey = new Map<string, number>();
  let lastHeartbeatAt = 0;

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.warn({ signal }, "Shutdown signal received");

    try {
      await prolific.close();
    } catch (error) {
      logger.error({ err: error }, "Error while closing Prolific session");
    }

    studyStore.close();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  const sendThrottledAlert = async (key: string, title: string, details: string, cooldownMs = config.ALERT_COOLDOWN_MS) => {
    const now = Date.now();
    const lastAlertAt = lastAlertAtByKey.get(key) ?? 0;
    if (cooldownMs > 0 && now - lastAlertAt < cooldownMs) {
      logger.warn({ key, title, details }, "Alert suppressed due to cooldown");
      return;
    }

    try {
      await telegram.sendAlert(title, details);
      lastAlertAtByKey.set(key, now);
    } catch (error) {
      logger.error({ err: error, key, title }, "Failed to send Telegram alert");
    }
  };

  logger.info("Prolific notifier worker started");
  await sendThrottledAlert(
    "startup",
    "Prolific notifier started",
    `Worker online. Poll interval ${Math.round(config.POLL_INTERVAL_MS / 1000)}s`,
    0,
  );

  while (!shuttingDown) {
    const loopStartedAt = Date.now();

    if (paused) {
      logger.warn({ reason: pauseReason }, "Worker is paused due to captcha/block");

      const now = Date.now();
      if (now - lastHeartbeatAt >= config.HEARTBEAT_INTERVAL_MS) {
        await sendThrottledAlert("paused_heartbeat", "Worker paused", pauseReason, config.HEARTBEAT_INTERVAL_MS);
        lastHeartbeatAt = now;
      }

      await sleep(config.POLL_INTERVAL_MS);
      continue;
    }

    try {
      const studies = await prolific.fetchStudies();
      logger.info({ count: studies.length }, "Fetched studies from Prolific");

      let newStudyCount = 0;
      for (const study of studies) {
        if (studyStore.hasStudy(study.id)) {
          continue;
        }

        await telegram.sendStudy(study);
        studyStore.markNotified(study);
        newStudyCount += 1;

        logger.info({ studyId: study.id, title: study.title }, "New study sent to Telegram");
      }

      if (newStudyCount === 0) {
        logger.info("No new studies detected in this cycle");
      }
    } catch (error) {
      if (error instanceof CaptchaOrBlockError) {
        paused = true;
        pauseReason = `${error.message}. Manual intervention required before restart.`;
        logger.error({ error: error.message }, "Captcha/block detected. Entering pause mode");
        await sendThrottledAlert("captcha_block", "Captcha or block detected", pauseReason);
      } else if (error instanceof AuthenticationError) {
        const details = `Authentication issue: ${error.message}`;
        logger.error({ error: error.message }, "Authentication failed");
        await sendThrottledAlert("authentication_issue", "Authentication issue", details);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ error: message }, "Unexpected worker error");
        await sendThrottledAlert("unexpected_error", "Unexpected worker error", message);
      }
    }

    const elapsed = Date.now() - loopStartedAt;
    const sleepMs = Math.max(config.POLL_INTERVAL_MS - elapsed, 1_000);
    await sleep(sleepMs);
  }
}

run().catch((error) => {
  const fallbackLogger = pino({ level: "error" });
  fallbackLogger.error({ error }, "Fatal startup error");
  process.exit(1);
});
