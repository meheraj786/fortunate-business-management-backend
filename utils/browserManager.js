const puppeteer = require("puppeteer");
const logger = require("./logger"); // Assuming a logger utility exists

let browserInstance;

/**
 * Initializes and returns a singleton Puppeteer browser instance.
 * If an instance already exists, it returns the existing one.
 */
async function getBrowser() {
  if (!browserInstance || !browserInstance.isConnected()) {
    logger.info("Initializing new Puppeteer browser instance...");
    try {
      browserInstance = await puppeteer.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage", // Recommended for Docker, harmless elsewhere

          // Memory optimizations for VPS
          "--disable-gpu",
          "--disable-software-rasterizer",
          "--disable-extensions",
          "--disable-background-networking",
          "--disable-default-apps",
          "--disable-sync",
          "--disable-translate",
          "--hide-scrollbars",
          "--mute-audio",
          "--no-first-run",
          "--no-default-browser-check",
          "--no-default-browser-check",
          "--no-zygote",
        ],
      });

      browserInstance.on("disconnected", () => {
        logger.warn("Puppeteer browser instance disconnected.");
        browserInstance = null;
      });
    } catch (error) {
      logger.error("Failed to launch Puppeteer browser:", error);
      // Do not rethrow, just return null so the app can start without PDF generation
      return null;
    }
  }
  return browserInstance;
}

/**
 * Gracefully closes the browser instance. Intended to be called on application shutdown.
 */
async function closeBrowser() {
  if (browserInstance) {
    const browserToClose = browserInstance;
    browserInstance = null; // Clear synchronously to prevent double-closing
    logger.info("Closing Puppeteer browser instance...");
    try {
      await browserToClose.close();
    } catch (error) {
      logger.error("Error closing Puppeteer browser instance:", error);
    }
  }
}

// Ensure graceful shutdown
process.on("exit", closeBrowser);
process.on("SIGINT", closeBrowser);
process.on("SIGTERM", closeBrowser);
process.on("uncaughtException", async (error) => {
  logger.error("Uncaught exception:", error);
  await closeBrowser();
  process.exit(1);
});

module.exports = {
  getBrowser,
  closeBrowser,
};
