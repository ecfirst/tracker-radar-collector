const BaseCollector = require('./BaseCollector');

class ScreenshotCollector extends BaseCollector {

    id() {
        return 'screenshots';
    }

    /**
     * @param {{cdpClient: import('puppeteer').CDPSession, url: string, type: import('./TargetCollector').TargetType}} targetInfo 
     */
    addTarget({cdpClient, type, page}) {
        if (type === 'page') {
            this._cdpClient = cdpClient;
            this._page = page; // Store the Puppeteer page instance
        }
    }

    /**
     * @returns {Promise<string>}
     */
    async getData() {
        // Ensure the page object is available
        if (!this._page) {
            throw new Error("Page instance not available.");
        }

        // Capture full-page screenshot as PNG
        const screenshotBuffer = await this._page.screenshot({ fullPage: true, type: 'png' });

        // Convert buffer to base64
        return screenshotBuffer.toString('base64');
    }
}

module.exports = ScreenshotCollector;
