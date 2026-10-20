import assert from "node:assert/strict";
import test from "node:test";
import { detectBrowser } from "../src/runner/browser.js";

const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test("detects Chrome on macOS and honors CHROME_PATH", () => {
  const mac = detectBrowser({
    platform: "darwin",
    env: {},
    exists: (file) => file === MAC_CHROME,
  });
  assert.equal(mac.executablePath, MAC_CHROME);
  assert.equal(mac.source, "darwin");

  const linux = detectBrowser({
    platform: "linux",
    env: {},
    exists: (file) => file === "/usr/bin/google-chrome",
  });
  assert.equal(linux.executablePath, "/usr/bin/google-chrome");

  const override = detectBrowser({
    platform: "darwin",
    env: { CHROME_PATH: "/opt/chrome" },
    exists: (file) => file === "/opt/chrome",
  });
  assert.equal(override.executablePath, "/opt/chrome");
  assert.equal(override.source, "CHROME_PATH");

  assert.throws(
    () => detectBrowser({ platform: "linux", env: { CHROME_PATH: "/missing/chrome" }, exists: () => false }),
    /CHROME_PATH does not exist/,
  );

  const channel = detectBrowser({ platform: "linux", env: {}, exists: () => false });
  assert.equal(channel.channel, "chrome");
  assert.equal(channel.source, "playwright-channel");
});

test("detects Chrome from a faked darwin filesystem", () => {
  const files = new Set([
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ]);
  const exists = (file) => files.has(file);

  const chromium = detectBrowser({ platform: "darwin", env: {}, exists });
  assert.equal(chromium.executablePath, "/Applications/Chromium.app/Contents/MacOS/Chromium");
  assert.equal(chromium.source, "darwin");

  files.add(MAC_CHROME);
  const chrome = detectBrowser({ platform: "darwin", env: {}, exists });
  assert.equal(chrome.executablePath, MAC_CHROME);
  assert.equal(chrome.source, "darwin");

  const missing = detectBrowser({ platform: "darwin", env: {}, exists: () => false });
  assert.equal(missing.executablePath, undefined);
  assert.equal(missing.channel, "chrome");
  assert.equal(missing.source, "playwright-channel");
});
