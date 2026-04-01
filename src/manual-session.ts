import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { gzipSync } from "node:zlib";
import dotenv from "dotenv";
import { chromium } from "playwright";

dotenv.config({ quiet: true });

const sessionPath = path.resolve(process.env.SESSION_STATE_PATH ?? "./data/prolific-session.json");
const loginUrl = process.env.PROLIFIC_LOGIN_URL ?? "https://app.prolific.com/login";
const studiesUrl = process.env.PROLIFIC_STUDIES_URL ?? "https://app.prolific.com/studies";

async function run(): Promise<void> {
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log("Manual session bootstrap for Prolific");
  console.log(`1) Browser opened at: ${loginUrl}`);
  console.log("2) Complete login manually (including captcha/challenge) in the browser window.");
  console.log("3) After reaching studies/dashboard, return to this terminal and press Enter.");

  await page.goto(loginUrl, { waitUntil: "domcontentloaded" });

  const rl = createInterface({ input, output });
  await rl.question("Press Enter after login is complete...");
  rl.close();

  await page.goto(studiesUrl, { waitUntil: "domcontentloaded" });
  const finalUrl = page.url().toLowerCase();
  if (finalUrl.includes("/login") || finalUrl.includes("auth.prolific.com")) {
    await browser.close();
    throw new Error(`Still unauthenticated after manual step. Current URL: ${page.url()}`);
  }

  await context.storageState({ path: sessionPath });
  await browser.close();

  const sessionJson = fs.readFileSync(sessionPath, "utf8");
  const sessionBase64 = Buffer.from(sessionJson, "utf8").toString("base64");
  const sessionGzipBase64 = gzipSync(Buffer.from(sessionJson, "utf8")).toString("base64");

  console.log("Session file saved:", sessionPath);
  console.log(`SESSION_STATE_BASE64 length: ${sessionBase64.length}`);
  console.log(`SESSION_STATE_GZIP_BASE64 length: ${sessionGzipBase64.length}`);
  console.log("Use this value in Railway variable SESSION_STATE_GZIP_BASE64:");
  console.log(sessionGzipBase64);
}

run().catch((error) => {
  console.error("Manual session bootstrap failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
