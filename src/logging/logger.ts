import pino from "pino";

export function createLogger(level: pino.LevelWithSilent) {
  return pino({
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
    base: undefined,
  });
}
