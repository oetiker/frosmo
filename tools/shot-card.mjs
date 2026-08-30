import { chromium } from "playwright";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.error("page error:", e.message));
await page.goto(process.argv[2], { waitUntil: "networkidle" });
// The app sends an uncalibrated rig straight to the calibrate screen, so ask
// for the card once it is up rather than in the URL it was loaded with.
await page.evaluate(() => { location.hash = "#home"; location.hash = "#card"; });
await page.waitForSelector("svg.cal-card");
await page.evaluate(() => document.fonts.ready);
await page.locator("svg.cal-card").screenshot({ path: process.argv[3] });
await browser.close();
