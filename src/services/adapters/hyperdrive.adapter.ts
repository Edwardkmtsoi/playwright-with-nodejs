import { Page } from 'playwright';
import logger from '../../config/logger';
import { browserService } from '../browser.service';
import { ProductScraperAdapter } from './scraper-adapter.interface';
import { HyperdriveScrapedProduct } from '../../types/product-scrape.types';

type Availability =
  | 'in_stock'
  | 'out_of_stock'
  | 'check_availability'
  | 'unknown';

interface ExtractionDiagnostics {
  nameSource: string | null;
  skuSource: string | null;
  priceSource: string | null;
  originalPriceSource: string | null;
  availabilitySource: string | null;
  currencySource: string | null;
}

interface ExtractedProduct {
  name: string | null;
  sku: string | null;
  price: number | null;
  originalPrice: number | null;
  availability: Availability;
  currency: 'NZD';
  canonicalUrl: string;
  diagnostics: ExtractionDiagnostics;
}

export class HyperdriveAdapter implements ProductScraperAdapter {
  readonly site = 'hyperdrive' as const;

  private readonly navigationTimeout = 60000;

  /**
   * Determine whether this adapter supports the supplied URL.
   */
  canHandle(url: string*: boolean {
    try {
      const *arsedUrl = new URL(url);
      con*t hostname = parsedUrl.hostname.to*owerCase();

      return (
      * hostname === 'hyperdrive.co.nz' |*
        hostname.endsWith('.hyper*rive.co.nz')
      );
    } catch *
      return false;
    }
  }

  ***
   * Validate that the loaded p*ge appears to be a Hyperdrive
   **product page.
   */
  private asyn* validateProductPage(
    page: Pa*e,
    expectedProductUrl: string
* ): Promise<void> {
    const curr*ntUrl = page.url();

    const has*roductName = await page
      .loc*tor(
        [
          'h1.page-heading-underline [itemprop="name"]',
          'h1.list-heading [itemprop="name"]',
          'h1 [itemprop="name"]',
          'h1[itemprop="name"]',
        ].join(', ')
  *   )
      .first()
      .count()*      .then((count) => count > 0)
*     .catch(() => false);

    con*t hasProductPrice = await page
   *  .locator(
        [
          '[itemprop="offers"] [itemprop="price"]',
          '.price-area [itemprop="price"]',
          '.tyrePrice [itemprop="price"]',
          '[itemprop="price"]',
        ].join('* ')
      )
      .first()
      .*ount()
      .then((count) => coun* > 0)
      .catch(() => false);

*   const headingText = await page
*     .locator('h1')
      .first()*      .textContent({
        timeo*t: 5000,
      })
      .catch(() *> null);

    const cleanedHeading*=
      headingText?.replace(/\s+/*, ' ').trim() || null;

    if (
 *    !hasProductName &&
      !hasP*oductPrice &&
      !cleanedHeadin*
    ) {
      throw new Error(
  *     `Hyperdrive extraction aborte* because the loaded page ` +
     *    `does not appear to be a produ*t page. ` +
          `Current URL* ${currentUrl}; ` +
          `exp*cted URL: ${expectedProductUrl}`
 *    );
    }
  }

  /**
   * Extra*t the product information from the*rendered page.
   */
  private asy*c extractProduct(
    page: Page
 *): Promise<ExtractedProduct> {
   *return page.evaluate(() => {
     *type PageAvailability =
        | *in_stock'
        | 'out_of_stock'*        | 'check_availability'
   *    | 'unknown';

      interface *ageExtractionDiagnostics {
       *nameSource: string | null;
       *skuSource: string | null;
        *riceSource: string | null;
       *originalPriceSource: string | null*
        availabilitySource: strin* | null;
        currencySource: s*ring | null;
      }

      interf*ce PageExtractedProduct {
        *ame: string | null;
        sku: s*ring | null;
        price: number*| null;
        originalPrice: num*er | null;
        availability: P*geAvailability;
        currency: *NZD';
        canonicalUrl: string*
        diagnostics: PageExtracti*nDiagnostics;
      }

      const*cleanText = (
        value: strin* | null | undefined
      ): strin* | null => {
        if (!value) {*          return null;
        }

        const cleaned = value
          .replace(/\u00a0/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        return cleaned || null;
      };

      const parsePrice = (
        value: string | null | undefined
      ): number | null => {
        if (!value) {
          return null;
        }

        const cleaned = value
          .replace(/\u00a0/g, ' ')
          .replace(/,/g, '')
          .trim();

        const currencyMatch = cleaned.match(
          /(?:NZD|NZ\$|\$)\s*(\d+(?:\.\d{1,2})?)/
        );

        if (currencyMatch) {
          const parsed = Number(currencyMatch[1]);

          return Number.isFinite(parsed)
            ? parsed
            : null;
        }

        const numericMatch = cleaned.match(
          /^(\d+(?:\.\d{1,2})?)$/
        );

        if (!numericMatch) {
          return null;
        }

        const parsed = Number(numericMatch[1]);

        return Number.isFinite(parsed)
          ? parsed
          : null;
      };

      const getText = (
        selector: string
      ): string | null => {
        const element =
          document.querySelector(selector);

        return cleanText(element?.textContent);
      };

      const getAttribute = (
        selector: string,
        attribute: string
      ): string | null => {
        const element =
          document.querySelector(selector);

        return cleanText(
          element?.getAttribute(attribute)
        );
      };

      const getFirstText = (
        selectors: string[]
      ): {
        value: string | null;
        selector: string | null;
      } => {
        for (const selector of selectors) {
          const value = getText(selector);

          if (value) {
            return {
              value,
              selector,
            };
          }
        }

        return {
          value: null,
          selector: null,
        };
      };

      const getFirstAttribute = (
        selectors: string[],
        attribute: string
      ): {
        value: string | null;
        selector: string | null;
      } => {
        for (const selector of selectors) {
          const value = getAttribute(
            selector,
            attribute
          );

          if (value) {
            return {
              value,
              selector,
            };
          }
        }

        return {
          value: null,
          selector: null,
        };
      };

      const diagnostics: PageExtractionDiagnostics = {
        nameSource: null,
        skuSource: null,
        priceSource: null,
        originalPriceSource: null,
        availabilitySource: null,
        currencySource: null,
      };

      /*
       * ============================================================
       * PRODUCT NAME
       * ============================================================
       */

      let name: string |*null = null;

      const nameResu*t = getFirstText([
        'h1.page-heading-underline [itemprop="name"]',
        'h1.list-heading [itemprop="name"]',
        'h1 [itemprop="name"]',
        'h1[itemprop="name"]',
        'h1.page-heading-underline',
        'h1.list-heading',
        'h1',
      ]);

      if*(nameResult.value) {
        name * nameResult.value;
        diagnos*ics.nameSource =
          `DOM:${nameResult.selector}`;
      }

      if (!name) {
        const metadataName = getAttribute(
          'meta[itemprop="name"]',
          'content'
        );

        if (metadataName) {
          name = metadataName;
          diagnostics.nameSource =
            'META:itemprop=name';
        }
      }

      if (!name) {
        const documentTitle =
          cleanText(document.title);

        if (documentTitle) {
          name = documentTitle
            .replace(
              /\s*(?:\||-)\s*Hyper\s*Drive.*$/i,
              ''
            )
            .replace(
              /\s*(?:\||-)\s*Hyperdrive.*$/i,
              ''
            )
            .trim();

          diagnostics.nameSource =
            'DOCUMENT:title';
        }
      }

      /*
       * ============================================================
       * SKU
       * ============================================================
       */

      let sku: string | null = *ull;

      const skuMetadataResul* =
        getFirstAttribute(
    *     [
            'meta[itemprop="sku"]',
            'meta[itemprop="productID"]',
            '[itemprop="sku"][content]',
            '[itemprop="productID"][content]',
          ],
          'content'
        );

      if (skuMetadataResult.value) {
        sku = skuMetadataResult.value;
        diagnostics.skuSource =
          `META:${skuMetadataResult.selector}`;
      }

      if (!sku) {
        const skuContainers = Array.from(
          document.querySelectorAll(
            [
              'small.pull-right',
              'small',
              '[class*="sku" i]',
              '[class*="product-code" i]',
              '[class*="product-number" i]',
            ].join(', ')
          )
        );

        for (const container of skuContainers) {
          const containerText =
            cleanText(container.textContent);

          if (
            !containerText ||
            !/\bSKU\s*#/i.test(containerText)
          ) {
            continue;
          }

          const spanValue = cleanText(
            container.querySelector('span')
              ?.textContent
          );

          if (spanValue) {
            sku = spanValue;
            diagnostics.skuSource =
              'DOM:small.pull-right span';
            break;
          }

          const skuMatch = containerText.match(
            /\bSKU\s*#?\s*:?\s*([A-Z0-9._-]+)/i
          );

          if (skuMatch) {
            sku = skuMatch[1];
            diagnostics.skuSource =
              'TEXT:SKU';
            break;
          }
        }
      }

      /*
       * ============================================================
       * CURRENT PRICE
       * ============================================================
       */

      let price: number | nul* = null;

      const priceSelecto*s = [
        '[itemprop="offers"] [itemprop="price"]',
        '.price-area [itemprop="price"]',
        '.tyrePrice [itemprop="price"]',
        '.tyrePrice.clearance .price',
        '.tyrePrice .price',
        '[itemprop="price"]',
        '.price-area .price',
        '.price',
      ];

      for (const selector of priceSelectors) {
        const element =
          document.querySelector(selector);

        if (!element) {
          continue;
        }

        const content =
          element.getAttribute('content');

        const candidate = parsePrice(
          content || element.textContent
        );

        if (candidate !== null) {
          price = candidate;
          diagnostics.priceSource =
            `DOM:${selector}`;
          break;
        }
      }

      /*
       * ============================================================
       * ORIGINAL PRICE
       * ============================================================
       */

      let originalPrice: number*| null = null;

      const origin*lPriceSelectors = [
        '.usuallyPrice [itemprop="price"]',
        '.usuallyPrice .price',
        '.usuallyPrice',
        '.usualPrice',
        '.wasPrice',
        '.was-price',
        '.original-price',
        '[class*="usually-price" i]',
        '[class*="usual-price" i]',
        '[class*="was-price" i]',
        '[class*="original-price" i]',
        'del',
      ];

      for (
        const selector of originalPriceSelectors
      ) {
        const element =
          document.querySelector(selector);

        if (!element) {
          continue;
        }

        const content =
          element.getAttribute('content');

        const candidate = parsePrice(
          content || element.textContent
        );

        if (
          candidate !== null &&
          (price === null || candidate > price)
        ) {
          originalPrice = candidate;
          diagnostics.originalPriceSource =
            `DOM:${selector}`;
          break;
        }
      }

      if (originalPrice === null) {
        const priceAreaText =
          cleanText(
            document.querySelector(
              '.price-area'
            )?.textContent
          ) || '';

        const originalPriceMatch =
          priceAreaText.match(
            /\b(?:Usually|Was|RRP)\s*:?\s*(?:NZD|NZ\$|\$)?\s*([\d,]+(?:\.\d{1,2})?)/i
          );

        if (originalPriceMatch) {
          const candidate = parsePrice(
            originalPriceMatch[1]
          );

          if (
            candidate !== null &&
            (price === null || candidate > price)
          ) {
            originalPrice = candidate;
            diagnostics.originalPriceSource =
              'TEXT:Usually/Was/RRP';
          }
        }
      }

      /*
       * ============================================================
       * CURRENCY
       * ============================================================
       *
       * Hyperdrive is a New Zealand retailer. The output contract
       * expects the literal type "NZD", rather than a general string.
       */

      const currency: 'NZD' = 'NZD';

      const currencyMetadata =
        getFirstAttribute(
          [
            '[itemprop="offers"] meta[itemprop="priceCurrency"]',
            '[itemprop="offers"] [itemprop="priceCurrency"]',
            'meta[itemprop="priceCurrency"]',
            '[itemprop="priceCurrency"][content]',
          ],
          'content'
        );

      if (
        currencyMetadata.value?.toUpperCase() ===
        'NZD'
      ) {
        diagnostics.currencySource =
          `META:${currencyMetadata.selector}`;
      } else {
        diagnostics.currencySource =
          'DEFAULT:NZD';
      }

      /*
       * ============================================================
       * AVAILABILITY
       * ============================================================
       */

      let availability: PageAvailability =
        'unknown';

      const availabilityMetadataResult =
        getFirstAttribute(
          [
            '[itemprop="offers"] meta[itemprop="availability"]',
            'meta[itemprop="availability"]',
            '[itemprop="availability"][content]',
          ],
          'content'
        );

      if (availabilityMetadataResult.value) {
        const normalized =
          availabilityMetadataResult.value
            .toLowerCase()
            .replace(/[_\s-]/g, '');

        if (
          normalized.includes('instock') ||
          normalized.includes(
            'limitedavailability'
          ) ||
          normalized.includes('onlineonly')
        ) {
          availability = 'in_stock';

          diagnostics.availabilitySource =
            `META:${availabilityMetadataResult.selector}`;
        } else if (
          normalized.includes('outofstock') ||
          normalized.includes('soldout') ||
          normalized.includes('discontinued')
        ) {
          availability = 'out_of_stock';

          diagnostics.availabilitySource =
            `META:${availabilityMetadataResult.selector}`;
        } else if (
          normalized.includes('preorder') ||
          normalized.includes('presale') ||
          normalized.includes('backorder')
        ) {
          availability =
            'check_availability';

          diagnostics.availabilitySource =
            `META:${availabilityMetadataResult.selector}`;
        }
      }

      if (availability === 'unknown') {
        const stockStatusResult =
          getFirstText([
            '.stock-status-area .in-stock',
            '.stock-status-area .out-of-stock',
            '.stock-status-area .stock-levels',
            '.stock-status-area',
            '[class*="stock-status" i]',
            '[class*="stock-level" i]',
          ]);

        const stockStatusText =
          stockStatusResult.value || '';

        if (
          /\bin\s+stock\b/i.test(
            stockStatusText
          ) ||
          /\bavailable\b/i.test(
            stockStatusText
          ) ||
          /\bships?\s+in\b/i.test(
            stockStatusText
          )
        ) {
          availability = 'in_stock';

          diagnostics.availabilitySource =
            `DOM:${stockStatusResult.selector}`;
        } else if (
          /\bout\s+of\s+stock\b/i.test(
            stockStatusText
          ) ||
          /\bsold\s+out\b/i.test(
            stockStatusText
          ) ||
          /\bunavailable\b/i.test(
            stockStatusText
          )
        ) {
          availability = 'out_of_stock';

          diagnostics.availabilitySource =
            `DOM:${stockStatusResult.selector}`;
        } else if (
          /\bcheck\s+availability\b/i.test(
            stockStatusText
          ) ||
          /\bcontact\s+us\b/i.test(
            stockStatusText
          ) ||
          /\bbackorder\b/i.test(
            stockStatusText
          ) ||
          /\bpre-?order\b/i.test(
            stockStatusText
          )
        ) {
          availability =
            'check_availability';

          diagnostics.availabilitySource =
            `DOM:${stockStatusResult.selector}`;
        }
      }

      if (availability === 'unknown') {
        const purchaseElement = Array.from(
          document.querySelectorAll(
            'button, a'
          )
        ).find((element) => {
          const text =
            cleanText(element.textContent) ||
            '';

          return (
            /\badd\s+to\s+cart\b/i.test(text) ||
            /\bbuy\s+now\b/i.test(text) ||
            /\badd\s+to\s+basket\b/i.test(text)
          );
        });

        if (purchaseElement) {
          const disabled =
            purchaseElement.hasAttribute(
              'disabled'
            ) ||
            purchaseElement.getAttribute(
              'aria-disabled'
            ) === 'true';

          if (!disabled) {
            availability = 'in_stock';

            diagnostics.availabilitySource =
              'FALLBACK:DOM:Purchase-button';
          }
        }
      }

      /*
       * ============================================================
       * CANONICAL URL
       * ============================================================
       */

      const canonicalUrl =
        getAttribute(
          'link[rel="canonical"]',
          'href'
        ) || window.location.href;

      const result: PageExtractedProduct = {
        name,
        sku,
        price,
        originalPrice,
        availability,
        currency,
        canonicalUrl,
        diagnostics,
      };

      return result;
    });
  }

  /**
   * Main Hyperdrive scraping method.
   */
  async scrapeProduct(
    url: string
  ): Promise<HyperdriveScrapedProduct> {
    let page: Page | null = null;

    try {
      await browserService.initialize();

      page =
        await browserService.createPage();

      logger.info(
        `Scraping Hyperdrive product: ${url}`
      );

      /*
       * Navigate to the product page.
       */
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: this.navigationTimeout,
      });

      const productPageUrl = page.url();

      /*
       * Allow initial client-side rendering to complete.
       */
      await page.waitForTimeout(800);

      /*
       * Wait until either the product name or product price is
       * attached to the rendered document.
       */
      await page
        .locator(
          [
            'h1.page-heading-underline [itemprop="name"]',
            'h1.list-heading [itemprop="name"]',
            'h1 [itemprop="name"]',
            'h1[itemprop="name"]',
            '[itemprop="offers"] [itemprop="price"]',
            '[itemprop="price"]',
          ].join(', ')
        )
        .first()
        .waitFor({
          state: 'attached',
          timeout: 15000,
        })
        .catch(() => {
          logger.debug(
            `Hyperdrive product markup wait timed out for ${url}; ` +
              `continuing with the rendered page`
          );
        });

      /*
       * Network idle is optional because ecommerce websites can
       * maintain background connections.
       */
      try {
        await page.waitForLoadState(
          'networkidle',
          {
            timeout: 2000,
          }
        );
      } catch {
        logger.debug(
          `Hyperdrive networkidle timeout for ${url}; ` +
            `continuing with the rendered page`
        );
      }

      /*
       * Confirm that Playwright loaded a product page.
       */
      await this.validateProductPage(
        page,
        productPageUrl
      );

      /*
       * Extract the product information.
       */
      const product =
        await this.extractProduct(page);

      logger.info(
        `Hyperdrive extraction result for ${url}: ` +
          `${JSON.stringify({
            finalPageUrl: page.url(),
            name: product.name,
            sku: product.sku,
            price: product.price,
            originalPrice:
              product.originalPrice,
            currency: product.currency,
            availability:
              product.availability,
            diagnostics:
              product.diagnostics,
          })}`
      );

      /*
       * Log optional field warnings.
       */
      if (!product.name) {
        logger.warn(
          `Hyperdrive product name could not be extracted for ${url}`
        );
      }

      if (!product.sku) {
        logger.warn(
          `Hyperdrive SKU could not be extracted for ${url}`
        );
      }

      if (product.price === null) {
        logger.warn(
          `Hyperdrive price could not be extracted for ${url}`
        );
      }

      if (
        product.availability === 'unknown'
      ) {
        logger.warn(
          `Hyperdrive availability could not be determined ` +
            `for SKU ${product.sku || 'unknown'} at ${url}`
        );
      }

      /*
       * Product name and current price are required for price
       * monitoring.
       */
      if (!product.name) {
        throw new Error(
          `Hyperdrive product extraction failed because the ` +
            `product name could not be determined for ${url}`
        );
      }

      if (product.price === null) {
        throw new Error(
          `Hyperdrive product extraction failed because the ` +
            `current price could not be determined for ${url}`
        );
      }

      /*
       * Final product-page validation before returning.
       */
      await this.validateProductPage(
        page,
        productPageUrl
      );

      /*
       * Return the standardized scraper result.
       *
       * Currency is deliberately returned as the literal "NZD" to
       * match HyperdriveScrapedProduct.
       */
      const result: HyperdriveScrapedProduct = {
        site: 'hyperdrive',
        url:
          product.canonicalUrl ||
          page.url(),
        name: product.name,
        sku: product.sku,
        price: product.price,
        originalPrice:
          product.originalPrice,
        currency: 'NZD',
        availability:
          product.availability,
        scrapedAt:
          new Date().toISOString(),
      };

      return result;
    } catch (error) {
      logger.error(
        `Hyperdrive scraping failed for ${url}:`,
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

export const hyperdriveAdapter =
  new HyperdriveAdapter();
