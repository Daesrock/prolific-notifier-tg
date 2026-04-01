import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ quiet: true });

const EnvSchema = z
  .object({
    PROLIFIC_EMAIL: z.string().email(),
    PROLIFIC_PASSWORD: z.string().min(1),
    TELEGRAM_BOT_TOKEN: z.string().min(1),
    TELEGRAM_CHAT_ID: z.string().min(1),
    POLL_INTERVAL_MS: z.coerce.number().int().min(60_000).default(300_000),
    POLL_INTERVAL_MIN_MS: z.coerce.number().int().min(60_000).optional(),
    POLL_INTERVAL_MAX_MS: z.coerce.number().int().min(60_000).optional(),
    DATABASE_PATH: z.string().default("./data/prolific.db"),
    SESSION_STATE_PATH: z.string().default("./data/prolific-session.json"),
    SESSION_STATE_GZIP_BASE64: z.string().optional(),
    SESSION_STATE_BASE64: z.string().optional(),
    PROLIFIC_LOGIN_URL: z.string().url().default("https://app.prolific.com/login"),
    PROLIFIC_STUDIES_URL: z.string().url().default("https://app.prolific.com/studies"),
    HEADLESS: z
      .string()
      .optional()
      .transform((value) => {
        if (!value) {
          return true;
        }
        return value.toLowerCase() !== "false";
      }),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    MAX_AUTH_RETRIES: z.coerce.number().int().min(1).max(10).default(3),
    ALERT_COOLDOWN_MS: z.coerce.number().int().min(30_000).default(900_000),
    HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(60_000).default(3_600_000),
  })
  .superRefine((env, ctx) => {
    const hasMin = env.POLL_INTERVAL_MIN_MS !== undefined;
    const hasMax = env.POLL_INTERVAL_MAX_MS !== undefined;

    if (hasMin !== hasMax) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "POLL_INTERVAL_MIN_MS and POLL_INTERVAL_MAX_MS must be set together",
        path: hasMin ? ["POLL_INTERVAL_MAX_MS"] : ["POLL_INTERVAL_MIN_MS"],
      });
      return;
    }

    if (hasMin && hasMax && env.POLL_INTERVAL_MIN_MS! > env.POLL_INTERVAL_MAX_MS!) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "POLL_INTERVAL_MIN_MS must be less than or equal to POLL_INTERVAL_MAX_MS",
        path: ["POLL_INTERVAL_MIN_MS"],
      });
    }
  });

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(): AppConfig {
  const parsed = EnvSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment variables: ${issues}`);
  }

  return parsed.data;
}
