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
  currency: string;
  canonicalUrl: string;
  diagnostics: ExtractionDiagnostics;
}

export class HyperdriveAdapter implements ProductScraperAdapter {
  readonly site = 'hyperdrive' as const;

  private readonly navigationTimeout = 60000;

  /**
   * Determine whether this adapter can handle the supplied URL.
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
   * Validate that the loaded p*ge appears to be a product page.
 * */
  private async validateProduc*Page(
    page: Page,
    expected*roductUrl: string
  ): Promise<voi*> {
    const currentUrl = page.ur*();

    const heading = await pag*
      .locator('h1')
      .first*)
      .textContent({
        tim*out: 10000,
      })
      .catch(*) => null);

    const cleanedHead*ng =
      heading
        ?.repla*e(/\s+/g, ' ')
        .trim() || *ull;

    const productName = awai* page
      .locator(
        [
          'h1 [itemprop="name"]',
          'h1[itemprop="name"]',
          '[itemprop="name"]',
        ]*join(', ')
      )
      .first()
*     .textContent({
        timeou*: 5000,
      })
      .catch(() =* null);

    const priceElementCou*t = await page
      .locator(
   *    [
          '[itemprop="offers"] [itemprop="price"]',
          '[itemprop="price"]',
          '.tyrePrice .price',
          '.price-area .price',
        ].join(', ')
*     )
      .count()
      .catch*() => 0);

    if (
      !cleaned*eading &&
      !productName &&
  *   priceElementCount === 0
    ) {*      throw new Error(
        `Hy*erdrive extraction aborted because*the loaded page ` +
          `doe* not appear to be a product page. * +
          `Current URL: ${curre*tUrl}; ` +
          `expected URL* ${expectedProductUrl}`
      );
 *  }
  }

  /**
   * Extract produc* details from the rendered Hyperdr*ve page.
   */
  private async ext*actProduct(
    page: Page
  ): Pr*mise<ExtractedProduct> {
    retur* page.evaluate((): ExtractedProduc* => {
      const cleanText = (
  *     value: string | null | undefi*ed
      ): string | null => {
        if (!value) {
          return null;
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

        /*
         * Matches:
         *
         * 29.99
         * $29.99
         * NZD 29.99
         * NZ$29.99
         */
        const match = cleaned.match(
          /(?:NZD|NZ\$|\$)?\s*(\d+(?:\.\d{1,2})?)/
        );

        if (!match) {
          return null;
        }

        const parsed = Number(match[1]);

        return Number.isFinite(parsed)
          ? parsed
          : null;
      };

      const getText = (
        selector: string
      ): string | null => {
        const element =
          document.querySelector(selector);

        return cleanText(
          element?.textContent
        );
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
          const value =
            getAttribute(
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

      const diagnostics: ExtractionDiagnostics = {
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
       *
       * Supplied Hyperdrive HTML:
       *
       * <h1 class="page-heading-underline list-heading">
       *   <span itemprop="name">
       *     Plasti-Dip Liquid Tape Spray 170G Black
       *   </span>
       * </h1>
       */
      let name: string | null = null;

      const nameResult = getFirstText([
        'h1.page-heading-underline [itemprop="name"]',
        'h1.list-heading [itemprop="name"]',
        'h1 [itemprop="name"]',
        'h1[itemprop="name"]',
        'h1.page-heading-underline',
        'h1.list-heading',
        'h1',
      ]);

      if (nameResult.value) {
        name = nameResult.value;
        diagnostics.nameSource =
          `DOM:${nameResult.selector}`;
      }

      /*
       * Schema markup fallback.
       */
      if (!name) {
        const schemaName =
          getAttribute(
            'meta[itemprop="name"]',
            'content'
          );

        if (schemaName) {
          name = schemaName;
          diagnostics.nameSource =
            'META:itemprop=name';
        }
      }

      /*
       * Document title fallback.
       */
      if (!name) {
        const title =
          cleanText(document.title);

        if (title) {
          name = title
            .replace(
              /\s*[|–-]\s*Hyper\s*Drive.*$/i,
              ''
            )
            .replace(
              /\s*[|–-]\s*Hyperdrive.*$/i,
              ''
            )
            .trim();

          diagnostics.nameSource =
            'document.title';
        }
      }

      /*
       * ============================================================
       * SKU
       * ============================================================
       *
       * Supplied Hyperdrive HTML:
       *
       * <small class="pull-right">
       *   SKU #<span>1031-221-408569</span>
       * </small>
       */
      let sku: string | null = null;

      /*
       * Prefer structured metadata if it exists.
       */
      const skuMetaResult =
        getFirstAttribute(
          [
            'meta[itemprop="sku"]',
            'meta[itemprop="productID"]',
            '[itemprop="sku"][content]',
            '[itemprop="productID"][content]',
          ],
          'content'
        );

      if (skuMetaResult.value) {
        sku = skuMetaResult.value;
        diagnostics.skuSource =
          `META:${skuMetaResult.selector}`;
      }

      /*
       * Hyperdrive SKU element.
       */
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

          /*
           * First try the child span because the supplied HTML places
           * the exact SKU inside it.
           */
          const spanValue =
            cleanText(
              container.querySelector('span')
                ?.textContent
            );

          if (spanValue) {
            sku = spanValue;
            diagnostics.skuSource =
              'DOM:small.pull-right span';
            break;
          }

          /*
           * Text fallback:
           *
           * SKU #1031-221-408569
           */
          const match =
            containerText.match(
              /\bSKU\s*#?\s*:?\s*([A-Z0-9._-]+)/i
            );

          if (match) {
            sku = match[1];
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
       *
       * Supplied Hyperdrive HTML:
       *
       * <span
       *   itemprop="price"
       *   content="29.99"
       *   class="price"
       * >
       *   <span>$29.99</span>
       * </span>
       */
      let price: number | null =*null;

      const priceSelectors = [
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

        /*
         * The content attribute is preferred because it contains the
         * clean numeric value without currency symbols or formatting.
         */
        const candidate =
          parsePrice(
            element.getAttribute('content') ||
              element.textContent
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
       * ORIGINAL / USUAL PRICE
       * ============================================================
       *
       * Hyperdrive may display the previous price inside:
       *
       * <div class="usuallyPrice">...</div>
       *
       * In the supplied example this element is empty, so the result
       * will correctly remain null.
       */
      let originalPrice: number * null = null;

      const origina*PriceSelectors = [
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
        const selector of
        originalPriceSelectors
      ) {
        const element =
          document.querySelector(selector);

        if (!element) {
          continue;
        }

        const candidate =
          parsePrice(
            element.getAttribute('content') ||
              element.textContent
          );

        if (
          candidate !== null &&
          (
            price === null ||
            candidate > price
          )
        ) {
          originalPrice = candidate;
          diagnostics.originalPriceSource =
            `DOM:${selector}`;
          break;
        }
      }

      /*
       * Text fallback for:
       *
       * Usually $49.99
       * Was $49.99
       * RRP $49.99
       */
      if (originalPrice === null) {
        const relevantPriceArea =
          cleanText(
            document.querySelector(
              '.price-area'
            )?.textContent
          ) || '';

        const originalPriceMatch =
          relevantPriceArea.match(
            /\b(?:Usually|Was|RRP)\s*:?\s*(?:NZD|NZ\$|\$)?\s*([\d,]+(?:\.\d{1,2})?)/i
          );

        if (originalPriceMatch) {
          const candidate =
            parsePrice(
              originalPriceMatch[1]
            );

          if (
            candidate !== null &&
            (
              price === null ||
              candidate > price
            )
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
       * Supplied Hyperdrive HTML:
       *
       * <meta
       *   itemprop="priceCurrency"
       *   content="NZD"
       * >
       */
      let currency = '*ZD';

      const currencyResult =*        getFirstAttribute(
          [
            '[itemprop="offers"] [itemprop="priceCurrency"]',
            'meta[itemprop="priceCurrency"]',
            '[itemprop="priceCurrency"]',
          ],
          'content'
        );

      if (currencyResult.value) {
        currency =
          currencyResult.value.toUpperCase();

        diagnostics.currencySource =
          `META:${currencyResult.selector}`;
      } else {
        diagnostics.currencySource =
          'DEFAULT:NZD';
      }

      /*
       * ============================================================
       * AVAILABILITY
       * ============================================================
       *
       * This is general Hyperdrive online/DC availability.
       * There is no store or postcode selection.
       *
       * Supplied HTML:
       *
       * <meta
       *   itemprop="availability"
       *   content="https://schema.org/InStock"
       * >
       *
       * and:
       *
       * <span class="in-stock stock-levels">
       *   In stock at Distribution Centre
       * </span>
       */
      let availability: Availability =
        'unknown';

      /*
       * Primary source: Schema.org metadata.
       */
      const availabilityMetaResu*t =
        getFirstAttribute(
   *      [
            '[itemprop="offers"] meta[itemprop="availability"]',
            'meta[itemprop="availability"]',
            '[itemprop="availability"][content]',
          ],
          'content'
        *;

      if (availabilityMetaResul*.value) {
        const normalized*vailability =
          availabili*yMetaResult.value
            .toL*werCase()
            .replace(/[_\s-]/g, '');

        if (
        * normalizedAvailability.includes(
*           'instock'
          ) |*
          normalizedAvailability.*ncludes(
            'limitedavail*bility'
          ) ||
          n*rmalizedAvailability.includes(
   *        'onlineonly'
          )
 *      ) {
          availability =*'in_stock';
          diagnostics.*vailabilitySource =
            `M*TA:${availabilityMetaResult.select*r}`;
        } else if (
         *normalizedAvailability.includes(
 *          'outofstock'
          )*||
          normalizedAvailabilit*.includes(
            'soldout'
 *        ) ||
          normalizedA*ailability.includes(
            '*iscontinued'
          )
        )*{
          availability = 'out_of*stock';
          diagnostics.avai*abilitySource =
            `META:${availabilityMetaResult.selector}`;
        } else if (
          normalizedAvailability.includes(
            'preorder'
          ) ||
          normalizedAvailability.includes(
            'presale'
          ) ||
          normalizedAvailability.includes(
            'backorder'
          )
        ) {
          availability =
            'check_availability';

          diagnostics.availabilitySource =
            `META:${availabilityMetaResult.selector}`;
        }
      }

      /*
       * Secondary source: Hyperdrive stock-status element.
       */
      if (availability === 'unkn*wn') {
        const stockStatusRe*ult =
          getFirstText([
            '.stock-status-area .in-stock',
            '.stock-status-area .out-of-stock',
            '.stock-status-area .stock-levels',
            '.stock-status-area',
            '[class*="stock-status" i]',
            '[class*="stock-level" i]',
          ]);

        const stockStatus =
          stockStatusResult.value || '';

        if (
          /\bin\s+stock\b/i.test(stockStatus) ||
          /\bavailable\b/i.test(stockStatus) ||
          /\bships?\s+in\b/i.test(stockStatus)
        ) {
          availability = 'in_stock';
          diagnostics.availabilitySource =
            `DOM:${stockStatusResult.selector}`;
        } else if (
          /\bout\s+of\s+stock\b/i.test(
            stockStatus
          ) ||
          /\bsold\s+out\b/i.test(
            stockStatus
          ) ||
          /\bunavailable\b/i.test(
            stockStatus
          )
        ) {
          availability = 'out_of_stock';
          diagnostics.availabilitySource =
            `DOM:${stockStatusResult.selector}`;
        } else if (
          /\bcheck\s+availability\b/i.test(
            stockStatus
          ) ||
          /\bcontact\s+us\b/i.test(
            stockStatus
          ) ||
          /\bbackorder\b/i.test(
            stockStatus
          ) ||
          /\bpre-?order\b/i.test(
            stockStatus
          )
        ) {
          availability =
            'check_availability';

          diagnostics.availabilitySource =
            `DOM:${stockStatusResult.selector}`;
        }
      }

      /*
       * Tertiary fallback: Purchase button.
       *
       * Keep this confined to recognised purchase wording so that an
       * unrelated button does not produce an in-stock result.
       */
      if (availability === 'unkn*wn') {
        const purchaseEleme*t =
          Array.from(
        *   document.querySelectorAll(
    *         'button, a'
            )*          ).find((element) => {
  *         const text =
            * cleanText(
                elemen*.textContent
              ) || ''*

            return (
           *  /\badd\s+to\s+cart\b/i.test(text* ||
              /\bbuy\s+now\b/i*test(text) ||
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
