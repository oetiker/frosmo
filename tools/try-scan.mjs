/**
 * Drive the calibrate screen against a fake camera showing the card.
 *
 *   node tools/try-scan.mjs <url> <clip.y4m>
 */
import { chromium } from "playwright";
const [, , url, clip] = process.argv;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-video-capture=${clip}`,
  ],
});
const ctx = await browser.newContext({ permissions: ["camera"], viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message, "\n", e.stack));
page.on("console", (m) => { if (m.type() !== "debug") console.log("CONSOLE:", m.type(), m.text()); });
await page.goto(url, { waitUntil: "networkidle" });
await page.evaluate(() => { location.hash = "#home"; location.hash = "#calibrate"; });
await page.waitForSelector(".cal-status");
await page.waitForTimeout(3500);
console.log("status before:", await page.locator(".cal-status").textContent());
console.log("video size:", await page.evaluate(() => {
  const v = document.querySelector("video");
  return v ? `${v.videoWidth}x${v.videoHeight} ready=${v.readyState}` : "no video";
}));
const t0 = Date.now();
await page.getByRole("button", { name: "Scan card" }).click();
  await page.waitForTimeout(200);
  console.log("scan note during:", await page.locator(".cal-scan-note").textContent());
await page.waitForTimeout(6000);
console.log("clicked, waited", Date.now() - t0, "ms");
console.log("status after :", await page.locator(".cal-status").textContent());
console.log("card note    :", await page.locator(".cal-card-note").textContent());
console.log("scan note    :", await page.locator(".cal-scan-note").textContent());
await page.screenshot({ path: process.env.SHOT ?? "/tmp/scan.png" });
await browser.close();
