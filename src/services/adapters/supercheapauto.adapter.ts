import { Page } from 'playwright';
import logger from '../../config/logger';
import { browserService } from '../browser.service';
import { ProductScraperAdapter } from './scraper-adapter.interface';
import { SupercheapAutoScrapedProduct } from '../../types/product-scrape.types';

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
  saleEndDateSource: string | null;
  storeSource: string | null;
  availabilitySource: string | null;
  storeAvailabilitySource: string | null;
}

interface ExtractedProduct {
  name: string | null;
  sku: string | null;
  price: number | null;
  originalPrice: number | null;
  saleEndDate: string | null;
  availability: Availability;
  storeAvailability: Availability;
  store: string | null;
  canonicalUrl: string;
  diagnostics: ExtractionDiagnostics;
}

export class SupercheapAutoAdapter implements ProductScraperAdapter {
  readonly site = 'supercheapauto' as const;

  private readonly storeName = 'SCA Wairau Park';
  private readonly storeId = '7030';
  private readonly postalCode = '0627';

  private readonly navigationTimeout = 60000;

  /**
   * Determine whether this adapter can handle the supplied URL.
   */
  canHandle(url: string): boolean {
    try {
      const parsedUrl = new URL(url);
      const hostname = parsedUrl.hostname.toLowerCase();

      return (
        hostname === 'supercheapauto.co.nz' ||
        hostname.endsWith('.supercheapauto.co.nz')
      );
    } catch {
      return false;
    }
  }

  /**
   * Determine whether the current page is a search-results page.
   *
   * This is important because the store selector can accidentally submit
   * the site's global search form if the wrong input is selected.
   */
  private isSearchResultsUrl(url: string): boolean {
    try {
      const parsedUrl = new URL(url);

      return (
        parsedUrl.pathname === '/search' ||
        parsedUrl.pathname.startsWith('/search/')
      );
    } catch {
      return url.includes('/search?') || url.includes('/search/');
    }
  }

  /**
   * Restore the product page if store selection accidentally navigated
   * the browser to the global search page.
   */
  private async restoreProductPage(
    page: Page,
    productUrl: string
  ): Promise<void> {
    if (!this.isSearchResultsUrl(page.url())) {
      return;
    }

    logger.warn(
      `Supercheap Auto unexpectedly navigated to ${page.url()}. ` +
        `Restoring product page ${productUrl}`
    );

    await page.goto(productUrl, {
      waitUntil: 'domcontentloaded',
      timeout: this.navigationTimeout,
    });

    await page.waitForTimeout(2000);
  }

  /**
   * Select the configured Supercheap Auto store.
   *
   * Store selection is deliberately defensive because the site contains
   * multiple search inputs and a global product-search input.
   */
  private async ensureStoreSelected(
    page: Page,
    productUrl: string
  ): Promise<void> {
    try {
      logger.info(
        `Selecting Supercheap Auto store ${this.storeName} ` +
          `(${this.postalCode}), store ID ${this.storeId}`
      );

      await this.openStoreSelector(page);

      const postcodeInput = await this.findStorePostcodeInput(page);

      const inputDetails = await postcodeInput.evaluate(
        (element: HTMLInputElement) => ({
          id: element.id || null,
          name: element.name || null,
          type: element.type || null,
          placeholder: element.placeholder || null,
          className: element.className || null,
        })
      );

      logger.debug(
        `Supercheap Auto store postcode input: ${JSON.stringify(
          inputDetails
        )}`
      );

      /*
       * Defensive check against accidentally selecting the global
       * product-search input.
       */
      if (
        inputDetails.name?.toLowerCase() === 'q' ||
        /search products|what are you looking for/i.test(
          inputDetails.placeholder || ''
        )
      ) {
        throw new Error(
          `The selected postcode input appears to be the global ` +
            `product-search input: ${JSON.stringify(inputDetails)}`
        );
      }

      await postcodeInput.fill(this.postalCode);

      await this.searchForStore(page);

      const storeElement = await this.findConfiguredStore(page);

      const storeDetails = await this.getStoreDetails(storeElement);

      logger.info(
        `Supercheap Auto ${this.storeName} result found: ` +
          `${JSON.stringify(storeDetails)}`
      );

      this.validateStoreDetails(storeDetails);

      await storeElement.scrollIntoViewIfNeeded();
      await storeElement.click({
        timeout: 10000,
      });

      await this.waitForStoreSelection(page);

      await this.confirmStoreSelection(page);

      /*
       * Product fulfilment normally updates through AJAX.
       */
      await page.waitForTimeout(2500);

      await page
        .waitForLoadState('domcontentloaded', {
          timeout: 10000,
        })
        .catch(() => {
          // AJAX-only update is valid.
        });

      /*
       * If the site accidentally submitted the global search form,
       * restore the product page.
       */
      await this.restoreProductPage(page, productUrl);

      logger.info(
        `Supercheap Auto store selection completed for ${this.storeName}`
      );
    } catch (error) {
      logger.warn(
        `Supercheap Auto store selection failed for ${this.storeName}. ` +
          `Store availability may be incomplete: ${
            error instanceof Error ? error.message : String(error)
          }`
      );

      /*
       * Store selection failure should not prevent product price/name/SKU
       * extraction. However, we must never continue on a search-results page.
       */
      await this.restoreProductPage(page, productUrl);
    }
  }

  /**
   * Open the product-page store selector.
   */
  private async openStoreSelector(page: Page): Promise<void> {
    const changeStoreButton = page
      .locator(
        [
          'button:has-text("Change store")',
          'a:has-text("Change store")',
          'button:has-text("Change Store")',
          'a:has-text("Change Store")',
          '[class*="change-store" i]:has-text("Change store")',
          '[class*="change-location" i]:has-text("Change store")',
        ].join(', ')
      )
      .first();

    const changeStoreVisible = await changeStoreButton
      .isVisible({ timeout: 10000 })
      .catch(() => false);

    if (changeStoreVisible) {
      logger.debug(
        'Clicking Supercheap Auto product-page Change store control'
      );

      await changeStoreButton.click({
        timeout: 10000,
      });
    } else {
      logger.debug(
        'Product-page Change store control was not visible. ' +
          'Checking fulfilment Change control directly'
      );
    }

    /*
     * Expected fulfilment control:
     *
     * #change-preferred-store-button
     */
    const changePreferredStoreButton = page.locator(
      '#change-preferred-store-button'
    );

    const changePreferredStoreVisible =
      await changePreferredStoreButton
        .isVisible({ timeout: 10000 })
        .catch(() => false);

    if (changePreferredStoreVisible) {
      logger.debug(
        'Clicking #change-preferred-store-button'
      );

      await changePreferredStoreButton.click({
        timeout: 10000,
      });
    }
  }

  /**
   * Locate the postcode/suburb input belonging to the store selector.
   */
  private async findStorePostcodeInput(page: Page) {
    const postcodeInput = page
      .locator(
        [
          '.fulfilment-store-selector input[placeholder*="postcode" i]',
          '.fulfilment-store-selector input[placeholder*="suburb" i]',
          '.fulfilment-store-modal input[placeholder*="postcode" i]',
          '.fulfilment-store-modal input[placeholder*="suburb" i]',
          '.store-locator-modal input[placeholder*="postcode" i]',
          '.store-locator-modal input[placeholder*="suburb" i]',
          '.store-selection-modal input[placeholder*="postcode" i]',
          '.store-selection-modal input[placeholder*="suburb" i]',
          '[class*="fulfilment" i] input[placeholder*="postcode" i]',
          '[class*="fulfilment" i] input[placeholder*="suburb" i]',
          '[class*="store-locator" i] input[placeholder*="postcode" i]',
          '[class*="store-locator" i] input[placeholder*="suburb" i]',
          'input[placeholder*="postcode or suburb" i]:not([name="q"])',
          'input[placeholder*="suburb or postcode" i]:not([name="q"])',
          'input[placeholder*="postcode" i]:not([name="q"])',
          'input[name*="postcode" i]:not([name="q"])',
          'input[name*="postal" i]:not([name="q"])',
          'input[id*="postcode" i]:not([name="q"])',
          'input[id*="postal" i]:not([name="q"])',
        ].join(', ')
      )
      .first();

    await postcodeInput.waitFor({
      state: 'visible',
      timeout: 15000,
    });

    return postcodeInput;
  }

  /**
   * Search for stores after entering the postcode.
   *
   * We intentionally do NOT press Enter because Enter previously caused
   * the global product search to navigate to /search?q=0627.
   */
  private async searchForStore(page: Page): Promise<void> {
    const storeSearchButton = page
      .locator(
        [
          '.fulfilment-store-selector button:has-text("Search")',
          '.fulfilment-store-modal button:has-text("Search")',
          '.store-locator-modal button:has-text("Search")',
          '.store-selection-modal button:has-text("Search")',
          '[class*="fulfilment" i] button:has-text("Search")',
          '[class*="store-locator" i] button:has-text("Search")',
          'button[aria-label*="search store" i]',
          'button:has-text("Find Stores")',
          'button:has-text("Find stores")',
        ].join(', ')
      )
      .first();

    const visible = await storeSearchButton
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    if (visible) {
      logger.debug(
        'Clicking the dedicated store-search button'
      );

      await storeSearchButton.click({
        timeout: 10000,
      });
    } else {
      logger.debug(
        'No dedicated store-search button found. ' +
          'Waiting for automatic store-result refresh'
      );
    }
  }

  /**
   * Locate the exact configured store.
   */
  private async findConfiguredStore(page: Page) {
    const store = page
      .locator(
        [
          `.fulfilment-store-item[data-id="${this.storeId}"]`,
          `.fulfilment-store-item[data-preferred-id="${this.storeId}"]`,
          `.fulfilment-store-item[data-name="${this.storeName}"]`,
          `.fulfilment-store-item:has(.store-name:text-is("${this.storeName}"))`,
        ].join(', ')
      )
      .first();

    await store.waitFor({
      state: 'visible',
      timeout: 20000,
    });

    return store;
  }

  /**
   * Extract diagnostic information from a store element.
   */
  private async getStoreDetails(storeElement: any) {
    return storeElement.evaluate((element: HTMLElement) => {
      const clean = (value: string | null | undefined): string | null => {
        if (!value) {
          return null;
        }

        const result = value
          .replace(/\u00a0/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        return result || null;
      };

      return {
        storeName:
          element.getAttribute('data-name') ||
          clean(
            element.querySelector('.store-name')?.textContent
          ),

        storeAddress: clean(
          element.querySelector('.store-address')?.textContent
        ),

        storeDistance: clean(
          element.querySelector('.store-distance')?.textContent
        ),

        stockStatus: clean(
          element.querySelector('.stock-status')?.textContent
        ),

        dataId: element.getAttribute('data-id'),

        dataPreferredId:
          element.getAttribute('data-preferred-id'),

        className: element.className,
      };
    });
  }

  /**
   * Verify that the result really is the configured store.
   */
  private validateStoreDetails(storeDetails: {
    storeName: string | null;
    dataId: string | null;
    dataPreferredId: string | null;
  }): void {
    const matchesStore =
      storeDetails.dataId === this.storeId ||
      storeDetails.dataPreferredId === this.storeId ||
      storeDetails.storeName === this.storeName;

    if (!matchesStore) {
      throw new Error(
        `Unexpected store result selected: ${JSON.stringify(
          storeDetails
        )}`
      );
    }
  }

  /**
   * Wait until the selected store is marked as checked.
   */
  private async waitForStoreSelection(page: Page): Promise<void> {
    const checkedStore = page
      .locator(
        [
          `.fulfilment-store-item.checked[data-id="${this.storeId}"]`,
          `.fulfilment-store-item.checked[data-preferred-id="${this.storeId}"]`,
          `.fulfilment-store-item.checked[data-name="${this.storeName}"]`,
        ].join(', ')
      )
      .first();

    await checkedStore.waitFor({
      state: 'visible',
      timeout: 10000,
    });

    logger.debug(
      `${this.storeName} is marked as selected in the store result list`
    );
  }

  /**
   * Confirm the selected store.
   */
  private async confirmStoreSelection(page: Page): Promise<void> {
    const confirmButton = page
      .locator(
        [
          `button.fulfilment-cta[data-selected-id="${this.storeId}"]`,
          `button.fulfilment-cta[data-preferred-id="${this.storeId}"]`,
          'button.fulfilment-cta:has-text("Confirm")',
        ].join(', ')
      )
      .first();

    await confirmButton.waitFor({
      state: 'visible',
      timeout: 10000,
    });

    const details = await confirmButton.evaluate(
      (element: HTMLElement) => ({
        text:
          element.textContent?.replace(/\s+/g, ' ').trim() ||
          null,

        selectedId:
          element.getAttribute('data-selected-id'),

        preferredId:
          element.getAttribute('data-preferred-id'),
      })
    );

    logger.debug(
      `Supercheap Auto confirmation button: ${JSON.stringify(
        details
      )}`
    );

    await confirmButton.click({
      timeout: 10000,
    });
  }

  /**
   * Validate that we are still on a product page.
   */
  private async validateProductPage(
    page: Page,
    expectedProductUrl: string
  ): Promise<void> {
    const currentUrl = page.url();

    if (this.isSearchResultsUrl(currentUrl)) {
      throw new Error(
        `Supercheap Auto extraction aborted because the browser ` +
          `is on a search-results page instead of the product page. ` +
          `Current URL: ${currentUrl}; expected product URL: ${expectedProductUrl}`
      );
    }

    const pageHeading = await page
      .locator('h1')
      .first()
      .textContent({
        timeout: 10000,
      })
      .catch(() => null);

    const cleanedHeading =
      pageHeading?.replace(/\s+/g, ' ').trim() || null;

    if (
      cleanedHeading &&
      /product search results/i.test(cleanedHeading)
    ) {
      throw new Error(
        `Supercheap Auto extraction aborted because the page ` +
          `heading is "${cleanedHeading}" instead of a product name`
      );
    }
  }

  /**
   * Extract product data from the rendered product page.
   */
  private async extractProduct(
    page: Page
  ): Promise<ExtractedProduct> {
    return page.evaluate(
      ({
        expectedStoreName,
        expectedStoreId,
      }): ExtractedProduct => {
        type Availability =
          | 'in_stock'
          | 'out_of_stock'
          | 'check_availability'
          | 'unknown';

        /**
         * Normalize text.
         */
        const cleanText = (
          value: string | null | undefined
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

        /**
         * Parse a price safely.
         */
        const parsePrice = (
          value: string | null | undefined
        ): number | null => {
          if (!value) {
            return null;
          }

          const text = value
            .replace(/\u00a0/g, ' ')
            .replace(/,/g, '')
            .trim();

          /*
           * Prefer a currency-prefixed price when present.
           */
          const currencyMatch = text.match(
            /(?:NZD|NZ|\$)\s*(\d+(?:\.\d{1,2})?)/
          );

          if (currencyMatch) {
            const parsed = Number(currencyMatch[1]);

            return Number.isFinite(parsed)
              ? parsed
              : null;
          }

          /*
           * Fallback for plain numeric price attributes.
           */
          const numericMatch = text.match(
            /^\s*(\d+(?:\.\d{1,2})?)\s*$/
          );

          if (!numericMatch) {
            return null;
          }

          const parsed = Number(numericMatch[1]);

          return Number.isFinite(parsed)
            ? parsed
            : null;
        };

        /**
         * Get text from a selector.
         */
        const getText = (
          selector: string
        ): string | null => {
          const element =
            document.querySelector(selector);

          return cleanText(element?.textContent);
        };

        /**
         * Get an attribute from a selector.
         */
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

        /**
         * Try multiple selectors and return the first successful result.
         */
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

        const diagnostics: ExtractionDiagnostics = {
          nameSource: null,
          skuSource: null,
          priceSource: null,
          originalPriceSource: null,
          saleEndDateSource: null,
          storeSource: null,
          availabilitySource: null,
          storeAvailabilitySource: null,
        };

        /*
         * -------------------------------------------------------------
         * PRODUCT NAME
         * -------------------------------------------------------------
         */

        let name: string | null = null;

        /*
         * First try pageContext.title because it is generally more
         * specific than document.title.
         */
        const scripts = Array.from(
          document.querySelectorAll('script')
        );

        for (const script of scripts) {
          const text = script.textContent || '';

          const pageContextMatch = text.match(
            /pageContext\s*=\s*({[\s\S]*?});/
          );

          if (!pageContextMatch) {
            continue;
          }

          try {
            const parsed = JSON.parse(
              pageContextMatch[1]
            );

            if (parsed?.title) {
              name = cleanText(
                String(parsed.title)
              );

              diagnostics.nameSource =
                'JS:pageContext.title';

              break;
            }
          } catch {
            // Ignore malformed pageContext objects.
          }
        }

        /*
         * DOM fallback.
         */
        if (!name) {
          const nameResult = getFirstText([
            'h1[itemprop="name"]',
            '[itemprop="name"]',
            'h1.product-name',
            'h1[class*="product-name" i]',
            'h1[class*="product-title" i]',
            'h1',
          ]);

          if (nameResult.value) {
            name = nameResult.value;
            diagnostics.nameSource =
              `DOM:${nameResult.selector}`;
          }
        }

        /*
         * Final fallback.
         */
        if (!name) {
          const title = cleanText(document.title);

          if (title) {
            name = title
              .replace(
                /\s*\|\s*Supercheap Auto New Zealand\s*$/i,
                ''
              )
              .trim();

            diagnostics.nameSource =
              'document.title';
          }
        }

        /*
         * Never return the search-results heading as a product name.
         */
        if (
          name &&
          /product search results/i.test(name)
        ) {
          name = null;
          diagnostics.nameSource = null;
        }

        /*
         * -------------------------------------------------------------
         * SKU / ITEM NUMBER
         * -------------------------------------------------------------
         */

        let sku: string | null = null;

        const productIdMeta =
          getAttribute(
            'meta[itemprop="productID"]',
            'content'
          ) ||
          getAttribute(
            'meta[itemprop="sku"]',
            'content'
          );

        if (productIdMeta) {
          sku = productIdMeta;
          diagnostics.skuSource =
            'META:itemprop=productID/sku';
        }

        if (!sku) {
          const masterIdElement =
            document.querySelector('[data-masterid]');

          const dataMasterId = cleanText(
            masterIdElement?.getAttribute(
              'data-masterid'
            )
          );

          if (dataMasterId) {
            sku = dataMasterId;
            diagnostics.skuSource =
              'DOM:data-masterid';
          }
        }

        if (!sku) {
          const productNumberResult =
            getFirstText([
              '.product-number',
              '[class*="product-number" i]',
              '[class*="product-code" i]',
              '[class*="item-number" i]',
              '[class*="sku" i]',
            ]);

          const productNumberText =
            productNumberResult.value;

          const productNumberMatch =
            productNumberText?.match(
              /(?:Item\s*No\.?|SKU|Product\s*Code)\s*:?\s*([A-Z0-9._-]+)/i
            );

          if (productNumberMatch) {
            sku = productNumberMatch[1];

            diagnostics.skuSource =
              `TEXT:${productNumberResult.selector}`;
          }
        }

        /*
         * -------------------------------------------------------------
         * CURRENT PRICE
         * -------------------------------------------------------------
         */

        let price: number | null = null;

        const priceSelectors = [
          '.price-sales .promo-price',
          '.promo-price',
          '.price-sales',
          '[class*="promo-price" i]',
          '[class*="sale-price" i]',
          '[class*="price-sales" i]',
          '[itemprop="price"]',
        ];

        for (const selector of priceSelectors) {
          const element =
            document.querySelector(selector);

          if (!element) {
            continue;
          }

          const attributePrice =
            element.getAttribute('content');

          const candidate = parsePrice(
            attributePrice ||
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
         * -------------------------------------------------------------
         * ORIGINAL / WAS PRICE
         * -------------------------------------------------------------
         */

        let originalPrice: number | null = null;

        const originalPriceSelectors = [
          '.price-standard .stroke-content',
          '.price-standard',
          '.was-label',
          '[class*="price-standard" i]',
          '[class*="stroke-content" i]',
          '[class*="was-price" i]',
          '[class*="original-price" i]',
        ];

        for (const selector of originalPriceSelectors) {
          const candidate =
            parsePrice(getText(selector));

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

        /*
         * Text fallback:
         *
         * "Was $XX.XX"
         */
        if (originalPrice === null) {
          const bodyText =
            cleanText(document.body?.innerText) || '';

          const wasMatch = bodyText.match(
            /\bWas\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i
          );

          if (wasMatch) {
            const candidate =
              parsePrice(wasMatch[1]);

            if (
              candidate !== null &&
              (price === null || candidate > price)
            ) {
              originalPrice = candidate;

              diagnostics.originalPriceSource =
                'TEXT:Was';
            }
          }
        }

        /*
         * -------------------------------------------------------------
         * SALE END DATE
         * -------------------------------------------------------------
         */

        let saleEndDate: string | null = null;

        const saleEndResult =
          getFirstText([
            '.saleprice-end-date',
            '[class*="saleprice-end-date" i]',
            '[class*="sale-end-date" i]',
            '[class*="promotion-end" i]',
            '[class*="promo-end" i]',
          ]);

        if (saleEndResult.value) {
          const dateMatch =
            saleEndResult.value.match(
              /(\d{1,2}\/\d{1,2}\/\d{2,4})/
            );

          saleEndDate = dateMatch
            ? dateMatch[1]
            : saleEndResult.value;

          diagnostics.saleEndDateSource =
            `DOM:${saleEndResult.selector}`;
        }

        /*
         * -------------------------------------------------------------
         * GENERAL PRODUCT AVAILABILITY
         * -------------------------------------------------------------
         */

        let availability: Availability =
          'unknown';

        const productArea =
          document.querySelector(
            '[class*="product-detail" i]'
          ) ||
          document.querySelector(
            '[class*="product-info" i]'
          ) ||
          document.querySelector('main');

        const productAreaText =
          cleanText(productArea?.textContent) || '';

        const addToCartElement =
          Array.from(
            document.querySelectorAll('button, a')
          ).find((element) => {
            const text =
              cleanText(element.textContent) || '';

            return /\badd\s+to\s+cart\b/i.test(text);
          });

        /*
         * Check explicit unavailable states first.
         */
        if (
          /\bcurrently\s+unavailable\b/i.test(
            productAreaText
          ) ||
          /\bout\s+of\s+stock\b/i.test(
            productAreaText
          ) ||
          /\bnot\s+available\b/i.test(
            productAreaText
          ) ||
          /\bnot\s+stocked\b/i.test(
            productAreaText
          )
        ) {
          availability = 'out_of_stock';

          diagnostics.availabilitySource =
            'TEXT:product-area-unavailable';
        } else if (addToCartElement) {
          availability = 'in_stock';

          diagnostics.availabilitySource =
            'DOM:Add-to-Cart';
        } else if (
          /\bin\s+stock\b/i.test(
            productAreaText
          ) ||
          /\bpick\s+up\s+today\b/i.test(
            productAreaText
          )
        ) {
          availability = 'in_stock';

          diagnostics.availabilitySource =
            'TEXT:product-area-in-stock';
        } else if (
          /\bcheck\s+availability\b/i.test(
            productAreaText
          )
        ) {
          availability =
            'check_availability';

          diagnostics.availabilitySource =
            'TEXT:check-availability';
        }

        /*
         * -------------------------------------------------------------
         * STORE-SPECIFIC AVAILABILITY
         * -------------------------------------------------------------
         */

        let store: string | null = null;

        let storeAvailability: Availability =
          'unknown';

        const storeItems = Array.from(
          document.querySelectorAll(
            '.fulfilment-store-item'
          )
        );

        /*
         * Prefer an explicitly checked Wairau Park store.
         */
        const selectedStoreElement =
          document.querySelector(
            `.fulfilment-store-item.checked[data-id="${expectedStoreId}"]`
          ) ||
          document.querySelector(
            `.fulfilment-store-item.checked[data-preferred-id="${expectedStoreId}"]`
          ) ||
          document.querySelector(
            `.fulfilment-store-item.checked[data-name="${expectedStoreName}"]`
          ) ||

          /*
           * Then allow an explicitly matching store that is
           * present but not marked checked.
           */
          document.querySelector(
            `.fulfilment-store-item[data-id="${expectedStoreId}"]`
          ) ||
          document.querySelector(
            `.fulfilment-store-item[data-preferred-id="${expectedStoreId}"]`
          ) ||
          document.querySelector(
            `.fulfilment-store-item[data-name="${expectedStoreName}"]`
          ) ||

          /*
           * Finally match by store name.
           */
          storeItems.find((element) => {
            const itemStoreName =
              cleanText(
                element.getAttribute(
                  'data-name'
                ) ||
                  element.querySelector(
                    '.store-name'
                  )?.textContent
              );

            return (
              itemStoreName?.toLowerCase() ===
              expectedStoreName.toLowerCase()
            );
          }) ||
          null;

        if (selectedStoreElement) {
          const selectedStoreName =
            cleanText(
              selectedStoreElement.getAttribute(
                'data-name'
              ) ||
                selectedStoreElement.querySelector(
                  '.store-name'
                )?.textContent
            );

          if (selectedStoreName) {
            store = selectedStoreName;

            diagnostics.storeSource =
              'DOM:.fulfilment-store-item';
          }

          const stockStatusElement =
            selectedStoreElement.querySelector(
              '.stock-status'
            );

          const stockStatusText =
            cleanText(
              stockStatusElement?.textContent
            );

          if (
            stockStatusElement?.classList.contains(
              'available'
            ) ||
            /\bin\s+stock\b/i.test(
              stockStatusText || ''
            )
          ) {
            storeAvailability =
              'in_stock';

            diagnostics.storeAvailabilitySource =
              'DOM:.fulfilment-store-item .stock-status.available';
          } else if (
            stockStatusElement?.classList.contains(
              'unavailable'
            ) ||
            stockStatusElement?.classList.contains(
              'not-available'
            ) ||
            /\bno\s+stock\b/i.test(
              stockStatusText || ''
            ) ||
            /\bout\s+of\s+stock\b/i.test(
              stockStatusText || ''
            ) ||
            /\bunavailable\b/i.test(
              stockStatusText || ''
            ) ||
            /\bnot\s+available\b/i.test(
              stockStatusText || ''
            )
          ) {
            storeAvailability =
              'out_of_stock';

            diagnostics.storeAvailabilitySource =
              'DOM:.fulfilment-store-item .stock-status.unavailable';
          } else if (stockStatusText) {
            storeAvailability =
              'check_availability';

            diagnostics.storeAvailabilitySource =
              'DOM:.fulfilment-store-item unrecognised stock status';
          }
        }

        /*
         * -------------------------------------------------------------
         * SELECTED PRODUCT FULFILMENT FALLBACK
         * -------------------------------------------------------------
         *
         * After confirmation, the store list may be hidden or removed.
         */

        if (
          !store ||
          storeAvailability === 'unknown'
        ) {
          const fulfilmentElements =
            Array.from(
              document.querySelectorAll(
                [
                  '[class*="fulfilment" i]',
                  '[class*="fulfillment" i]',
                  '[class*="selected-store" i]',
                  '[class*="preferred-store" i]',
                  '[class*="pickup" i]',
                  '[class*="click-collect" i]',
                ].join(', ')
              )
            );

          const matchingFulfilmentElements =
            fulfilmentElements.filter(
              (element) => {
                const text =
                  cleanText(
                    element.textContent
                  ) || '';

                return text
                  .toLowerCase()
                  .includes(
                    expectedStoreName.toLowerCase()
                  );
              }
            );

          /*
           * Prefer the smallest matching container.
           */
          matchingFulfilmentElements.sort(
            (first, second) => {
              const firstLength =
                cleanText(
                  first.textContent
                )?.length ??
                Number.MAX_SAFE_INTEGER;

              const secondLength =
                cleanText(
                  second.textContent
                )?.length ??
                Number.MAX_SAFE_INTEGER;

              return (
                firstLength - secondLength
              );
            }
          );

          const fulfilmentElement =
            matchingFulfilmentElements[0] ||
            null;

          const fulfilmentText =
            cleanText(
              fulfilmentElement?.textContent
            );

          if (fulfilmentText) {
            store = expectedStoreName;

            diagnostics.storeSource =
              'DOM:selected-product-fulfilment-section';

            const explicitlyUnavailable =
              /\bunavailable\b/i.test(
                fulfilmentText
              ) ||
              /\bnot\s+available\b/i.test(
                fulfilmentText
              ) ||
              /\bout\s+of\s+stock\b/i.test(
                fulfilmentText
              ) ||
              /\bno\s+stock\b/i.test(
                fulfilmentText
              );

            const explicitlyAvailable =
              /\bin\s+stock\b/i.test(
                fulfilmentText
              ) ||
              /\bpick\s+up\s+today\b/i.test(
                fulfilmentText
              ) ||
              /\bavailable\b/i.test(
                fulfilmentText
              );

            if (
              explicitlyAvailable &&
              !explicitlyUnavailable
            ) {
              storeAvailability =
                'in_stock';

              diagnostics.storeAvailabilitySource =
                'TEXT:selected-fulfilment-section-in-stock';
            } else if (
              explicitlyUnavailable
            ) {
              storeAvailability =
                'out_of_stock';

              diagnostics.storeAvailabilitySource =
                'TEXT:selected-fulfilment-section-unavailable';
            } else {
              storeAvailability =
                'check_availability';

              diagnostics.storeAvailabilitySource =
                'TEXT:selected-fulfilment-section';
            }
          }
        }

        /*
         * -------------------------------------------------------------
         * HEADER STORE FALLBACK
         * -------------------------------------------------------------
         *
         * Only accept a header store if it explicitly contains the
         * expected store name.
         */

        if (!store) {
          const storeSelectors = [
            '.my-store-link',
            '.header-session .my-store-link',
            '[class*="selected-store" i]',
            '[class*="preferred-store" i]',
          ];

          for (const selector of storeSelectors) {
            const value = getText(selector);

            if (
              value &&
              value
                .toLowerCase()
                .includes(
                  expectedStoreName.toLowerCase()
                )
            ) {
              store = expectedStoreName;

              diagnostics.storeSource =
                `DOM:${selector}`;

              break;
            }
          }
        }

        /*
         * -------------------------------------------------------------
         * STORE AVAILABILITY FALLBACK
         * -------------------------------------------------------------
         *
         * Only use general product availability if the expected store
         * itself has already been confirmed.
         */

        if (
          store === expectedStoreName &&
          storeAvailability === 'unknown' &&
          availability !== 'unknown'
        ) {
          storeAvailability =
            availability;

          diagnostics.storeAvailabilitySource =
            'FALLBACK:confirmed-store-plus-product-availability';
        }

        /*
         * -------------------------------------------------------------
         * CANONICAL URL
         * -------------------------------------------------------------
         */

        const canonicalUrl =
          getAttribute(
            'link[rel="canonical"]',
            'href'
          ) ||
          window.location.href;

        return {
          name,
          sku,
          price,
          originalPrice,
          saleEndDate,
          availability,
          storeAvailability,
          store,
          canonicalUrl,
          diagnostics,
        };
      },
      {
        expectedStoreName: this.storeName,
        expectedStoreId: this.storeId,
      }
    );
  }

  /**
   * Main product scraping method.
   */
  async scrapeProduct(
    url: string
  ): Promise<SupercheapAutoScrapedProduct> {
    let page: Page | null = null;

    try {
      await browserService.initialize();

      page = await browserService.createPage();

      logger.info(
        `Scraping Supercheap Auto product: ${url} ` +
          `using store ${this.storeName} (${this.postalCode})`
      );

      /*
       * -------------------------------------------------------------
       * INITIAL PRODUCT NAVIGATION
       * -------------------------------------------------------------
       */

      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: this.navigationTimeout,
      });

      /*
       * Store the final URL after initial navigation because the
       * website may redirect to a canonical product URL.
       */
      const productPageUrl = page.url();

      if (
        this.isSearchResultsUrl(
          productPageUrl
        )
      ) {
        throw new Error(
          `The supplied Supercheap Auto URL resolved to a ` +
            `search-results page instead of a product page: ` +
            `${productPageUrl}`
        );
      }

      /*
       * Allow the initial product page to render.
       */
      await page.waitForTimeout(1500);

      /*
       * -------------------------------------------------------------
       * STORE SELECTION
       * -------------------------------------------------------------
       */

      await this.ensureStoreSelected(
        page,
        productPageUrl
      );

      /*
       * Do not require networkidle because ecommerce pages often
       * keep analytics / tracking connections open indefinitely.
       */
      try {
        await page.waitForLoadState(
          'networkidle',
          {
            timeout: 5000,
          }
        );
      } catch {
        logger.debug(
          `Supercheap Auto networkidle timeout for ${url}; ` +
            `continuing with the rendered product page`
        );
      }

      await page.waitForTimeout(2000);

      /*
       * Make absolutely sure that store-selection interactions did
       * not leave us on a search page.
       */
      await this.validateProductPage(
        page,
        productPageUrl
      );

      /*
       * -------------------------------------------------------------
       * PRODUCT EXTRACTION
       * -------------------------------------------------------------
       */

      const product =
        await this.extractProduct(page);

      logger.info(
        `Supercheap Auto extraction result for ${url}: ` +
          `${JSON.stringify({
            finalPageUrl: page.url(),
            name: product.name,
            sku: product.sku,
            price: product.price,
            originalPrice: product.originalPrice,
            saleEndDate: product.saleEndDate,
            availability: product.availability,
            storeAvailability:
              product.storeAvailability,
            store: product.store,
            diagnostics:
              product.diagnostics,
          })}`
      );

      /*
       * -------------------------------------------------------------
       * WARNINGS
       * -------------------------------------------------------------
       */

      if (!product.name) {
        logger.warn(
          `Supercheap Auto product name could not be extracted for ${url}`
        );
      }

      if (!product.sku) {
        logger.warn(
          `Supercheap Auto item number could not be extracted for ${url}`
        );
      }

      if (product.price === null) {
        logger.warn(
          `Supercheap Auto price could not be extracted for ${url}`
        );
      }

      if (!product.store) {
        logger.warn(
          `Supercheap Auto could not confirm the selected store ` +
            `for ${url}`
        );
      } else if (
        product.store.toLowerCase() !==
        this.storeName.toLowerCase()
      ) {
        logger.warn(
          `Supercheap Auto returned store "${product.store}" ` +
            `instead of "${this.storeName}"`
        );
      }

      if (
        product.storeAvailability ===
        'unknown'
      ) {
        logger.warn(
          `Supercheap Auto store availability for ` +
            `${this.storeName} could not be determined for ${url}`
        );
      }

      /*
       * Final page validation.
       */
      await this.validateProductPage(
        page,
        productPageUrl
      );

      /*
       * -------------------------------------------------------------
       * RETURN NORMALISED PRODUCT
       * -------------------------------------------------------------
       */

      return {
        site: 'supercheapauto',
        url:
          product.canonicalUrl ||
          page.url(),

        name: product.name,
        sku: product.sku,

        price: product.price,
        originalPrice:
          product.originalPrice,

        saleEndDate:
          product.saleEndDate,

        currency: 'NZD',

        availability:
          product.availability,

        storeAvailability:
          product.storeAvailability,

        store:
          product.store ||
          this.storeName,

        postalCode:
          this.postalCode,

        scrapedAt:
          new Date().toISOString(),
      };
    } catch (error) {
      logger.error(
        `Supercheap Auto scraping failed for ${url}:`,
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

export const supercheapAutoAdapter =
  new SupercheapAutoAdapter();
