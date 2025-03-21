const BaseCollector = require('./BaseCollector');

class ScreenshotCollector extends BaseCollector {

    id() {
        return 'screenshots';
    }

    /**
     * @param {{cdpClient: import('puppeteer').CDPSession, type: import('./TargetCollector').TargetType, page?: import('puppeteer').Page}} targetInfo 
     */
    addTarget({cdpClient, type, page}) {
        if (type === 'page') {
            this._cdpClient = cdpClient;
            if (page) {
                this._page = page; // Store the Puppeteer page instance if provided
            }
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
        const screenshotBuffer = await this._page.screenshot({fullPage: true, type: 'png'});

        // Convert buffer to base64
        return screenshotBuffer.toString('base64');
    }
}

module.exports = ScreenshotCollector;