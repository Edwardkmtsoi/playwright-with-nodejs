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

      // Allow dynamic content to finish rendering
      await page.waitForTimeout(2000);

      const product = await page.evaluate(() => {
        const cleanText = (value: string | null | undefined) =>
          value?.replace(/\s+/g, ' ').trim() || null;

        const parsePrice = (
          value: string | null | undefined
        ): number | null => {
          if (!value) return null;

          const match = value
            .replace(/,/g, '')
            .match(/\$\s*(\d+(?:\.\d{1,2})?)/);

          return match ? Number(match[1]) : null;
        };

        // ---------------------------------------------------------
        // Product name
        // ---------------------------------------------------------

        const name = cleanText(
          document.querySelector('h1')?.textContent
        );

        // ---------------------------------------------------------
        // SKU
        // ---------------------------------------------------------

        let sku: string | null = null;

        const bodyText = document.body.innerText;

        const skuMatch = bodyText.match(
          /SKU:\s*([A-Z0-9.-]+)/i
        );

        if (skuMatch) {
          sku = skuMatch[1];
        }

        // ---------------------------------------------------------
        // MAIN PRODUCT PRICE
        // ---------------------------------------------------------
        //
        // Do NOT search the entire page for the first $XX value.
        //
        // Instead, look for the price associated with the main
        // product section.
        // ---------------------------------------------------------

        let price: number | null = null;

        // First try common price selectors used by e-commerce sites.
        const mainPriceSelectors = [
          '[class*="product-price"]',
          '[class*="productPrice"]',
          '[class*="ProductPrice"]',
          '[class*="price-current"]',
          '[class*="current-price"]',
          '[class*="currentPrice"]',
          '[class*="sale-price"]',
          '[class*="salePrice"]',
          '[class*="price"]',
        ];

        for (const selector of mainPriceSelectors) {
          const elements = Array.from(
            document.querySelectorAll(selector)
          );

          for (const element of elements) {
            const text = cleanText(element.textContent);

            if (!text) continue;

            const parsed = parsePrice(text);

            if (parsed !== null) {
              price = parsed;
              break;
            }
          }

          if (price !== null) break;
        }

        // ---------------------------------------------------------
        // Fallback:
        //
        // Find the product name and inspect its nearby DOM.
        // This helps avoid prices from "Frequently Viewed Together"
        // and other recommended products.
        // ---------------------------------------------------------

        if (price === null) {
          const heading = document.querySelector('h1');

          if (heading) {
            let current: Element | null = heading;

            for (let i = 0; i < 5 && current; i++) {
              const text = cleanText(current.textContent);

              if (text) {
                const priceMatch = text.match(
                  /\$\s*(\d+(?:\.\d{1,2})?)/
                );

                if (priceMatch) {
                  price = Number(priceMatch[1]);
                  break;
                }
              }

              current = current.parentElement;
            }
          }
        }

        // ---------------------------------------------------------
        // Second fallback:
        //
        // Search the body text around the SKU/product name.
        // ---------------------------------------------------------

        if (price === null && sku) {
          const skuIndex = bodyText.indexOf(sku);

          if (skuIndex >= 0) {
            const nearbyText = bodyText.substring(
              skuIndex,
              skuIndex + 500
            );

            const priceMatch = nearbyText.match(
              /\$\s*(\d+(?:\.\d{1,2})?)/
            );

            if (priceMatch) {
              price = Number(priceMatch[1]);
            }
          }
        }

        // ---------------------------------------------------------
        // Member price
        // ---------------------------------------------------------

        let memberPrice: number | null = null;

        const memberMatch = bodyText.match(
          /Member Price\s*\$?\s*(\d+(?:\.\d{1,2})?)/i
        );

        if (memberMatch) {
          memberPrice = Number(memberMatch[1]);
        }

        // ---------------------------------------------------------
        // Availability
        // ---------------------------------------------------------

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
