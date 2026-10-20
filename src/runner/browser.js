import fs from "node:fs";

const CANDIDATES = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/local/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
    "/snap/bin/chromium",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
};

/**
 * Find a browser for the run screenshot.
 * CHROME_PATH wins. Otherwise look for Chrome, Chromium, or Edge on this OS.
 * If none of those exist, ask Playwright to use its Chrome channel.
 */
export function detectBrowser({
  env = process.env,
  platform = process.platform,
  exists = fs.existsSync,
} = {}) {
  const override = env.CHROME_PATH;
  if (override) {
    if (!exists(override)) {
      throw new Error(`CHROME_PATH does not exist: ${override}`);
    }
    return { executablePath: override, source: "CHROME_PATH" };
  }
  const candidates = CANDIDATES[platform] || CANDIDATES.linux;
  for (const executablePath of candidates) {
    if (exists(executablePath)) return { executablePath, source: platform };
  }
  return { channel: "chrome", source: "playwright-channel" };
}

export { CANDIDATES };
