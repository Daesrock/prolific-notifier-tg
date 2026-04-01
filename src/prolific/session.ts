import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import { Browser, BrowserContext, Frame, Page, chromium } from "playwright";
import { AppConfig } from "../config/env";
import { ProlificStudy } from "../types/study";
import { extractStudies } from "./studies";

const EMAIL_SELECTORS = [
  "input[type='email']",
  "input[name='username']",
  "input[name='identifier']",
  "input[name='email']",
  "input[id*='username']",
  "input[id*='email']",
  "input[autocomplete='username']",
  "input[type='text']",
];

const LOGIN_STATE_SELECTORS = [
  "input[type='email']",
  "input[name='username']",
  "input[name='identifier']",
  "input[name='email']",
  "input[id*='username']",
  "input[id*='email']",
  "input[autocomplete='username']",
  "input[type='password']",
  "input[name='password']",
  "input[id*='password']",
  "input[autocomplete='current-password']",
];

const PASSWORD_SELECTORS = [
  "input[type='password']",
  "input[name='password']",
  "input[id*='password']",
  "input[autocomplete='current-password']",
];

const SUBMIT_SELECTORS = [
  "button[type='submit']",
  "button[name='action']",
  "input[type='submit']",
  "button:has-text('Log in')",
  "button:has-text('Sign in')",
  "button:has-text('Continue')",
  "button:has-text('Next')",
];

const PRE_LOGIN_CONTINUE_SELECTORS = [
  "a[href*='auth.prolific.com']",
  "a[href*='/u/login']",
  "button:has-text('Log in')",
  "a:has-text('Log in')",
  "button:has-text('Continue')",
  "a:has-text('Continue')",
];

const BLOCK_TEXT_PATTERN =
  /captcha|verify you are human|human verification|security check|challenge|checking your browser|just a moment|cloudflare|attention required|enable javascript and cookies|access denied|browser integrity/i;
const BLOCK_TITLE_PATTERN = /just a moment|attention required|verify you are human|security check/i;
const INVALID_CREDENTIALS_PATTERN = /invalid|incorrect|wrong password|try again|unable to sign in/i;

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
    let lastErrorMessage = "unknown";
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

        lastErrorMessage = error instanceof Error ? error.message : String(error);

        const delayMs = attempt * 2_000;
        this.logger.warn({ attempt, maxRetries: this.config.MAX_AUTH_RETRIES, delayMs }, `Re-login attempt failed: ${lastErrorMessage}`);

        if (attempt >= this.config.MAX_AUTH_RETRIES) {
          break;
        }

        await page.waitForTimeout(delayMs);
      }
    }

    throw new AuthenticationError(`Unable to re-login after max retries. Last error: ${lastErrorMessage}`);
  }

  private async login(page: Page): Promise<void> {
    await page.goto(this.config.PROLIFIC_LOGIN_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1_500);
    await page.waitForLoadState("networkidle").catch(() => undefined);

    if (await this.isBlockedByCaptcha(page)) {
      throw new CaptchaOrBlockError("Captcha or security challenge detected on login page");
    }

    if (!(await this.hasAnySelector(page, [...EMAIL_SELECTORS, ...PASSWORD_SELECTORS]))) {
      await this.clickFirstMatch(page, PRE_LOGIN_CONTINUE_SELECTORS);
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(1_500);
    }

    const emailFilled = await this.fillFirstMatch(page, EMAIL_SELECTORS, this.config.PROLIFIC_EMAIL);
    if (!emailFilled) {
      const pageSummary = await this.getPageSummary(page);
      throw new AuthenticationError(`Unable to find email/username field on login page (${page.url()}). ${pageSummary}`);
    }

    if (!(await this.hasAnySelector(page, PASSWORD_SELECTORS))) {
      const continueClicked = await this.clickFirstMatch(page, SUBMIT_SELECTORS);
      if (!continueClicked) {
        throw new AuthenticationError(`Unable to continue from identifier step (${page.url()})`);
      }

      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(1_500);

      if (await this.isBlockedByCaptcha(page)) {
        throw new CaptchaOrBlockError("Captcha or security challenge appeared after identifier submit");
      }
    }

    const passwordFilled = await this.fillFirstMatch(page, PASSWORD_SELECTORS, this.config.PROLIFIC_PASSWORD);
    if (!passwordFilled) {
      const pageSummary = await this.getPageSummary(page);
      throw new AuthenticationError(`Unable to find password field on login flow (${page.url()}). ${pageSummary}`);
    }

    const clicked = await this.clickFirstMatch(page, SUBMIT_SELECTORS);
    if (!clicked) {
      throw new AuthenticationError(`Unable to find login submit button (${page.url()})`);
    }

    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2_000);

    if (await this.isBlockedByCaptcha(page)) {
      throw new CaptchaOrBlockError("Captcha or security challenge appeared after login submit");
    }

    if (await this.hasInvalidCredentialsMessage(page)) {
      throw new AuthenticationError("Prolific rejected credentials (invalid email/password or login denied)");
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
    for (const root of this.getSearchRoots(page)) {
      for (const selector of selectors) {
        const locator = root.locator(selector).first();
        if ((await locator.count()) === 0) {
          continue;
        }
        await locator.fill(value);
        return true;
      }
    }
    return false;
  }

  private async clickFirstMatch(page: Page, selectors: string[]): Promise<boolean> {
    for (const root of this.getSearchRoots(page)) {
      for (const selector of selectors) {
        const locator = root.locator(selector).first();
        if ((await locator.count()) === 0) {
          continue;
        }
        await locator.click();
        return true;
      }
    }
    return false;
  }

  private async hasAnySelector(page: Page, selectors: string[]): Promise<boolean> {
    for (const root of this.getSearchRoots(page)) {
      for (const selector of selectors) {
        if ((await root.locator(selector).count()) > 0) {
          return true;
        }
      }
    }
    return false;
  }

  private getSearchRoots(page: Page): Array<Page | Frame> {
    const frameRoots = page
      .frames()
      .filter((frame) => frame !== page.mainFrame());
    return [page, ...frameRoots];
  }

  private async isLoggedOut(page: Page): Promise<boolean> {
    const rawUrl = page.url();
    const url = rawUrl.toLowerCase();

    if (url.includes("/login") || url.includes("/u/login")) {
      return true;
    }

    try {
      const host = new URL(rawUrl).hostname.toLowerCase();
      if (host === "auth.prolific.com") {
        return true;
      }
    } catch {
      // Ignore malformed transient URLs and continue with DOM heuristics.
    }

    for (const selector of LOGIN_STATE_SELECTORS) {
      const count = await page.locator(selector).count();
      if (count > 0) {
        return true;
      }
    }

    return false;
  }

  private async isBlockedByCaptcha(page: Page): Promise<boolean> {
    const url = page.url().toLowerCase();
    if (url.includes("captcha") || url.includes("challenge") || url.includes("cloudflare") || url.includes("__cf_chl")) {
      return true;
    }

    const title = (await page.title().catch(() => "")).toLowerCase();
    if (BLOCK_TITLE_PATTERN.test(title)) {
      return true;
    }

    const bodyText = await this.getBodyText(page);
    if (BLOCK_TEXT_PATTERN.test(bodyText)) {
      return true;
    }

    const htmlSnippet = (await page.content().catch(() => "")).slice(0, 8_000).toLowerCase();
    return BLOCK_TEXT_PATTERN.test(htmlSnippet);
  }

  private async hasInvalidCredentialsMessage(page: Page): Promise<boolean> {
    const bodyText = await this.getBodyText(page);
    return INVALID_CREDENTIALS_PATTERN.test(bodyText);
  }

  private async getBodyText(page: Page): Promise<string> {
    try {
      const body = page.locator("body").first();
      if ((await body.count()) === 0) {
        return "";
      }
      return (await body.innerText({ timeout: 2_000 })).slice(0, 12_000).toLowerCase();
    } catch {
      return "";
    }
  }

  private async getPageSummary(page: Page): Promise<string> {
    const title = (await page.title().catch(() => "")).trim();
    const body = await this.getBodyText(page);
    const bodyPreview = body.replace(/\s+/g, " ").slice(0, 220);
    return `title=${title || "n/a"}; bodyPreview=${bodyPreview || "n/a"}`;
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
