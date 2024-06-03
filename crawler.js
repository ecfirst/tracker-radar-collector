const puppeteer = require('puppeteer');
const chalk = require('chalk').default;
const { createTimer } = require('./helpers/timer');
const wait = require('./helpers/wait');
const tldts = require('tldts');
const ScreenshotCollector = require('./collectors/ScreenshotCollector');

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.6312.58 Safari/537.36';
const MOBILE_USER_AGENT = 'Mozilla/5.0 (Linux; Android 10; Pixel 2 XL) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.6312.58 Mobile Safari/537.36';

const DEFAULT_VIEWPORT = {
    width: 1440,//px
    height: 812//px
};
const MOBILE_VIEWPORT = {
    width: 412,
    height: 691,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true
};

const VISUAL_DEBUG = false;

function openBrowser(log, proxyHost, executablePath) {
    const args = {
        args: [
            '--enable-blink-features=InterestCohortAPI',
            '--enable-features="FederatedLearningOfCohorts:update_interval/10s/minimum_history_domain_size_required/1,FlocIdSortingLshBasedComputation,InterestCohortFeaturePolicy"',
            '--js-flags="--async-stack-traces --stack-trace-limit 32"'
        ]
    };
    if (VISUAL_DEBUG) {
        args.headless = false;
        args.devtools = true;
    }
    if (proxyHost) {
        let url;
        try {
            url = new URL(proxyHost);
        } catch (e) {
            log('Invalid proxy URL');
        }

        args.args.push(`--proxy-server=${proxyHost}`);
        args.args.push(`--host-resolver-rules="MAP * ~NOTFOUND , EXCLUDE ${url.hostname}"`);
    }
    if (executablePath) {
        args.executablePath = executablePath;
    }

    return puppeteer.launch(args);
}

async function getSiteData(context, url, {
    collectors,
    log,
    urlFilter,
    emulateUserAgent,
    emulateMobile,
    runInEveryFrame,
    maxLoadTimeMs,
    extraExecutionTimeMs,
    collectorFlags,
}) {
    const testStarted = Date.now();
    const targets = [];

    const collectorOptions = {
        context,
        url,
        log,
        collectorFlags
    };

    for (let collector of collectors) {
        const timer = createTimer();

        try {
            await collector.init(collectorOptions);
            log(`${collector.id()} init took ${timer.getElapsedTime()}s`);
        } catch (e) {
            log(chalk.yellow(`${collector.id()} init failed`), chalk.gray(e.message), chalk.gray(e.stack));
        }
    }

    let pageTargetCreated = false;

    context.on('targetcreated', async target => {
        if (target.type() === 'page' && !pageTargetCreated) {
            pageTargetCreated = true;
            return;
        }

        const timer = createTimer();
        let cdpClient = null;

        try {
            cdpClient = await target.createCDPSession();
        } catch (e) {
            log(chalk.yellow(`Failed to connect to "${target.url()}"`), chalk.gray(e.message), chalk.gray(e.stack));
            return;
        }

        const simpleTarget = { url: target.url(), type: target.type(), cdpClient };
        targets.push(simpleTarget);

        try {
            await cdpClient.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true });
        } catch (e) {
            log(chalk.yellow(`Failed to set "${target.url()}" up.`), chalk.gray(e.message), chalk.gray(e.stack));
            return;
        }

        for (let collector of collectors) {
            try {
                if (collector instanceof ScreenshotCollector) {
                    const mpage = await context.newPage();
                    await collector.addTarget({ ...simpleTarget, page: mpage });
                } else {
                    await collector.addTarget(simpleTarget);
                }
            } catch (e) {
                log(chalk.yellow(`${collector.id()} failed to attach to "${target.url()}"`), chalk.gray(e.message), chalk.gray(e.stack));
            }
        }

        try {
            await cdpClient.send('Runtime.enable');
            await cdpClient.send('Runtime.runIfWaitingForDebugger');
        } catch (e) {
            log(chalk.yellow(`Failed to resume target "${target.url()}"`), chalk.gray(e.message), chalk.gray(e.stack));
            return;
        }

        log(`${target.url()} (${target.type()}) context initiated in ${timer.getElapsedTime()}s`);
    });

    const page = await context.newPage();

    if (runInEveryFrame) {
        page.evaluateOnNewDocument(runInEveryFrame);
    }

    const cdpClient = await page.target().createCDPSession();
    await cdpClient.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true });

    const initPageTimer = createTimer();
    for (let collector of collectors) {
        try {
            if (collector instanceof ScreenshotCollector) {
                await collector.addTarget({ url: url.toString(), type: 'page', page: page, cdpClient });
            } else {
                await collector.addTarget({ url: url.toString(), type: 'page', cdpClient });
            }
        } catch (e) {
            log(chalk.yellow(`${collector.id()} failed to attach to page`), chalk.gray(e.message), chalk.gray(e.stack));
        }
    }
    log(`page context initiated in ${initPageTimer.getElapsedTime()}s`);

    if (emulateUserAgent) {
        await page.setUserAgent(emulateMobile ? MOBILE_USER_AGENT : DEFAULT_USER_AGENT);
    }

    await page.setViewport(emulateMobile ? MOBILE_VIEWPORT : DEFAULT_VIEWPORT);

    page.on('dialog', dialog => dialog.dismiss());
    page.on('error', e => log(chalk.red(e.message)));

    let timeout = false;

    try {
        await page.goto(url.toString(), { timeout: maxLoadTimeMs, waitUntil: 'networkidle0' });
    } catch (e) {
        if (e instanceof puppeteer.errors.TimeoutError || (e.name && e.name === 'TimeoutError')) {
            log(chalk.yellow('Navigation timeout exceeded.'));

            for (let target of targets) {
                if (target.type === 'page') {
                    await target.cdpClient.send('Page.stopLoading');
                }
            }
            timeout = true;
        } else {
            throw e;
        }
    }

    for (let collector of collectors) {
        const postLoadTimer = createTimer();
        try {
            await collector.postLoad();
            log(`${collector.id()} postLoad took ${postLoadTimer.getElapsedTime()}s`);
        } catch (e) {
            log(chalk.yellow(`${collector.id()} postLoad failed`), chalk.gray(e.message), chalk.gray(e.stack));
        }
    }

    await page.waitForTimeout(extraExecutionTimeMs);

    const finalUrl = page.url();
    const data = {};

    for (let collector of collectors) {
        const getDataTimer = createTimer();
        try {
            const collectorData = await collector.getData({
                finalUrl,
                urlFilter: urlFilter && urlFilter.bind(null, finalUrl)
            });
            data[collector.id()] = collectorData;
            log(`getting ${collector.id()} data took ${getDataTimer.getElapsedTime()}s`);
        } catch (e) {
            log(chalk.yellow(`getting ${collector.id()} data failed`), chalk.gray(e.message), chalk.gray(e.stack));
            data[collector.id()] = null;
        }
    }

    for (let target of targets) {
        try {
            await target.cdpClient.detach();
        } catch (e) {
            // we don't care that much because in most cases an error here means that target already detached
        }
    }

    if (!VISUAL_DEBUG) {
        await page.close();
    }

    return {
        initialUrl: url.toString(),
        finalUrl,
        timeout,
        testStarted,
        testFinished: Date.now(),
        data
    };
}

function isThirdPartyRequest(documentUrl, requestUrl) {
    const mainPageDomain = tldts.getDomain(documentUrl);

    return tldts.getDomain(requestUrl) !== mainPageDomain;
}

module.exports = async (url, options) => {
    const log = options.log || (() => {});
    const browser = options.browserContext ? null : await openBrowser(log, options.proxyHost, options.executablePath);
    const context = options.browserContext || await browser.createIncognitoBrowserContext();

    let data = null;

    const maxLoadTimeMs = options.maxLoadTimeMs || 30000;
    const extraExecutionTimeMs = options.extraExecutionTimeMs || 2500;
    const maxTotalTimeMs = maxLoadTimeMs * 2;

    try {
        data = await wait(getSiteData(context, url, {
            collectors: options.collectors || [],
            log,
            urlFilter: options.filterOutFirstParty === true ? isThirdPartyRequest.bind(null) : null,
            emulateUserAgent: options.emulateUserAgent !== false,
            emulateMobile: options.emulateMobile,
            runInEveryFrame: options.runInEveryFrame,
            maxLoadTimeMs,
            extraExecutionTimeMs,
            collectorFlags: options.collectorFlags
        }), maxTotalTimeMs);
    } catch(e) {
        log(chalk.red('Crawl failed'), e.message, chalk.gray(e.stack));
        throw e;
    } finally {
        if (browser && !VISUAL_DEBUG) {
            await browser.close();
        }
    }

    return data;
};

/**
 * @typedef {Object} CollectResult
 * @property {string} initialUrl URL from which the crawler began the crawl (as provided by the caller)
 * @property {string} finalUrl URL after page has loaded (can be different from initialUrl if e.g. there was a redirect)
 * @property {boolean} timeout true if page didn't fully load before the timeout and loading had to be stopped by the crawler
 * @property {number} testStarted time when the crawl started (unix timestamp)
 * @property {number} testFinished time when the crawl finished (unix timestamp)
 * @property {import('./helpers/collectorsList').CollectorData} data object containing output from all collectors
*/
