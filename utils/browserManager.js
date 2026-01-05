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
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage', // Recommended for Docker, harmless elsewhere
                ],
            });

            browserInstance.on('disconnected', () => {
                logger.warn('Puppeteer browser instance disconnected.');
                browserInstance = null;
            });

        } catch (error) {
            logger.error("Failed to launch Puppeteer browser:", error);
            throw error; // Rethrow to indicate failure
        }
    }
    return browserInstance;
}

/**
 * Gracefully closes the browser instance. Intended to be called on application shutdown.
 */
async function closeBrowser() {
    if (browserInstance) {
        logger.info("Closing Puppeteer browser instance...");
        await browserInstance.close();
        browserInstance = null;
    }
}

// Ensure graceful shutdown
process.on('exit', closeBrowser);
process.on('SIGINT', closeBrowser);
process.on('SIGTERM', closeBrowser);
process.on('uncaughtException', async (error) => {
    logger.error('Uncaught exception:', error);
    await closeBrowser();
    process.exit(1);
});

module.exports = {
    getBrowser,
    closeBrowser,
};
