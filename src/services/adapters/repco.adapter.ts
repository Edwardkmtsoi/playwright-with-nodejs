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
        const cleanText = (
          value: string | null | undefined
        ): string | null => {
          return value?.replace(/\s+/g, ' ').trim() || null;
        };

        const parsePrice = (
          value: string | null | undefined
        ): number | null => {
          if (!value) return null;

          const match = value
            .replace(/,/g, '')
            .match(/\$\s*(\d+(?:\.\d{1,2})?)/);

          return match ? Number(match[1]) : null;
        };

        // =========================================================
        // PRODUCT NAME
        // =========================================================

        const name = cleanText(
          document.querySelector('h1')?.textContent
        );

        // =========================================================
        // SKU
        // =========================================================

        let sku: string | null = null;

        const bodyText = document.body.innerText;

        const skuMatch = bodyText.match(
          /SKU:\s*([A-Z0-9.-]+)/i
        );

        if (skuMatch) {
          sku = skuMatch[1];
        }

        // =========================================================
        // MAIN PRODUCT PRICE
        // =========================================================
        //
        // Repco uses:
        //
        // .price__container
        //     .price
        //         .price__dollars
        //
        // IMPORTANT:
        // Do NOT search the entire page for .price__dollars.
        // Related products also contain prices.
        //
        // First locate the main product area using the H1.
        // =========================================================

        let price: number | null = null;

        const heading = document.querySelector('h1');

        if (heading) {
          // Walk up the DOM looking for a container that contains
          // the product's main price.
          let current: Element | null = heading;

          for (let level = 0; level < 8 && current; level++) {
            const mainPriceElement =
              current.querySelector('.price__dollars');

            if (mainPriceElement) {
              const priceText = cleanText(
                mainPriceElement.textContent
              );

              const parsedPrice = parsePrice(priceText);

              if (parsedPrice !== null) {
                price = parsedPrice;
                break;
              }
            }

            current = current.parentElement;
          }
        }

        // =========================================================
        // FALLBACK PRICE METHOD
        // =========================================================
        //
        // If the DOM structure changes, use the SKU as an anchor.
        // Search only the text immediately following the SKU.
        // =========================================================

        if (price === null && sku) {
          const skuIndex = bodyText.indexOf(sku);

          if (skuIndex >= 0) {
            const nearbyText = bodyText.substring(
              skuIndex,
              skuIndex + 300
            );

            const priceMatch = nearbyText.match(
              /\$\s*(\d+(?:\.\d{1,2})?)/
            );

            if (priceMatch) {
              price = Number(priceMatch[1]);
            }
          }
        }

        // =========================================================
        // MEMBER PRICE
        // =========================================================

        let memberPrice: number | null = null;

        const memberMatch = bodyText.match(
          /Member Price\s*\$?\s*(\d+(?:\.\d{1,2})?)/i
        );

        if (memberMatch) {
          memberPrice = Number(memberMatch[1]);
        }

        // =========================================================
        // ORIGINAL PRICE
        // =========================================================
        //
        // Repco may show:
        //
        // $87.75
        // $117
        //
        // where $87.75 is the sale price and $117 is the
        // original price.
        //
        // We will add better handling once we inspect the
        // sale-price HTML.
        // =========================================================

        const originalPrice: number | null = null;

        // =========================================================
        // AVAILABILITY
        // =========================================================

        let availability: string | null = null;

        if (/check availability/i.test(bodyText)) {
          availability = 'check_availability';
        } else if (/in stock/i.test(bodyText)) {
          availability = 'in_stock';
        } else if (/out of stock/i.test(bodyText)) {
          availability = 'out_of_stock';
        }

        // =========================================================
        // DEBUG INFORMATION
        // =========================================================

        console.log('Repco scraper result:', {
          name,
          sku,
          price,
          memberPrice,
          availability,
        });

        return {
          name,
          sku,
          price,
          originalPrice,
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
      logger.error(
        `Repco scraping failed for ${url}:`,
        error
      );

      throw error;
    } finally {
      if (page) {
        await browserService.closePage(page);
      }
    }
  }
}

export const repcoAdapter = new RepcoAdapter();
