import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import { Browser, BrowserContext, Page, chromium } from "playwright";
import { AppConfig } from "../config/env";
import { ProlificStudy } from "../types/study";
import { extractStudies } from "./studies";

const EMAIL_SELECTORS = [
  "input[type='email']",
  "input[name='email']",
  "input[id*='email']",
  "input[autocomplete='username']",
];

const PASSWORD_SELECTORS = [
  "input[type='password']",
  "input[name='password']",
  "input[id*='password']",
  "input[autocomplete='current-password']",
];

const SUBMIT_SELECTORS = [
  "button[type='submit']",
  "button:has-text('Log in')",
  "button:has-text('Sign in')",
  "button:has-text('Continue')",
];

const CAPTCHA_TEXT_PATTERN = /captcha|verify you are human|human verification|security check|challenge/i;

export class CaptchaOrBlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptchaOrBlockError";
  }
}

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class ProlificSessionManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: pino.Logger,
  ) {}

  async start(): Promise<void> {
    if (this.browser && this.context && this.page) {
      return;
    }

    const sessionPath = path.resolve(this.config.SESSION_STATE_PATH);
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });

    this.browser = await chromium.launch({
      headless: this.config.HEADLESS,
    });

    const contextOptions: { storageState?: string } = {};
    if (fs.existsSync(sessionPath)) {
      contextOptions.storageState = sessionPath;
      this.logger.info({ sessionPath }, "Loaded existing browser session state");
    }

    this.context = await this.browser.newContext(contextOptions);
    this.page = await this.context.newPage();
    this.page.setDefaultNavigationTimeout(60_000);
    this.page.setDefaultTimeout(20_000);
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
    }
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async fetchStudies(): Promise<ProlificStudy[]> {
    await this.start();

    const page = this.requirePage();
    await this.ensureAuthenticated(page);

    await page.goto(this.config.PROLIFIC_STUDIES_URL, { waitUntil: "domcontentloaded" });

    if (await this.isBlockedByCaptcha(page)) {
      throw new CaptchaOrBlockError("Captcha or security challenge detected on studies page");
    }

    return extractStudies(page);
  }

  private async ensureAuthenticated(page: Page): Promise<void> {
    await page.goto(this.config.PROLIFIC_STUDIES_URL, { waitUntil: "domcontentloaded" });

    if (await this.isBlockedByCaptcha(page)) {
      throw new CaptchaOrBlockError("Captcha or security challenge detected before authentication");
    }

    if (!(await this.isLoggedOut(page))) {
      return;
    }

    this.logger.warn("Session is logged out. Attempting re-login");

    let attempt = 0;
    while (attempt < this.config.MAX_AUTH_RETRIES) {
      attempt += 1;

      try {
        await this.login(page);
        await this.saveSessionState();
        this.logger.info({ attempt }, "Re-login successful");
        return;
      } catch (error) {
        if (error instanceof CaptchaOrBlockError) {
          throw error;
        }

        const delayMs = attempt * 2_000;
        this.logger.warn(
          {
            attempt,
            maxRetries: this.config.MAX_AUTH_RETRIES,
            delayMs,
            error: error instanceof Error ? error.message : String(error),
          },
          "Re-login attempt failed",
        );

        if (attempt >= this.config.MAX_AUTH_RETRIES) {
          break;
        }

        await page.waitForTimeout(delayMs);
      }
    }

    throw new AuthenticationError("Unable to re-login after max retries");
  }

  private async login(page: Page): Promise<void> {
    await page.goto(this.config.PROLIFIC_LOGIN_URL, { waitUntil: "domcontentloaded" });

    if (await this.isBlockedByCaptcha(page)) {
      throw new CaptchaOrBlockError("Captcha or security challenge detected on login page");
    }

    const emailFilled = await this.fillFirstMatch(page, EMAIL_SELECTORS, this.config.PROLIFIC_EMAIL);
    const passwordFilled = await this.fillFirstMatch(page, PASSWORD_SELECTORS, this.config.PROLIFIC_PASSWORD);

    if (!emailFilled || !passwordFilled) {
      throw new AuthenticationError("Unable to find email/password fields on login page");
    }

    const clicked = await this.clickFirstMatch(page, SUBMIT_SELECTORS);
    if (!clicked) {
      throw new AuthenticationError("Unable to find login submit button");
    }

    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2_000);

    if (await this.isBlockedByCaptcha(page)) {
      throw new CaptchaOrBlockError("Captcha or security challenge appeared after login submit");
    }

    await page.goto(this.config.PROLIFIC_STUDIES_URL, { waitUntil: "domcontentloaded" });
    if (await this.isBlockedByCaptcha(page)) {
      throw new CaptchaOrBlockError("Captcha or security challenge detected after login");
    }

    if (await this.isLoggedOut(page)) {
      throw new AuthenticationError("Prolific login did not establish an authenticated session");
    }
  }

  private async saveSessionState(): Promise<void> {
    const context = this.requireContext();
    const sessionPath = path.resolve(this.config.SESSION_STATE_PATH);
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    await context.storageState({ path: sessionPath });
  }

  private async fillFirstMatch(page: Page, selectors: string[], value: string): Promise<boolean> {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if ((await locator.count()) === 0) {
        continue;
      }
      await locator.fill(value);
      return true;
    }
    return false;
  }

  private async clickFirstMatch(page: Page, selectors: string[]): Promise<boolean> {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if ((await locator.count()) === 0) {
        continue;
      }
      await locator.click();
      return true;
    }
    return false;
  }

  private async isLoggedOut(page: Page): Promise<boolean> {
    const url = page.url().toLowerCase();
    if (url.includes("/login")) {
      return true;
    }

    for (const selector of [...EMAIL_SELECTORS, ...PASSWORD_SELECTORS]) {
      const count = await page.locator(selector).count();
      if (count > 0) {
        return true;
      }
    }

    return false;
  }

  private async isBlockedByCaptcha(page: Page): Promise<boolean> {
    const url = page.url().toLowerCase();
    if (url.includes("captcha") || url.includes("challenge")) {
      return true;
    }

    const bodyText = (await page.locator("body").innerText()).slice(0, 8_000);
    return CAPTCHA_TEXT_PATTERN.test(bodyText);
  }

  private requirePage(): Page {
    if (!this.page) {
      throw new Error("Browser page is not initialized");
    }
    return this.page;
  }

  private requireContext(): BrowserContext {
    if (!this.context) {
      throw new Error("Browser context is not initialized");
    }
    return this.context;
  }
}
