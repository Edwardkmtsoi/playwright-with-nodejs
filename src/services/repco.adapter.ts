import { Page } from 'playwright';
import logger from '../../config/logger';
import { browserService } from '../browser.service';

export interface RepcoProduct {
  site: 'repco';
  url: string;
  name: string | null;
  sku: string | null;
  price: number | null;
  originalPrice: number | null;
  memberPrice: number | null;
  currency: 'NZD';
  availability: string | null;
  scrapedAt: string;
}

export class RepcoAdapter {
  async scrapeProduct(url: string): Promise<RepcoProduct> {
    let page: Page | null = null;

    try {
      await browserService.initialize();
      page = await browserService.createPage();

      logger.info(`Scraping Repco product: ${url}`);

      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });

      // Give the page a little time to finish rendering
      await page.waitForTimeout(2000);

      const product = await page.evaluate(() => {
        const cleanText = (value: string | null | undefined) =>
          value?.replace(/\s+/g, ' ').trim() || null;

        const parsePrice = (value: string | null | undefined): number | null => {
          if (!value) return null;

          const match = value.replace(/,/g, '').match(/\$?\s*(\d+(?:\.\d{1,2})?)/);

          return match ? Number(match[1]) : null;
        };

        // Product name
        const name =
          cleanText(
            document.querySelector('h1')?.textContent
          );

        // SKU
        let sku: string | null = null;

        const bodyText = document.body.innerText;

        const skuMatch = bodyText.match(/SKU:\s*([A-Z0-9-]+)/i);

        if (skuMatch) {
          sku = skuMatch[1];
        }

        // Find price elements
        const priceElements = Array.from(
          document.querySelectorAll('*')
        ).filter((element) => {
          const text = cleanText(element.textContent);

          if (!text) return false;

          return /^\$\s*\d+(?:\.\d{1,2})?$/.test(text);
        });

        const prices = priceElements
          .map((element) => parsePrice(element.textContent))
          .filter((price): price is number => price !== null);

        const uniquePrices = [...new Set(prices)];

        // Repco pages normally expose the current price prominently.
        const price = uniquePrices.length > 0
          ? uniquePrices[0]
          : null;

        // Look for member pricing
        let memberPrice: number | null = null;

        const memberMatch = bodyText.match(
          /Member Price\s*\$?\s*(\d+(?:\.\d{1,2})?)/i
        );

        if (memberMatch) {
          memberPrice = Number(memberMatch[1]);
        }

        // Availability
        let availability: string | null = null;

        if (/check availability/i.test(bodyText)) {
          availability = 'check_availability';
        } else if (/in stock/i.test(bodyText)) {
          availability = 'in_stock';
        } else if (/out of stock/i.test(bodyText)) {
          availability = 'out_of_stock';
        }

        return {
          name,
          sku,
          price,
          originalPrice: null,
          memberPrice,
          currency: 'NZD' as const,
          availability,
        };
      });

      return {
        site: 'repco',
        url: page.url(),
        ...product,
        scrapedAt: new Date().toISOString(),
      };
    } catch (error) {
      logger.error(`Repco scraping failed for ${url}:`, error);
      throw error;
    } finally {
      if (page) {
        await browserService.closePage(page);
      }
    }
  }
}

export const repcoAdapter = new RepcoAdapter();
