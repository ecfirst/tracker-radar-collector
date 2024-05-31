const BaseCollector = require('./BaseCollector');

class ScreenshotCollector extends BaseCollector {

    id() {
        return 'screenshots';
    }

    /**
     * @param {{cdpClient: import('puppeteer').CDPSession, url: string, type: import('./TargetCollector').TargetType}} targetInfo 
     */
    addTarget({cdpClient, type}) {
        if (type === 'page') {
            this._cdpClient = cdpClient;
        }
    }

    /**
     * @returns {Promise<string>}
     */
    async getData() {
        await this._cdpClient.send('Page.enable');

        // Use the fullPage option to capture the entire content of the page
        const result = await this._cdpClient.send('Page.captureScreenshot', {
            format: 'png',
            clip: await this._getFullPageClip()
        });

        return result.data;
    }

    /**
     * @returns {Promise<Object>}
     */
    async _getFullPageClip() {
        const {contentSize} = await this._cdpClient.send('Page.getLayoutMetrics');
        return {
            x: 0,
            y: 0,
            width: contentSize.width,
            height: contentSize.height,
            scale: 1
        };
    }
}
module.exports = ScreenshotCollector;
