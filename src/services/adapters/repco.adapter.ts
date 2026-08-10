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
  availability: 'in_stock' | 'out_of_stock' | 'check_availability' | null;
  store: string;
  postalCode: string;
  scrapedAt: string;
}

export class RepcoAdapter {
  private readonly storeName = 'North Shore';
  private readonly postalCode = '0626';

  async scrapeProduct(url: string): Promise<RepcoProduct> {
    let page: Page | null = null;

    try {
      await browserService.initialize();
      page = await browserService.createPage();

      logger.info(
        `Scraping Repco product: ${url} using store ${this.storeName} (${this.postalCode})`
      );

      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });

      // Allow Repco's client-side content to finish rendering.
      await page.waitForTimeout(2000);

      /*
       * ---------------------------------------------------------
       * PRODUCT DATA
       * ---------------------------------------------------------
       */

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
            .match(/\$?\s*(\d+(?:\.\d{1,2})?)/);

          return match ? Number(match[1]) : null;
        };

        /*
         * ---------------------------------------------------------
         * NAME
         * ---------------------------------------------------------
         */

        const name =
          cleanText(
            document.querySelector('.pdp-product-title')?.textContent
          ) ||
          cleanText(document.querySelector('h1')?.textContent);

        /*
         * ---------------------------------------------------------
         * SKU
         * ---------------------------------------------------------
         */

        let sku: string | null = null;

        const skuElement = document.querySelector('.product-sku');

        if (skuElement) {
          const skuMatch = skuElement.textContent?.match(
            /SKU:\s*([A-Z0-9-]+)/i
          );

          if (skuMatch) {
            sku = skuMatch[1];
          }
        }

        /*
         * ---------------------------------------------------------
         * MAIN PRODUCT PRICE
         *
         * Example:
         *
         * <div class="price">
         *   <span class="price__dollars has-promo">
         *      $295
         *   </span>
         *   <span class="savings">$362</span>
         * </div>
         *
         * Therefore:
         *
         * price = 295
         * originalPrice = 362
         * ---------------------------------------------------------
         */

        const priceContainer = document.querySelector(
          '.price__container'
        );

        let price: number | null = null;
        let originalPrice: number | null = null;

        if (priceContainer) {
          const currentPriceElement = priceContainer.querySelector(
            '.price__dollars'
          );

          const savingsElement = priceContainer.querySelector(
            '.savings'
          );

          price = parsePrice(
            currentPriceElement?.textContent
          );

          originalPrice = parsePrice(
            savingsElement?.textContent
          );
        }

        /*
         * ---------------------------------------------------------
         * MEMBER PRICE
         *
         * We deliberately search the main product area rather than
         * the entire page, because the page contains many other
         * products with prices.
         *
         * Example:
         *
         * $300
         * $209
         * Member Price
         *
         * or similar promotional markup.
         * ---------------------------------------------------------
         */

        let memberPrice: number | null = null;

        const productDetails =
          document.querySelector('.product-details');

        const productDetailsText =
          productDetails?.textContent || '';

        const memberMatch = productDetailsText.match(
          /Member Price\s*\$?\s*(\d+(?:\.\d{1,2})?)/i
        );

        if (memberMatch) {
          memberPrice = Number(memberMatch[1]);
        }

        /*
         * Some Repco pages expose the member price separately from
         * the main price. Look for common member-price elements too.
         */

        if (memberPrice === null && productDetails) {
          const memberElements = Array.from(
            productDetails.querySelectorAll('*')
          ).filter((element) =>
            /member price/i.test(element.textContent || '')
          );

          for (const element of memberElements) {
            const parentText =
              element.parentElement?.textContent || '';

            const match = parentText.match(
              /Member Price\s*\$?\s*(\d+(?:\.\d{1,2})?)/i
            );

            if (match) {
              memberPrice = Number(match[1]);
              break;
            }
          }
        }

        /*
         * ---------------------------------------------------------
         * AVAILABILITY
         * ---------------------------------------------------------
         *
         * We specifically look at the product eligibility/store
         * section rather than searching the whole page.
         */

        let availability:
          | 'in_stock'
          | 'out_of_stock'
          | 'check_availability'
          | null = null;

        const eligibility = document.querySelector(
          '.product-eligibility'
        );

        const availabilityText =
          eligibility?.textContent ||
          productDetails?.textContent ||
          '';

        if (/out\s*of\s*stock/i.test(availabilityText)) {
          availability = 'out_of_stock';
        } else if (/in\s*stock/i.test(availabilityText)) {
          availability = 'in_stock';
        } else if (/check\s*availability/i.test(availabilityText)) {
          availability = 'check_availability';
        }

        /*
         * ---------------------------------------------------------
         * STORE
         * ---------------------------------------------------------
         */

        let store: string | null = null;

        const storeElement = document.querySelector(
          '.product-eligibility .store-name'
        );

        if (storeElement) {
          store = cleanText(storeElement.textContent);
        }

        return {
          name,
          sku,
          price,
          originalPrice,
          memberPrice,
          availability,
          store,
        };
      });

      /*
       * ---------------------------------------------------------
       * VERIFY STORE
       * ---------------------------------------------------------
       *
       * The page should ideally report North Shore.
       * We don't silently pretend another store is North Shore.
       */

      if (product.store && product.store !== this.storeName) {
        logger.warn(
          `Repco returned store "${product.store}" instead of "${this.storeName}"`
        );
      }

      return {
        site: 'repco',
        url: page.url(),
        name: product.name,
        sku: product.sku,
        price: product.price,
        originalPrice: product.originalPrice,
        memberPrice: product.memberPrice,
        currency: 'NZD',
        availability: product.availability,
        store: product.store || this.storeName,
        postalCode: this.postalCode,
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

