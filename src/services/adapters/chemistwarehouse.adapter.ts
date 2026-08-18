import { Page } from 'playwright';
import logger from '../../config/logger';
import { browserService } from '../browser.service';
import { ProductScraperAdapter } from './scraper-adapter.interface';
import { ChemistWarehouseScrapedProduct } from '../../types/product-scrape.types';

export class ChemistWarehouseAdapter
  implements ProductScraperAdapter
{
  readonly site = 'chemistwarehouse' as const;

  canHandle(url: string): boolean {
    const lowered = url.toLowerCase();

    return (
      lowered.includes('chemistwarehouse.co.nz') &&
      lowered.includes('/buy/')
    );
  }

  async scrapeProduct(
    url: string
  ): Promise<ChemistWarehouseScrapedProduct> {
    let page: Page | null = null;

    try {
      await browserService.initialize();
      page = await browserService.createPage();

      logger.info(`Scraping Chemist Warehouse product: ${url}`);

      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });

      /*
       * Chemist Warehouse has a mixture of server-rendered HTML and
       * client-side scripts. The supplied HTML already contains useful
       * product data, so we do not need to wait as aggressively as Repco.
       */
      try {
        await page.waitForLoadState('networkidle', {
          timeout: 5000,
        });
      } catch {
        logger.debug(
          `Chemist Warehouse networkidle timeout for ${url}; continuing`
        );
      }

      await page.waitForTimeout(1000);

      const product = await page.evaluate(() => {
        type ExtractedProduct = {
          name: string | null;
          sku: string | null;
          price: number | null;
          originalPrice: number | null;
          discount: number | null;
          availability:
            | 'in_stock'
            | 'out_of_stock'
            | 'check_availability'
            | 'unknown'
            | null;
          diagnostics: {
            nameSource: string | null;
            skuSource: string | null;
            priceSource: string | null;
            originalPriceSource: string | null;
            availabilitySource: string | null;
          };
        };

        const cleanText = (
          value: string | null | undefined
        ): string | null => {
          if (!value) return null;

          const cleaned = value
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

          return cleaned || null;
        };

        const parsePrice = (
          value: string | null | undefined
        ): number | null => {
          if (!value) return null;

          const text = value
            .replace(/\u00a0/g, ' ')
            .replace(/,/g, '')
            .trim();

          const match = text.match(
            /(?:NZD|NZ|\$)?\s*(\d+(?:\.\d{1,2})?)/
          );

          if (!match) return null;

          const parsed = Number(match[1]);

          return Number.isFinite(parsed) ? parsed : null;
        };

        const parseJsonSafe = <T = any>(
          value: string | null | undefined
        ): T | null => {
          if (!value) return null;

          try {
            return JSON.parse(value) as T;
          } catch {
            return null;
          }
        };

        const getText = (selector: string): string | null => {
          const element = document.querySelector(selector);

          return cleanText(element?.textContent);
        };

        const getAttribute = (
          selector: string,
          attribute: string
        ): string | null => {
          const element = document.querySelector(selector);

          return cleanText(element?.getAttribute(attribute));
        };

        const diagnostics = {
          nameSource: null as string | null,
          skuSource: null as string | null,
          priceSource: null as string | null,
          originalPriceSource: null as string | null,
          availabilitySource: null as string | null,
        };

        /*
         * ---------------------------------------------------------
         * ANALYTICS PRODUCT DATA
         * ---------------------------------------------------------
         *
         * The supplied Chemist Warehouse page includes:
         *
         * var analyticsProductData = '{"id":"107974","name":"Balance 100% Whey Vanilla 2kg","price":149.99,"discount":69.51}';
         *
         * This is a very useful source because it directly describes
         * the current PDP product, not a recommendation tile.
         */
        let analyticsProductData: {
          id?: string;
          name?: string;
          price?: number;
          discount?: number;
        } | null = null;

        const scripts = Array.from(
          document.querySelectorAll('script')
        );

        for (const script of scripts) {
          const text = script.textContent || '';

          const match = text.match(
            /var\s+analyticsProductData\s*=\s*'([^']+)';/
          );

          if (!match) continue;

          analyticsProductData = parseJsonSafe(match[1]);

          if (analyticsProductData) {
            break;
          }
        }

        /*
         * ---------------------------------------------------------
         * SKU / PRODUCT ID
         * ---------------------------------------------------------
         */

        let sku: string | null = null;

        if (analyticsProductData?.id) {
          sku = String(analyticsProductData.id).trim();
          diagnostics.skuSource = 'JS:analyticsProductData.id';
        }

        if (!sku) {
          for (const script of scripts) {
            const text = script.textContent || '';

            const match = text.match(
              /var\s+currentProductId\s*=\s*[^'"]+['"]/
            );

            if (match) {
              sku = match[1].trim();
              diagnostics.skuSource = 'JS:currentProductId';
              break;
            }
          }
        }

        if (!sku) {
          const pathMatch = window.location.pathname.match(
            /\/buy\/(\d+)\//
          );

          if (pathMatch) {
            sku = pathMatch[1];
            diagnostics.skuSource = 'URL:/buy/:id';
          }
        }

        /*
         * ---------------------------------------------------------
         * NAME
         * ---------------------------------------------------------
         */

        let name: string | null = null;

        if (analyticsProductData?.name) {
          name = cleanText(analyticsProductData.name);
          diagnostics.nameSource = 'JS:analyticsProductData.name';
        }

        if (!name) {
          const title = cleanText(document.title);

          if (title) {
            name = title
              .replace(/^Buy\s+/i, '')
              .replace(/\s+Online\s+at\s+Chemist\s+Warehouse.*$/i, '')
              .trim();

            diagnostics.nameSource = 'document.title';
          }
        }

        if (!name) {
          name =
            getText('h1') ||
            getText('[itemprop="name"]') ||
            getText('[class*="product"][class*="name" i]');

          if (name) {
            diagnostics.nameSource = 'DOM:name-selector';
          }
        }

        /*
         * ---------------------------------------------------------
         * PRICE
         * ---------------------------------------------------------
         */

        let price: number | null = null;

        if (
          typeof analyticsProductData?.price === 'number' &&
          Number.isFinite(analyticsProductData.price)
        ) {
          price = analyticsProductData.price;
          diagnostics.priceSource = 'JS:analyticsProductData.price';
        }

        if (price === null) {
          const priceSelectors = [
            '.product__price',
            '.Price [itemprop="price"]',
            '.Price',
            '[itemprop="price"]',
            '[class*="product__price" i]',
            '[class*="price" i]',
          ];

          for (const selector of priceSelectors) {
            const candidate = parsePrice(getText(selector));

            if (candidate !== null) {
              price = candidate;
              diagnostics.priceSource = `DOM:${selector}`;
              break;
            }
          }
        }

        /*
         * ---------------------------------------------------------
         * ORIGINAL PRICE
         * ---------------------------------------------------------
         *
         * Chemist Warehouse often renders this as:
         *
         * Why Pay $219.50?
         */
        let originalPrice: number | null = null;

        const retailPriceText =
          getText('.retailPrice') ||
          getText('[class*="retailPrice" i]');

        if (retailPriceText) {
          const candidate = parsePrice(retailPriceText);

          if (candidate !== null) {
            originalPrice = candidate;
            diagnostics.originalPriceSource = 'DOM:.retailPrice';
          }
        }

        if (originalPrice === null) {
          const bodyText = cleanText(document.body?.innerText) || '';

          const whyPayMatch = bodyText.match(
            /Why\s+Pay\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i
          );

          if (whyPayMatch) {
            const candidate = parsePrice(whyPayMatch[1]);

            if (candidate !== null) {
              originalPrice = candidate;
              diagnostics.originalPriceSource = 'TEXT:Why Pay';
            }
          }
        }

        if (
          originalPrice !== null &&
          price !== null &&
          originalPrice <= price
        ) {
          originalPrice = null;
        }

        /*
         * ---------------------------------------------------------
         * DISCOUNT
         * ---------------------------------------------------------
         */

        let discount: number | null = null;

        if (
          typeof analyticsProductData?.discount === 'number' &&
          Number.isFinite(analyticsProductData.discount)
        ) {
          discount = analyticsProductData.discount;
        } else if (
          originalPrice !== null &&
          price !== null &&
          originalPrice > price
        ) {
          discount = Number(
            (originalPrice - price).toFixed(2)
          );
        }

        /*
         * ---------------------------------------------------------
         * AVAILABILITY
         * ---------------------------------------------------------
         *
         * You said store availability is not needed.
         * This is only product-level availability.
         */
        let availability:
          | 'in_stock'
          | 'out_of_stock'
          | 'check_availability'
          | 'unknown'
          | null = 'unknown';

        const bodyText = cleanText(document.body?.innerText) || '';

        if (
          /\bout\s*of\s*stock\b/i.test(bodyText) ||
          /\bsold\s*out\b/i.test(bodyText) ||
          /\bunavailable\b/i.test(bodyText)
        ) {
          availability = 'out_of_stock';
          diagnostics.availabilitySource = 'TEXT:out-of-stock';
        } else if (
          /\badd\s*to\s*cart\b/i.test(bodyText) ||
          /\bin\s*stock\b/i.test(bodyText)
        ) {
          availability = 'in_stock';
          diagnostics.availabilitySource = 'TEXT:add-to-cart/in-stock';
        }

        /*
         * Canonical URL fallback is useful if Chemist Warehouse redirects.
         */
        const canonicalUrl =
          getAttribute('link[rel="canonical"]', 'href') ||
          window.location.href;

        return {
          name,
          sku,
          price,
          originalPrice,
          discount,
          availability,
          canonicalUrl,
          diagnostics,
        } satisfies ExtractedProduct & {
          canonicalUrl: string;
        };
      });

      logger.info(
        `Chemist Warehouse extraction result for ${url}: ${JSON.stringify({
          name: product.name,
          sku: product.sku,
          price: product.price,
          originalPrice: product.originalPrice,
          discount: product.discount,
          availability: product.availability,
          diagnostics: product.diagnostics,
        })}`
      );

      if (!product.name) {
        logger.warn(
          `Chemist Warehouse product name could not be extracted for ${url}`
        );
      }

      if (!product.sku) {
        logger.warn(
          `Chemist Warehouse SKU could not be extracted for ${url}`
        );
      }

      if (product.price === null) {
        logger.warn(
          `Chemist Warehouse price could not be extracted for ${url}`
        );
      }

      return {
        site: 'chemistwarehouse',
        url: product.canonicalUrl || page.url(),
        name: product.name,
        sku: product.sku,
        price: product.price,
        originalPrice: product.originalPrice,
        discount: product.discount,
        currency: 'NZD',
        availability: product.availability,
        scrapedAt: new Date().toISOString(),
      };
    } catch (error) {
      logger.error(
        `Chemist Warehouse scraping failed for ${url}:`,
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

export const chemistWarehouseAdapter =
  new ChemistWarehouseAdapter();
