import pino from "pino";
import { ProlificStudy } from "../types/study";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export class TelegramNotifier {
  private readonly endpoint: string;

  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
    private readonly logger: pino.Logger,
  ) {
    this.endpoint = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
  }

  async sendStudy(study: ProlificStudy): Promise<void> {
    const lines = [
      "<b>New Prolific Study</b>",
      `<b>Name:</b> ${escapeHtml(study.title)}`,
      `<b>Reward:</b> ${escapeHtml(study.rewardText ?? "Not visible")}`,
      `<b>Estimated Time:</b> ${escapeHtml(study.estimatedTimeText ?? "Not visible")}`,
      `<b>Places Available:</b> ${study.placesAvailable ?? "Not visible"}`,
      `<b>Places Taken:</b> ${study.placesTaken ?? "Not visible"}`,
      `<b>Total Places:</b> ${study.placesTotal ?? "Not visible"}`,
      `<b>Study ID:</b> ${escapeHtml(study.id)}`,
      `<b>Discovered:</b> ${escapeHtml(study.discoveredAtIso)}`,
      `<b>Link:</b> ${escapeHtml(study.url)}`,
    ];

    await this.sendRaw(lines.join("\n"));
  }

  async sendAlert(title: string, details: string): Promise<void> {
    const message = `<b>${escapeHtml(title)}</b>\n${escapeHtml(details)}`;
    await this.sendRaw(message);
  }

  private async sendRaw(text: string): Promise<void> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: this.chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: false,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      this.logger.error({ status: response.status, body }, "Failed to send Telegram message");
      throw new Error(`Telegram API error (${response.status}): ${body}`);
    }
  }
}
