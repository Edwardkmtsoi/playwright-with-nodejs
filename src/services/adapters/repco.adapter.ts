import { Page } from 'playwright';
import logger from '../config/logger';
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
  availability:
    | 'in_stock'
    | 'out_of_stock'
    | 'check_availability'
    | null;
  store: string;
  postalCode: string;
  scrapedAt: string;
}

export class RepcoAdapter {
  private readonly storeName = 'North Shore';
  private readonly postalCode = '0626';

  /*
   * -----------------------------------------------------------------
   * STORE SELECTION
   * -----------------------------------------------------------------
   *
   * Repco's storefront (SAP Hybris) does NOT show real stock/store
   * data to a session that hasn't selected a store yet. A brand new
   * Playwright browser context has no cookies, so the product page
   * renders a "Store Locator" prompt instead of the
   * `.product-eligibility` block this adapter depends on for
   * availability and store name.
   *
   * The site exposes a `/store-finder/setstore` action wired to
   * "Select Store" / "Set As My Store" buttons inside the store
   * locator widget. Rather than reverse-engineering the exact
   * request payload for that endpoint (which is undocumented and can
   * change), this drives the real UI flow once per browser session:
   * open the store finder, search the target postcode, and click the
   * matching store's select button. This is slower but far more
   * resilient to markup/JS changes than replaying a raw fetch/XHR.
   *
   * IMPORTANT: the selectors below are a best-effort based on the
   * static markup Repco serves (verified via HTML fetch on
   * 2026-08-10). If Repco changes their store-locator markup this
   * step may start failing silently (it's wrapped in try/catch and
   * just logs a warning). If that happens, re-record the flow with:
   *
   *   npx playwright codegen https://www.repco.co.nz
   *
   * ...open the store finder, search "0626", select North Shore, and
   * copy the resulting selectors in here.
   */
  private async ensureStoreSelected(page: Page): Promise<void> {
    try {
      // If a store is already selected for this session (e.g. cookie
      // reused from a previous run), skip re-selecting it.
      const existingStoreName = await page
        .locator('.product-eligibility .store-name, .tab-store-change .store-name')
        .first()
        .textContent({ timeout: 3000 })
        .catch(() => null);

      if (
        existingStoreName &&
        existingStoreName.trim().toLowerCase() === this.storeName.toLowerCase()
      ) {
        logger.debug(`Repco store already set to ${this.storeName}; skipping store selection`);
        return;
      }

      logger.info(`Repco store not set (or set to something else) — selecting ${this.storeName}`);

      // Open the store finder / "Set my store" widget.
      const openStoreFinder = page
        .locator(
          '.js-store-finder-button, .js-repco-store-finder, a:has-text("Set my store"), a:has-text("Tap here to set your store")'
        )
        .first();

      await openStoreFinder.click({ timeout: 8000 });

      // Type the postcode into the store locator search field.
      const searchInput = page
        .locator(
          'input[placeholder*="postcode" i], input[placeholder*="suburb" i], input[name*="postcode" i]'
        )
        .first();

      await searchInput.waitFor({ timeout: 8000 });
      await searchInput.fill(this.postalCode);
      await page.keyboard.press('Enter');

      // Wait for the store results list to contain our target store,
      // then click its "Select Store" / "Set As My Store" button.
      const storeRow = page
        .locator(`text=${this.storeName}`)
        .first();

      await storeRow.waitFor({ timeout: 10000 });

      const selectButton = page
        .locator('a, button')
        .filter({ hasText: /select store|set as my store/i })
        .first();

      await selectButton.click({ timeout: 8000 });

      // Give the page a moment to apply the store cookie/session and
      // re-render (this may trigger an internal navigation/reload).
      await page.waitForTimeout(2000);

      logger.info(`Repco store selection completed for ${this.storeName}`);
    } catch (error) {
      logger.warn(
        `Repco store selection step failed — availability/store data may be incomplete for this scrape: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  async scrapeProduct(url: string): Promise<RepcoProduct> {
    let page: Page | null = null;

    try {
      await browserService.initialize();
      page = await browserService.createPage();

      logger.info(
        `Scraping Repco product: ${url} using store ${this.storeName} (${this.postalCode})`
      );

      /*
       * Land on the homepage first so the store-locator widget is
       * available in a predictable place, select the store there,
       * and only then navigate to the actual product page — that way
       * the product page's initial server render already reflects
       * the selected store's stock/availability.
       */
      await page.goto('https://www.repco.co.nz/', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });

      await this.ensureStoreSelected(page);

      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });

      /*
       * Repco is heavily client-rendered.
       *
       * Wait for the important product elements first, but do not fail
       * the scrape if a particular selector is not present.
       */
      try {
        await page.waitForLoadState('networkidle', {
          timeout: 15000,
        });
      } catch {
        logger.debug(
          `Repco networkidle timeout for ${url}; continuing with rendered page`
        );
      }

      await page.waitForTimeout(2500);

      /*
       * Give the browser a chance to finish rendering price / availability.
       */
      try {
        await page.waitForSelector('h1', {
          timeout: 10000,
          state: 'attached',
        });
      } catch {
        logger.debug(`Repco h1 not found quickly for ${url}`);
      }

      /*
       * ---------------------------------------------------------
       * EXTRACT PRODUCT
       * ---------------------------------------------------------
       */
      const product = await page.evaluate(() => {
        type ExtractedProduct = {
          name: string | null;
          sku: string | null;
          price: number | null;
          originalPrice: number | null;
          memberPrice: number | null;
          availability:
            | 'in_stock'
            | 'out_of_stock'
            | 'check_availability'
            | null;
          store: string | null;
          diagnostics: {
            priceSources: string[];
            memberPriceSources: string[];
            originalPriceSources: string[];
          };
        };

        /*
         * ---------------------------------------------------------
         * HELPERS
         * ---------------------------------------------------------
         */

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

          /*
           * Handles:
           *
           * $295
           * $295.00
           * $1,295
           * NZ$295
           * NZD $295
           * 295.00
           */
          const text = value
            .replace(/\u00a0/g, ' ')
            .replace(/,/g, '')
            .trim();

          const match = text.match(
            /(?:NZD|NZ|\$)\s*(\d+(?:\.\d{1,2})?)/i
          );

          if (match) {
            const parsed = Number(match[1]);
            return Number.isFinite(parsed) ? parsed : null;
          }

          /*
           * Fallback for plain numeric values.
           */
          const numericMatch = text.match(
            /\b(\d+(?:\.\d{1,2})?)\b/
          );

          if (numericMatch) {
            const parsed = Number(numericMatch[1]);
            return Number.isFinite(parsed) ? parsed : null;
          }

          return null;
        };

        const parseAllPrices = (
          value: string | null | undefined
        ): number[] => {
          if (!value) return [];

          const text = value
            .replace(/\u00a0/g, ' ')
            .replace(/,/g, '');

          const matches = text.match(
            /(?:NZD|NZ|\$)\s*\d+(?:\.\d{1,2})?/gi
          );

          if (!matches) return [];

          return matches
            .map((match) => parsePrice(match))
            .filter(
              (price): price is number =>
                price !== null && Number.isFinite(price)
            );
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

        const addDiagnostic = (
          array: string[],
          source: string
        ): void => {
          if (!array.includes(source)) {
            array.push(source);
          }
        };

        /*
         * Find the smallest useful ancestor containing the product
         * title. This is important because Repco pages contain many
         * prices belonging to recommendations / related products.
         *
         * Confirmed against the live Repco PDP markup: the product
         * title (`.pdp-product-title`) and the price container
         * (`.price__container`) both live inside `.product-details`,
         * so walking up from the title a couple of levels reliably
         * lands on that wrapper.
         */
        const findProductRoot = (): Element | null => {
          const title =
            document.querySelector('.pdp-product-title') ||
            document.querySelector('[data-testid*="product-title" i]') ||
            document.querySelector('h1');

          if (!title) {
            return (
              document.querySelector('.product-details') ||
              document.querySelector('main')
            );
          }

          /*
           * Walk upwards and select an ancestor that contains the
           * main product information without becoming the entire page.
           */
          let current: Element | null = title;

          for (let i = 0; i < 8 && current; i++) {
            const textLength =
              current.textContent?.length || 0;

            if (
              current.querySelector(
                '.price__container, .price, [class*="price" i]'
              ) &&
              textLength < 50000
            ) {
              return current;
            }

            current = current.parentElement;
          }

          return (
            document.querySelector('.product-details') ||
            document.querySelector('main') ||
            title.parentElement
          );
        };

        const productRoot = findProductRoot();

        /*
         * ---------------------------------------------------------
         * DIAGNOSTICS
         * ---------------------------------------------------------
         */

        const priceSources: string[] = [];
        const memberPriceSources: string[] = [];
        const originalPriceSources: string[] = [];

        /*
         * ---------------------------------------------------------
         * NAME
         * ---------------------------------------------------------
         */

        const name =
          getText('.pdp-product-title') ||
          getText('[data-testid="product-title"]') ||
          getText('[data-testid*="product-title" i]') ||
          getText('h1');

        /*
         * ---------------------------------------------------------
         * SKU
         * ---------------------------------------------------------
         *
         * Live markup example: <h5 class="product-sku">SKU: A6220709</h5>
         */

        let sku: string | null = null;

        const skuSelectors = [
          '.product-sku',
          '[data-testid="product-sku"]',
          '[data-testid*="sku" i]',
          '[class*="sku" i]',
        ];

        for (const selector of skuSelectors) {
          const element = document.querySelector(selector);

          if (!element) continue;

          const text = cleanText(element.textContent);

          if (!text) continue;

          /*
           * Examples:
           * SKU: ABC123
           * SKU ABC123
           * Product Code: ABC123
           * Part Number: ABC123
           */
          const match = text.match(
            /(?:SKU|Product\s*(?:Code|Number)|Part\s*Number)\s*[:#-]?\s*([A-Z0-9][A-Z0-9._-]*)/i
          );

          if (match) {
            sku = match[1].trim();
            break;
          }

          /*
           * If the element itself is clearly a SKU element and
           * contains only a code, use the value directly.
           */
          if (
            /sku/i.test(selector) &&
            /^[A-Z0-9][A-Z0-9._-]{2,}$/i.test(text)
          ) {
            sku = text;
            break;
          }
        }

        /*
         * Search product-root text as a final SKU fallback.
         */
        if (!sku && productRoot) {
          const rootText = cleanText(productRoot.textContent) || '';

          const match = rootText.match(
            /(?:SKU|Product\s*(?:Code|Number)|Part\s*Number)\s*[:#-]?\s*([A-Z0-9][A-Z0-9._-]*)/i
          );

          if (match) {
            sku = match[1].trim();
          }
        }

        /*
         * ---------------------------------------------------------
         * STRUCTURED DATA
         * ---------------------------------------------------------
         *
         * Repco exposes a dedicated Product JSON-LD block (separate
         * from the BreadcrumbList and VideoObject blocks also present
         * on the page), e.g.:
         *
         * {
         *   "@type": "Product",
         *   "sku": "A6220709",
         *   "gtin13": "4054278885766",
         *   "offers": {
         *     "@type": "Offer",
         *     "availability": "https://schema.org/inStock",
         *     "price": "295",
         *     "priceCurrency": "NZD"
         *   }
         * }
         *
         * This is one of the safest fallback sources because it is
         * explicitly associated with the product rather than a
         * recommendation tile.
         */

        let structuredPrice: number | null = null;
        let structuredSku: string | null = null;
        let structuredAvailability:
          | 'in_stock'
          | 'out_of_stock'
          | 'check_availability'
          | null = null;

        const jsonLdScripts = Array.from(
          document.querySelectorAll(
            'script[type="application/ld+json"]'
          )
        );

        const findProductObjects = (
          value: unknown
        ): any[] => {
          const results: any[] = [];

          const visit = (item: any): void => {
            if (!item || typeof item !== 'object') {
              return;
            }

            if (Array.isArray(item)) {
              for (const child of item) {
                visit(child);
              }

              return;
            }

            if (
              item['@type'] === 'Product' ||
              (Array.isArray(item['@type']) &&
                item['@type'].includes('Product'))
            ) {
              results.push(item);
            }

            if (item['@graph']) {
              visit(item['@graph']);
            }
          };

          visit(value);

          return results;
        };

        for (const script of jsonLdScripts) {
          try {
            const raw = script.textContent;

            if (!raw) continue;

            const parsed = JSON.parse(raw);
            const products = findProductObjects(parsed);

            for (const product of products) {
              if (!structuredSku && product.sku) {
                structuredSku = String(product.sku).trim();
              }

              const offers = Array.isArray(product.offers)
                ? product.offers
                : product.offers
                  ? [product.offers]
                  : [];

              for (const offer of offers) {
                if (
                  structuredPrice === null &&
                  offer?.price !== undefined
                ) {
                  const parsedPrice = parsePrice(
                    String(offer.price)
                  );

                  if (parsedPrice !== null) {
                    structuredPrice = parsedPrice;
                  }
                }

                const availabilityText =
                  String(offer?.availability || '');

                if (
                  structuredAvailability === null &&
                  /outofstock/i.test(availabilityText)
                ) {
                  structuredAvailability = 'out_of_stock';
                } else if (
                  structuredAvailability === null &&
                  /instock/i.test(availabilityText)
                ) {
                  structuredAvailability = 'in_stock';
                }
              }
            }
          } catch {
            /*
             * Ignore malformed/non-JSON script blocks.
             */
          }
        }

        /*
         * ---------------------------------------------------------
         * PRICE
         * ---------------------------------------------------------
         */

        let price: number | null = null;
        let originalPrice: number | null = null;

        /*
         * 1. Explicit Repco price container.
         *
         * Live markup:
         * <div class="price__container">
         *   <div class="price">
         *     <span class="price__dollars has-promo">$295</span>
         *     <span class="savings">$362</span>
         *     <span class="price__each">each</span>
         *   </div>
         * </div>
         */
        if (productRoot) {
          const priceContainers = Array.from(
            productRoot.querySelectorAll(
              '.price__container, .product-price, .price'
            )
          );

          for (const container of priceContainers) {
            const containerText =
              cleanText(container.textContent) || '';

            if (!containerText) continue;

            /*
             * Current / selling price.
             *
             * Prefer explicit current-price classes first.
             */
            const currentSelectors = [
              '.price__dollars.has-promo',
              '.price__dollars',
              '.sale-price',
              '.current-price',
              '.selling-price',
              '[class*="sale-price" i]',
              '[class*="current-price" i]',
              '[class*="selling-price" i]',
              '[class*="price__dollars" i]',
            ];

            for (const selector of currentSelectors) {
              const elements = Array.from(
                container.querySelectorAll(selector)
              );

              for (const element of elements) {
                const candidate = parsePrice(
                  element.textContent
                );

                if (candidate !== null) {
                  price = candidate;
                  addDiagnostic(
                    priceSources,
                    `DOM:${selector}`
                  );
                  break;
                }
              }

              if (price !== null) break;
            }

            /*
             * If no explicit current price was found, inspect all
             * price-like elements inside this product price area.
             */
            if (price === null) {
              const candidates = Array.from(
                container.querySelectorAll(
                  '[class*="price" i], [class*="amount" i], span, strong, b'
                )
              );

              for (const element of candidates) {
                const text = cleanText(element.textContent);

                if (!text) continue;

                const candidate = parsePrice(text);

                if (candidate === null) continue;

                /*
                 * Avoid taking obvious old/saving/member prices.
                 */
                if (
                  /saving|save|was|rrp|original|member/i.test(
                    text
                  )
                ) {
                  continue;
                }

                price = candidate;
                addDiagnostic(
                  priceSources,
                  'DOM:price-container-fallback'
                );
                break;
              }
            }

            /*
             * Original / previous price.
             *
             * NOTE: on Repco's live markup, the "was" price is
             * rendered as `.savings` (e.g. "$362") sitting alongside
             * the discounted `.price__dollars` value. It is NOT a
             * savings *amount* despite the class name.
             */
            const originalSelectors = [
              '.savings',
              '.was-price',
              '.original-price',
              '.rrp',
              '[class*="was-price" i]',
              '[class*="original-price" i]',
              '[class*="rrp" i]',
              '[class*="saving" i]',
            ];

            for (const selector of originalSelectors) {
              const elements = Array.from(
                container.querySelectorAll(selector)
              );

              for (const element of elements) {
                const candidate = parsePrice(
                  element.textContent
                );

                if (
                  candidate !== null &&
                  candidate !== price
                ) {
                  originalPrice = candidate;

                  addDiagnostic(
                    originalPriceSources,
                    `DOM:${selector}`
                  );

                  break;
                }
              }

              if (originalPrice !== null) break;
            }

            if (price !== null) break;
          }
        }

        /*
         * 2. Product-root price elements.
         */
        if (price === null && productRoot) {
          const priceElements = Array.from(
            productRoot.querySelectorAll(
              '[class*="price" i]'
            )
          );

          for (const element of priceElements) {
            const text = cleanText(element.textContent);

            if (!text) continue;

            /*
             * Do not accept huge containers containing dozens of
             * unrelated prices.
             */
            if (text.length > 300) continue;

            if (
              /member|saving|save|was|rrp|original/i.test(text)
            ) {
              continue;
            }

            const candidate = parsePrice(text);

            if (candidate !== null) {
              price = candidate;

              addDiagnostic(
                priceSources,
                'DOM:product-root-price'
              );

              break;
            }
          }
        }

        /*
         * 3. Meta price.
         *
         * Repco also emits og:price:amount, which is a reliable
         * fallback when the DOM structure changes.
         */
        if (price === null) {
          const metaPriceSelectors = [
            'meta[property="og:price:amount"]',
            'meta[property="product:price:amount"]',
            'meta[itemprop="price"]',
            'meta[name="price"]',
          ];

          for (const selector of metaPriceSelectors) {
            const value = getAttribute(selector, 'content');

            const candidate = parsePrice(value);

            if (candidate !== null) {
              price = candidate;

              addDiagnostic(
                priceSources,
                `META:${selector}`
              );

              break;
            }
          }
        }

        /*
         * 4. JSON-LD.
         */
        if (price === null && structuredPrice !== null) {
          price = structuredPrice;

          addDiagnostic(
            priceSources,
            'JSON-LD:offers.price'
          );
        }

        /*
         * ---------------------------------------------------------
         * ORIGINAL PRICE FALLBACK
         * ---------------------------------------------------------
         */

        if (originalPrice === null && productRoot) {
          const rootText =
            cleanText(productRoot.textContent) || '';

          /*
           * Look specifically for:
           *
           * Was $362
           * RRP $362
           * Originally $362
           * Save ... from $362
           */
          const originalPatterns = [
            /\bwas\s*(?:NZD|NZ|\$)?\s*([\d,]+(?:\.\d{1,2})?)/i,
            /\brrp\s*(?:NZD|NZ|\$)?\s*([\d,]+(?:\.\d{1,2})?)/i,
            /\boriginal(?:ly)?\s*(?:price\s*)?(?:NZD|NZ|\$)?\s*([\d,]+(?:\.\d{1,2})?)/i,
          ];

          for (const pattern of originalPatterns) {
            const match = rootText.match(pattern);

            if (match) {
              const candidate = parsePrice(match[1]);

              if (
                candidate !== null &&
                candidate !== price
              ) {
                originalPrice = candidate;

                addDiagnostic(
                  originalPriceSources,
                  'TEXT:original-price'
                );

                break;
              }
            }
          }
        }

        /*
         * If the Repco price container gives two prices but the
         * original-price class isn't available, infer the higher
         * value as the original price.
         */
        if (
          originalPrice === null &&
          productRoot &&
          price !== null
        ) {
          const priceContainers = Array.from(
            productRoot.querySelectorAll(
              '.price__container, .product-price, .price'
            )
          );

          for (const container of priceContainers) {
            const prices = parseAllPrices(
              container.textContent
            );

            const higherPrices = prices.filter(
              (candidate) => candidate > price!
            );

            if (higherPrices.length > 0) {
              originalPrice = Math.max(...higherPrices);

              addDiagnostic(
                originalPriceSources,
                'DOM:price-container-higher-price'
              );

              break;
            }
          }
        }

        /*
         * ---------------------------------------------------------
         * MEMBER PRICE
         * ---------------------------------------------------------
         *
         * IMPORTANT:
         *
         * Do NOT search the whole page.
         *
         * Repco pages can contain member prices (and "Repco Rewards
         * Member" branding/nav elements) far outside the product
         * area, which would otherwise be incorrectly assigned to the
         * main product. All matching is scoped to productRoot.
         */

        let memberPrice: number | null = null;

        if (productRoot) {
          /*
           * Search elements whose text explicitly mentions
           * "Member Price".
           */
          const memberElements = Array.from(
            productRoot.querySelectorAll('*')
          ).filter((element) => {
            const text =
              cleanText(element.textContent) || '';

            return (
              /member\s*price/i.test(text) &&
              text.length < 500
            );
          });

          for (const element of memberElements) {
            const text =
              cleanText(element.textContent) || '';

            /*
             * First try the same element.
             */
            const directPrices = parseAllPrices(text);

            if (directPrices.length > 0) {
              /*
               * Usually the member-price label is followed by
               * the member price.
               */
              memberPrice = directPrices[0];

              addDiagnostic(
                memberPriceSources,
                'DOM:member-price-label'
              );

              break;
            }

            /*
             * Then inspect parent / sibling container.
             */
            const parent = element.parentElement;

            if (parent) {
              const parentText =
                cleanText(parent.textContent) || '';

              const parentPrices =
                parseAllPrices(parentText);

              if (parentPrices.length > 0) {
                memberPrice = parentPrices[0];

                addDiagnostic(
                  memberPriceSources,
                  'DOM:member-price-parent'
                );

                break;
              }
            }
          }
        }

        /*
         * Text-based member-price fallback.
         */
        if (memberPrice === null && productRoot) {
          const rootText =
            cleanText(productRoot.textContent) || '';

          const memberMatch = rootText.match(
            /member\s*price[\s:]*((?:NZD|NZ|\$)\s*[\d,]+(?:\.\d{1,2})?)/i
          );

          if (memberMatch) {
            const candidate = parsePrice(
              memberMatch[1]
            );

            if (candidate !== null) {
              memberPrice = candidate;

              addDiagnostic(
                memberPriceSources,
                'TEXT:member-price'
              );
            }
          }
        }

        /*
         * ---------------------------------------------------------
         * AVAILABILITY
         * ---------------------------------------------------------
         *
         * Live markup:
         * <div class="row product-eligibility">
         *   <div class="row tab-store-change">
         *     <div class="col-xs-6 store-name">North Shore</div>
         *     <div class="col-xs-3 text-green stock-status">
         *       <p class="text-green">In Stock</p>
         *     </div>
         *     ...
         */

        let availability:
          | 'in_stock'
          | 'out_of_stock'
          | 'check_availability'
          | null = null;

        const eligibilitySelectors = [
          '.product-eligibility',
          '[data-testid*="eligibility" i]',
          '[class*="product-eligibility" i]',
          '[class*="availability" i]',
          '[class*="stock-status" i]',
        ];

        let eligibility: Element | null = null;

        for (const selector of eligibilitySelectors) {
          const element =
            document.querySelector(selector);

          if (element) {
            eligibility = element;
            break;
          }
        }

        if (eligibility) {
          const stockStatus =
            cleanText(eligibility.textContent) || '';

          if (
            /\bout\s*of\s*stock\b/i.test(stockStatus) ||
            /\bunavailable\b/i.test(stockStatus)
          ) {
            availability = 'out_of_stock';
          } else if (
            /\bin\s*stock\b/i.test(stockStatus) ||
            /\bavailable\b/i.test(stockStatus)
          ) {
            availability = 'in_stock';
          } else if (
            /check\s*availability/i.test(stockStatus)
          ) {
            availability = 'check_availability';
          }
        }

        /*
         * Structured-data fallback.
         */
        if (
          availability === null &&
          structuredAvailability !== null
        ) {
          availability = structuredAvailability;
        }

        /*
         * Product-root fallback.
         */
        if (availability === null && productRoot) {
          const productText =
            cleanText(productRoot.textContent) || '';

          if (
            /\bout\s*of\s*stock\b/i.test(productText) ||
            /\bunavailable\b/i.test(productText)
          ) {
            availability = 'out_of_stock';
          } else if (
            /\bin\s*stock\b/i.test(productText)
          ) {
            availability = 'in_stock';
          } else if (
            /check\s*availability/i.test(productText)
          ) {
            availability = 'check_availability';
          }
        }

        /*
         * ---------------------------------------------------------
         * STORE
         * ---------------------------------------------------------
         */

        let store: string | null = null;

        const storeSelectors = [
          '.product-eligibility .store-name',
          '.store-name',
          '[data-testid*="store-name" i]',
          '[class*="store-name" i]',
        ];

        for (const selector of storeSelectors) {
          const value = getText(selector);

          if (value) {
            store = value;
            break;
          }
        }

        /*
         * Store fallback from product eligibility text.
         */
        if (!store && eligibility) {
          const eligibilityText =
            cleanText(eligibility.textContent) || '';

          /*
           * Look for common store wording without assuming that
           * North Shore is always returned.
           */
          const storeMatch = eligibilityText.match(
            /(?:store|pickup|pick\s*up)[\s:|-]+([A-Za-z][A-Za-z0-9 '&.-]{2,50})/i
          );

          if (storeMatch) {
            store = cleanText(storeMatch[1]);
          }
        }

        /*
         * ---------------------------------------------------------
         * FINAL NORMALISATION
         * ---------------------------------------------------------
         */

        /*
         * If originalPrice equals the current price, it isn't useful
         * as an original price.
         */
        if (
          originalPrice !== null &&
          price !== null &&
          originalPrice === price
        ) {
          originalPrice = null;
        }

        /*
         * A member price equal to the main price isn't really a
         * separate member price.
         */
        if (
          memberPrice !== null &&
          price !== null &&
          memberPrice === price
        ) {
          memberPrice = null;
        }

        /*
         * If the member price is greater than the normal selling
         * price, it is probably not a member price.
         */
        if (
          memberPrice !== null &&
          price !== null &&
          memberPrice > price
        ) {
          memberPrice = null;
        }

        /*
         * If the original price is lower than the selling price,
         * discard it as an invalid original price.
         */
        if (
          originalPrice !== null &&
          price !== null &&
          originalPrice < price
        ) {
          originalPrice = null;
        }

        return {
          name,
          sku: sku || structuredSku,
          price,
          originalPrice,
          memberPrice,
          availability,
          store,
          diagnostics: {
            priceSources,
            memberPriceSources,
            originalPriceSources,
          },
        } satisfies ExtractedProduct;
      });

      /*
       * ---------------------------------------------------------
       * LOG EXTRACTION RESULT
       * ---------------------------------------------------------
       *
       * This is intentionally useful during the current debugging
       * phase. Once scraping is stable, the diagnostic detail can be
       * reduced.
       */
      logger.info(
        `Repco extraction result for ${url}: ${JSON.stringify({
          name: product.name,
          sku: product.sku,
          price: product.price,
          originalPrice: product.originalPrice,
          memberPrice: product.memberPrice,
          availability: product.availability,
          store: product.store,
          priceSources: product.diagnostics.priceSources,
          memberPriceSources:
            product.diagnostics.memberPriceSources,
          originalPriceSources:
            product.diagnostics.originalPriceSources,
        })}`
      );

      /*
       * ---------------------------------------------------------
       * WARN ABOUT MISSING IMPORTANT DATA
       * ---------------------------------------------------------
       */

      if (product.price === null) {
        logger.warn(
          `Repco price could not be extracted for ${url}`
        );
      }

      if (!product.name) {
        logger.warn(
          `Repco product name could not be extracted for ${url}`
        );
      }

      if (!product.sku) {
        logger.warn(
          `Repco SKU could not be extracted for ${url}`
        );
      }

      /*
       * ---------------------------------------------------------
       * VERIFY STORE
       * ---------------------------------------------------------
       */

      if (
        product.store &&
        product.store.toLowerCase() !==
          this.storeName.toLowerCase()
      ) {
        logger.warn(
          `Repco returned store "${product.store}" instead of "${this.storeName}"`
        );
      }

      /*
       * ---------------------------------------------------------
       * RETURN API MODEL
       * ---------------------------------------------------------
       */

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
