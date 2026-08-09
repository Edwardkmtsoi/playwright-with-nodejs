import { Page } from 'playwright';
import logger from '../config/logger';
import { browserService } from './browser.service';
import env from '../config/env';
import { Product, ScrapeSite } from '../types/scrape.types';

export interface CustomScrapeOptions {
  url: string;
  selectors?: Record<string, string>;
  timeout?: number;
}

export interface CustomScrapeResult {
  url: string;
  title: string;
  text: string;
  fields: Record<string, string | null>;
}

export class ScraperService {
  async scrapeTestSites(): Promise<ScrapeSite[]> {
    let page: Page | null = null;

    try {
      await browserService.initialize();
      page = await browserService.createPage();

      logger.info(`Scraping ${env.SCRAPER_BASE_URL}`);
      await page.goto(env.SCRAPER_BASE_URL, { waitUntil: 'networkidle' });

      const sites = await page.evaluate(() => {
        const items: ScrapeSite[] = [];

        const siteLinks = document.querySelectorAll('a[href*="/test-sites/"]');

        siteLinks.forEach((link) => {
          const href = link.getAttribute('href');
          const text = link.textContent?.trim();

          if (
            href &&
            text &&
            !text.includes('test-sites') &&
            !items.some((s) => s.url === href)
          ) {
            items.push({
              title: text,
              url: href,
              description: link.getAttribute('title') || undefined,
            });
          }
        });

        return items.slice(0, 10);
      });

      logger.info(`Found ${sites.length} test sites`);
      return sites;
    } catch (error) {
      logger.error('Error scraping test sites:', error);
      throw error;
    } finally {
      if (page) {
        await browserService.closePage(page);
      }
    }
  }

  async scrapeEcommerceProducts(limit: number = 10): Promise<Product[]> {
    let page: Page | null = null;

    try {
      await browserService.initialize();
      page = await browserService.createPage();

      logger.info(
        `Scraping e-commerce products from ${env.SCRAPER_ECOMMERCE_URL}`,
      );

      await page.goto(env.SCRAPER_ECOMMERCE_URL, {
        waitUntil: 'networkidle',
      });

      await page.waitForTimeout(1000);

      const products = await page.evaluate((max: number) => {
        const items: Product[] = [];

        const productSelectors = [
          '.product',
          '[class*="product"]',
          '.item',
          '[class*="item"]',
          'article',
          '.card',
        ];

        let products = document.querySelectorAll(productSelectors[0]);

        if (products.length === 0) {
          for (const selector of productSelectors) {
            products = document.querySelectorAll(selector);

            if (products.length > 0) {
              break;
            }
          }
        }

        products.forEach((product) => {
          if (items.length >= max) return;

          const titleEl =
            product.querySelector('[class*="title"]') ||
            product.querySelector('h2') ||
            product.querySelector('h3') ||
            product.querySelector('h1');

          const priceEl =
            product.querySelector('[class*="price"]') ||
            product.querySelector('[class*="cost"]');

          const descEl = product.querySelector('[class*="desc"]');

          const title = titleEl?.textContent?.trim();

          if (title) {
            items.push({
              title,
              price: priceEl?.textContent?.trim(),
              description: descEl?.textContent?.trim(),
              rating: undefined,
              url: undefined,
            });
          }
        });

        return items;
      }, limit);

      logger.info(`Found ${products.length} products`);
      return products;
    } catch (error) {
      logger.error('Error scraping e-commerce products:', error);
      throw error;
    } finally {
      if (page) {
        await browserService.closePage(page);
      }
    }
  }

  /**
   * Scrape an arbitrary URL using Playwright.
   *
   * The page title and visible text are always returned.
   *
   * Optional CSS selectors can be supplied to extract specific fields.
   *
   * Example:
   *
   * selectors: {
   *   title: 'h1',
   *   price: '.price',
   *   availability: '.availability'
   * }
   */
  async scrapeCustom(
    options: CustomScrapeOptions,
  ): Promise<CustomScrapeResult> {
    let page: Page | null = null;

    const timeout = options.timeout || 60000;

    try {
      await browserService.initialize();
      page = await browserService.createPage();

      page.setDefaultTimeout(timeout);
      page.setDefaultNavigationTimeout(timeout);

      logger.info(`Custom scraping URL: ${options.url}`);

      await page.goto(options.url, {
        waitUntil: 'domcontentloaded',
        timeout,
      });

      // Give JavaScript-heavy pages a short opportunity to finish rendering.
      await page.waitForTimeout(1500);

      const result = await page.evaluate(
        ({ selectors }) => {
          const fields: Record<string, string | null> = {};

          if (selectors) {
            for (const [name, selector] of Object.entries(selectors)) {
              try {
                const element = document.querySelector(selector);

                fields[name] = element?.textContent?.trim() || null;
              } catch {
                fields[name] = null;
              }
            }
          }

          return {
            url: window.location.href,
            title: document.title,
            text: document.body?.innerText?.trim() || '',
            fields,
          };
        },
        {
          selectors: options.selectors || {},
        },
      );

      logger.info(
        `Custom scrape completed: ${options.url} (${result.text.length} characters)`,
      );

      return result;
    } catch (error) {
      logger.error(`Error scraping custom URL ${options.url}:`, error);
      throw error;
    } finally {
      if (page) {
        await browserService.closePage(page);
      }
    }
  }

  async runScrape(
    target: 'test-sites' | 'ecommerce',
    limit?: number,
  ) {
    const startTime = Date.now();

    try {
      let data: any;

      if (target === 'test-sites') {
        data = await this.scrapeTestSites();
      } else if (target === 'ecommerce') {
        data = await this.scrapeEcommerceProducts(limit || 10);
      } else {
        throw new Error(`Unknown scrape target: ${target}`);
      }

      return {
        success: true,
        data,
        meta: {
          count: Array.isArray(data) ? data.length : 0,
          durationMs: Date.now() - startTime,
          targetUrl:
            target === 'test-sites'
              ? env.SCRAPER_BASE_URL
              : env.SCRAPER_ECOMMERCE_URL,
        },
      };
    } catch (error) {
      logger.error(`Error running scrape for target ${target}:`, error);

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        meta: {
          durationMs: Date.now() - startTime,
        },
      };
    }
  }
}

export const scraperService = new ScraperService();
