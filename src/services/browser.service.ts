import { chromium, Browser, Page, BrowserContext } from 'playwright';
import logger from '../config/logger';
import env from '../config/env';

export class BrowserService {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;

  async initialize(): Promise<void> {
    if (this.browser) return;

    logger.info('Initializing Playwright browser');

    this.browser = await chromium.launch({
      headless: env.PLAYWRIGHT_HEADLESS,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],
    });

    this.context = await this.browser.newContext({
      // Use a current Chrome-style user agent instead of the old Chrome 91 UA.
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',

      viewport: {
        width: 1366,
        height: 768,
      },

      locale: 'en-NZ',

      timezoneId: 'Pacific/Auckland',

      colorScheme: 'light',

      deviceScaleFactor: 1,

      javaScriptEnabled: true,

      acceptDownloads: false,

      extraHTTPHeaders: {
        'Accept-Language':
          'en-NZ,en;q=0.9,en-US;q=0.8',
      },
    });

    logger.info('Playwright browser context initialized');
  }

  async createPage(): Promise<Page> {
    if (!this.browser) {
      await this.initialize();
    }

    if (!this.context) {
      throw new Error('Browser context not initialized');
    }

    const page = await this.context.newPage();

    page.setDefaultTimeout(env.PLAYWRIGHT_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(env.PLAYWRIGHT_TIMEOUT_MS);

    return page;
  }

  async closePage(page: Page): Promise<void> {
    try {
      await page.close();
    } catch (error) {
      logger.warn('Error closing page:', error);
    }
  }

  async close(): Promise<void> {
    if (this.context) {
      try {
        await this.context.close();
      } catch (error) {
        logger.warn('Error closing context:', error);
      }

      this.context = null;
    }

    if (this.browser) {
      try {
        await this.browser.close();
      } catch (error) {
        logger.warn('Error closing browser:', error);
      }

      this.browser = null;
    }

    logger.info('Browser closed');
  }

  isInitialized(): boolean {
    return this.browser !== null;
  }
}

export const browserService = new BrowserService();
