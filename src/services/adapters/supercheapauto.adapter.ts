import { Page, Locator } from 'playwright';
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
}

interface ExtractedProduct {
  name: string | null;
  sku: string | null;
  price: number | null;
  originalPrice: number | null;
  saleEndDate: string | null;
  availability: Availability;
  store: string | null;
  canonicalUrl: string;
  diagnostics: ExtractionDiagnostics;
}

interface StoreProductData {
  available?: string[];
  unavailable?: string[];
  specialProduct?: string[];
  lowStock?: string[];
}

export class SupercheapAutoAdapter
  implements ProductScraperAdapter
{
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
   * Detect Supercheap Auto search-result pages.
   *
   * This is important because entering the postcode into the wrong
   * search box previously caused navigation to:
   *
   * /search?q=0627
   */
  private isSearchResultsUrl(url: string): boolean {
    try {
      const parsedUrl = new URL(url);

      return (
        parsedUrl.pathname === '/search' ||
        parsedUrl.pathname.startsWith('/search/')
      );
    } catch {
      return (
        url.includes('/search?') ||
        url.includes('/search/')
      );
    }
  }

  /**
   * Restore the product page if store selection accidentally
   * navigates to the global search page.
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
   * Open the Supercheap Auto store selector.
   */
  private async openStoreSelector(
    page: Page
  ): Promise<void> {
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

    const visible = await changeStoreButton
      .isVisible({ timeout: 10000 })
      .catch(() => false);

    if (visible) {
      logger.debug(
        'Clicking Supercheap Auto Change store control'
      );

      await changeStoreButton.click({
        timeout: 10000,
      });
    }

    /*
     * Some versions of the page expose a second Change button
     * inside the fulfilment panel.
     */
    const preferredStoreButton = page.locator(
      '#change-preferred-store-button'
    );

    const preferredVisible =
      await preferredStoreButton
        .isVisible({ timeout: 10000 })
        .catch(() => false);

    if (preferredVisible) {
      logger.debug(
        'Clicking #change-preferred-store-button'
      );

      await preferredStoreButton.click({
        timeout: 10000,
      });
    }
  }

  /**
   * Find the store postcode/suburb input.
   *
   * IMPORTANT:
   * Do not use input[type="search"] or input[name="q"].
   */
  private async findStorePostcodeInput(
    page: Page
  ): Promise<Locator> {
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

    const details = await postcodeInput.evaluate(
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
        details
      )}`
    );

    /*
     * Never accidentally use the global product-search field.
     */
    if (
      details.name?.toLowerCase() === 'q' ||
      /search products|what are you looking for/i.test(
        details.placeholder || ''
      )
    ) {
      throw new Error(
        `Selected input appears to be the global product-search input: ` +
          `${JSON.stringify(details)}`
      );
    }

    return postcodeInput;
  }

  /**
   * Search for the requested store.
   */
  private async searchForStore(
    page: Page
  ): Promise<void> {
    const searchButton = page
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

    const visible = await searchButton
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    if (visible) {
      logger.debug(
        'Clicking Supercheap Auto store search button'
      );

      await searchButton.click({
        timeout: 10000,
      });
    } else {
      logger.debug(
        'No dedicated store search button found. ' +
          'Waiting for automatic store-result refresh.'
      );
    }
  }

  /**
   * Find Wairau Park.
   *
   * Support both the old fulfilment-store-item markup and the
   * actual markup shown in the supplied HTML:
   *
   * .store-item[data-store-id="7030"]
   */
  private async findConfiguredStore(
    page: Page
  ): Promise<Locator> {
    const store = page
      .locator(
        [
          /*
           * CURRENT Supercheap Auto markup
           */
          `.store-item[data-store-id="${this.storeId}"]`,

          /*
           * Possible alternative/current markup
           */
          `.store-item[data-id="${this.storeId}"]`,
          `.store-item[data-preferred-id="${this.storeId}"]`,

          /*
           * Older fulfilment markup
           */
          `.fulfilment-store-item[data-id="${this.storeId}"]`,
          `.fulfilment-store-item[data-preferred-id="${this.storeId}"]`,
          `.fulfilment-store-item[data-store-id="${this.storeId}"]`,

          /*
           * Name-based fallback
           */
          `.store-item[data-name="${this.storeName}"]`,
          `.fulfilment-store-item[data-name="${this.storeName}"]`,

          `.store-item:has(.store-name:text-is("${this.storeName}"))`,
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
   * Validate that the store element really belongs to Wairau Park.
   */
  private async validateConfiguredStore(
    store: Locator
  ): Promise<void> {
    const details = await store.evaluate(
      (element: HTMLElement) => ({
        storeId:
          element.getAttribute('data-store-id') ||
          element.getAttribute('data-id'),

        preferredId:
          element.getAttribute('data-preferred-id'),

        storeName:
          element.getAttribute('data-name') ||
          element.querySelector(
            '.store-name'
          )?.textContent?.replace(/\s+/g, ' ').trim() ||
          element.querySelector(
            '.my-store-name'
          )?.textContent?.replace(/\s+/g, ' ').trim() ||
          null,

        status:
          element.getAttribute('data-status'),

        className:
          element.className,
      })
    );

    logger.info(
      `Supercheap Auto configured store found: ${JSON.stringify(
        details
      )}`
    );

    const matchesId =
      details.storeId === this.storeId ||
      details.preferredId === this.storeId;

    const matchesName =
      details.storeName
        ?.toLowerCase()
        .includes(
          this.storeName.toLowerCase()
        );

    if (!matchesId && !matchesName) {
      throw new Error(
        `Unexpected Supercheap Auto store returned: ` +
          `${JSON.stringify(details)}`
      );
    }
  }

  /**
   * Wait for the store to be selected.
   *
   * The current HTML uses:
   *
   * .store-item[data-store-id="7030"]
   *
   * and may add classes such as "selected".
   *
   * We don't make the "selected" class mandatory because the page
   * can update the store information through AJAX without changing
   * the class immediately.
   */
  private async waitForStoreSelection(
    page: Page
  ): Promise<void> {
    const store = page.locator(
      [
        `.store-item[data-store-id="${this.storeId}"]`,
        `.store-item[data-id="${this.storeId}"]`,
        `.fulfilment-store-item[data-id="${this.storeId}"]`,
        `.fulfilment-store-item[data-preferred-id="${this.storeId}"]`,
      ].join(', ')
    ).first();

    await store.waitFor({
      state: 'visible',
      timeout: 10000,
    });

    logger.debug(
      `${this.storeName} store element remains visible after selection`
    );
  }

  /**
   * Confirm the selected store.
   *
   * Support the known fulfilment CTA as well as common alternatives.
   */
  private async confirmStoreSelection(
    page: Page
  ): Promise<void> {
    const confirmButton = page
      .locator(
        [
          `button.fulfilment-cta[data-selected-id="${this.storeId}"]`,
          `button.fulfilment-cta[data-preferred-id="${this.storeId}"]`,
          'button.fulfilment-cta:has-text("Confirm")',
          'button:has-text("Confirm")',
        ].join(', ')
      )
      .first();

    const visible = await confirmButton
      .isVisible({ timeout: 10000 })
      .catch(() => false);

    /*
     * Some versions may automatically select the store and not show
     * a confirmation button.
     */
    if (!visible) {
      logger.debug(
        'No visible store confirmation button found. ' +
          'Assuming store selection was automatic.'
      );

      return;
    }

    const details = await confirmButton.evaluate(
      (element: HTMLElement) => ({
        text:
          element.textContent
            ?.replace(/\s+/g, ' ')
            .trim() || null,

        selectedId:
          element.getAttribute(
            'data-selected-id'
          ),

        preferredId:
          element.getAttribute(
            'data-preferred-id'
          ),
      })
    );

    logger.debug(
      `Supercheap Auto store confirmation button: ${JSON.stringify(
        details
      )}`
    );

    await confirmButton.click({
      timeout: 10000,
    });
  }

  /**
   * Select the configured Supercheap Auto store.
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

      const postcodeInput =
        await this.findStorePostcodeInput(page);

      await postcodeInput.fill('');
      await postcodeInput.fill(
        this.postalCode
      );

      /*
       * DO NOT press Enter.
       */
      await this.searchForStore(page);

      const store =
        await this.findConfiguredStore(page);

      await this.validateConfiguredStore(
        store
      );

      await store.scrollIntoViewIfNeeded();

      await store.click({
        timeout: 10000,
      });

      await this.waitForStoreSelection(
        page
      );

      await this.confirmStoreSelection(
        page
      );

      /*
       * Allow the fulfilment information to update.
       */
      await page.waitForTimeout(2500);

      await this.restoreProductPage(
        page,
        productUrl
      );

      logger.info(
        `Supercheap Auto store selection completed for ${this.storeName}`
      );
    } catch (error) {
      logger.warn(
        `Supercheap Auto store selection failed for ${this.storeName}. ` +
          `Product extraction will continue, but availability may be unknown: ` +
          `${
            error instanceof Error
              ? error.message
              : String(error)
          }`
      );

      await this.restoreProductPage(
        page,
        productUrl
      );
    }
  }

  /**
   * Verify that the browser is still on a product page.
   */
  private async validateProductPage(
    page: Page,
    expectedProductUrl: string
  ): Promise<void> {
    const currentUrl = page.url();

    if (
      this.isSearchResultsUrl(currentUrl)
    ) {
      throw new Error(
        `Supercheap Auto extraction aborted because the browser ` +
          `is on a search-results page instead of the product page. ` +
          `Current URL: ${currentUrl}; expected product URL: ${expectedProductUrl}`
      );
    }

    const heading = await page
      .locator('h1')
      .first()
      .textContent({
        timeout: 10000,
      })
      .catch(() => null);

    const cleanedHeading =
      heading
        ?.replace(/\s+/g, ' ')
        .trim() || null;

    if (
      cleanedHeading &&
      /product search results/i.test(
        cleanedHeading
      )
    ) {
      throw new Error(
        `Supercheap Auto extraction aborted because the page ` +
          `heading is "${cleanedHeading}" instead of a product name`
      );
    }
  }

  /**
   * Extract product information.
   *
   * IMPORTANT:
   * Availability is determined from the configured store's
   * store-item element, NOT from generic product-page text.
   */
  private async extractProduct(
    page: Page
  ): Promise<ExtractedProduct> {
    return page.evaluate(
      ({
        expectedStoreName,
        expectedStoreId,
      }): ExtractedProduct => {
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
           * Currency price.
           */
          const currencyMatch =
            text.match(
              /(?:NZD|NZ|\$)\s*(\d+(?:\.\d{1,2})?)/
            );

          if (currencyMatch) {
            const parsed =
              Number(currencyMatch[1]);

            return Number.isFinite(parsed)
              ? parsed
              : null;
          }

          /*
           * Plain numeric content, e.g.:
           *
           * <meta itemprop="price" content="39.99">
           */
          const numericMatch =
            text.match(
              /^\s*(\d+(?:\.\d{1,2})?)\s*$/
            );

          if (!numericMatch) {
            return null;
          }

          const parsed =
            Number(numericMatch[1]);

          return Number.isFinite(parsed)
            ? parsed
            : null;
        };

        const getText = (
          selector: string
        ): string | null => {
          const element =
            document.querySelector(
              selector
            );

          return cleanText(
            element?.textContent
          );
        };

        const getAttribute = (
          selector: string,
          attribute: string
        ): string | null => {
          const element =
            document.querySelector(
              selector
            );

          return cleanText(
            element?.getAttribute(
              attribute
            )
          );
        };

        const getFirstText = (
          selectors: string[]
        ): {
          value: string | null;
          selector: string | null;
        } => {
          for (const selector of selectors) {
            const value =
              getText(selector);

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

        const diagnostics: ExtractionDiagnostics =
          {
            nameSource: null,
            skuSource: null,
            priceSource: null,
            originalPriceSource: null,
            saleEndDateSource: null,
            storeSource: null,
            availabilitySource: null,
          };

        /*
         * ============================================================
         * PRODUCT NAME
         * ============================================================
         */

        let name: string | null = null;

        /*
         * pageContext.title
         */
        const scripts = Array.from(
          document.querySelectorAll(
            'script'
          )
        );

        for (const script of scripts) {
          const text =
            script.textContent || '';

          const match =
            text.match(
              /pageContext\s*=\s*({[\s\S]*?});/
            );

          if (!match) {
            continue;
          }

          try {
            const parsed =
              JSON.parse(match[1]);

            if (parsed?.title) {
              name = cleanText(
                String(parsed.title)
              );

              diagnostics.nameSource =
                'JS:pageContext.title';

              break;
            }
          } catch {
            // Ignore malformed pageContext.
          }
        }

        /*
         * DOM fallback.
         */
        if (!name) {
          const result =
            getFirstText([
              'h1[itemprop="name"]',
              '[itemprop="name"]',
              'h1.product-name',
              'h1[class*="product-name" i]',
              'h1[class*="product-title" i]',
              'h1',
            ]);

          if (result.value) {
            name = result.value;

            diagnostics.nameSource =
              `DOM:${result.selector}`;
          }
        }

        /*
         * document.title fallback.
         */
        if (!name) {
          const title =
            cleanText(document.title);

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

        if (
          name &&
          /product search results/i.test(
            name
          )
        ) {
          name = null;
          diagnostics.nameSource = null;
        }

        /*
         * ============================================================
         * SKU
         * ============================================================
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
          const masterId =
            document.querySelector(
              '[data-masterid]'
            );

          const value =
            cleanText(
              masterId?.getAttribute(
                'data-masterid'
              )
            );

          if (value) {
            sku = value;

            diagnostics.skuSource =
              'DOM:data-masterid';
          }
        }

        if (!sku) {
          const result =
            getFirstText([
              '.product-number',
              '[class*="product-number" i]',
              '[class*="product-code" i]',
              '[class*="item-number" i]',
              '[class*="sku" i]',
            ]);

          const match =
            result.value?.match(
              /(?:Item\s*No\.?|SKU|Product\s*Code)\s*:?\s*([A-Z0-9._-]+)/i
            );

          if (match) {
            sku = match[1];

            diagnostics.skuSource =
              `TEXT:${result.selector}`;
          }
        }

        /*
         * ============================================================
         * CURRENT PRICE
         * ============================================================
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
            document.querySelector(
              selector
            );

          if (!element) {
            continue;
          }

          const content =
            element.getAttribute(
              'content'
            );

          const candidate =
            parsePrice(
              content ||
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
         * ORIGINAL PRICE
         * ============================================================
         */

        let originalPrice:
          number | null = null;

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
            parsePrice(
              getText(selector)
            );

          if (
            candidate !== null &&
            (
              price === null ||
              candidate > price
            )
          ) {
            originalPrice =
              candidate;

            diagnostics.originalPriceSource =
              `DOM:${selector}`;

            break;
          }
        }

        /*
         * "Was $XX.XX" fallback.
         */
        if (
          originalPrice === null
        ) {
          const bodyText =
            cleanText(
              document.body?.innerText
            ) || '';

          const wasMatch =
            bodyText.match(
              /\bWas\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i
            );

          if (wasMatch) {
            const candidate =
              parsePrice(
                wasMatch[1]
              );

            if (
              candidate !== null &&
              (
                price === null ||
                candidate > price
              )
            ) {
              originalPrice =
                candidate;

              diagnostics.originalPriceSource =
                'TEXT:Was';
            }
          }
        }

        /*
         * ============================================================
         * SALE END DATE
         * ============================================================
         */

        let saleEndDate:
          string | null = null;

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

          saleEndDate =
            dateMatch
              ? dateMatch[1]
              : saleEndResult.value;

          diagnostics.saleEndDateSource =
            `DOM:${saleEndResult.selector}`;
        }

        /*
         * ============================================================
         * AVAILABILITY
         * ============================================================
         *
         * THIS IS THE IMPORTANT PART.
         *
         * We no longer inspect generic product-page text such as:
         *
         * "Out of Stock"
         *
         * because that can belong to another store.
         *
         * Instead we locate:
         *
         * .store-item[data-store-id="7030"]
         *
         * and inspect its data-products attribute.
         *
         * Example supplied by you:
         *
         * data-products='{
         *   "available":["518963"],
         *   "unavailable":[],
         *   "specialProduct":[],
         *   "lowStock":[]
         * }'
         *
         * ============================================================
         */

        let availability:
          Availability = 'unknown';

        let store:
          string | null = null;

        /*
         * Find the exact configured store.
         */
        const storeElement =
          document.querySelector(
            `.store-item[data-store-id="${expectedStoreId}"]`
          ) ||
          document.querySelector(
            `.store-item[data-id="${expectedStoreId}"]`
          ) ||
          document.querySelector(
            `.fulfilment-store-item[data-id="${expectedStoreId}"]`
          ) ||
          document.querySelector(
            `.fulfilment-store-item[data-store-id="${expectedStoreId}"]`
          );

        if (storeElement) {
          /*
           * Store name.
           */
          store =
            cleanText(
              storeElement.getAttribute(
                'data-name'
              )
            ) ||
            cleanText(
              storeElement.querySelector(
                '.store-name'
              )?.textContent
            ) ||
            cleanText(
              storeElement.querySelector(
                '.my-store-name'
              )?.textContent
            );

          if (store) {
            diagnostics.storeSource =
              'DOM:.store-item[data-store-id]';
          }

          /*
           * ----------------------------------------------------------
           * PRIMARY AVAILABILITY:
           * data-products
           * ----------------------------------------------------------
           */

          const productsJson =
            storeElement.getAttribute(
              'data-products'
            );

          let productsData:
            StoreProductData | null =
            null;

          if (productsJson) {
            try {
              productsData =
                JSON.parse(
                  productsJson
                ) as StoreProductData;
            } catch {
              productsData = null;
            }
          }

          /*
           * If we know the SKU and the store provides product-level
           * availability, use that as the authoritative result.
           */
          if (
            sku &&
            productsData
          ) {
            const available =
              Array.isArray(
                productsData.available
              )
                ? productsData.available
                : [];

            const unavailable =
              Array.isArray(
                productsData.unavailable
              )
                ? productsData.unavailable
                : [];

            const lowStock =
              Array.isArray(
                productsData.lowStock
              )
                ? productsData.lowStock
                : [];

            if (
              available.includes(sku)
            ) {
              availability =
                'in_stock';

              diagnostics.availabilitySource =
                'DOM:.store-item[data-products].available';
            } else if (
              lowStock.includes(sku)
            ) {
              /*
               * Low stock still means the product is available.
               */
              availability =
                'in_stock';

              diagnostics.availabilitySource =
                'DOM:.store-item[data-products].lowStock';
            } else if (
              unavailable.includes(sku)
            ) {
              availability =
                'out_of_stock';

              diagnostics.availabilitySource =
                'DOM:.store-item[data-products].unavailable';
            }
          }

          /*
           * ----------------------------------------------------------
           * SECONDARY AVAILABILITY:
           * data-status
           * ----------------------------------------------------------
           *
           * Example:
           *
           * data-status="available"
           */

          if (
            availability === 'unknown'
          ) {
            const status =
              storeElement.getAttribute(
                'data-status'
              );

            if (
              status?.toLowerCase() ===
              'available'
            ) {
              availability =
                'in_stock';

              diagnostics.availabilitySource =
                'DOM:.store-item[data-status=available]';
            } else if (
              status?.toLowerCase() ===
                'unavailable' ||
              status?.toLowerCase() ===
                'out-of-stock' ||
              status?.toLowerCase() ===
                'out_of_stock'
            ) {
              availability =
                'out_of_stock';

              diagnostics.availabilitySource =
                'DOM:.store-item[data-status=unavailable]';
            }
          }

          /*
           * ----------------------------------------------------------
           * THIRDARY AVAILABILITY:
           * visible "In Stock" / "Out of Stock" text inside THIS
           * exact store element.
           * ----------------------------------------------------------
           */

          if (
            availability === 'unknown'
          ) {
            const statusText =
              cleanText(
                storeElement.querySelector(
                  '.text-status.pdp'
                )?.textContent
              ) ||
              cleanText(
                storeElement.querySelector(
                  '.store-status'
                )?.textContent
              );

            if (
              /\bin\s+stock\b/i.test(
                statusText || ''
              )
            ) {
              availability =
                'in_stock';

              diagnostics.availabilitySource =
                'DOM:.store-item .text-status.pdp';
            } else if (
              /\bout\s+of\s+stock\b/i.test(
                statusText || ''
              ) ||
              /\bunavailable\b/i.test(
                statusText || ''
              ) ||
              /\bnot\s+available\b/i.test(
                statusText || ''
              )
            ) {
              availability =
                'out_of_stock';

              diagnostics.availabilitySource =
                'DOM:.store-item .text-status.pdp';
            }
          }
        }

        /*
         * ============================================================
         * AVAILABILITY FALLBACK
         * ============================================================
         *
         * Only if the exact store element cannot be found at all.
         *
         * We deliberately DO NOT use broad product-area text first,
         * because that caused the false "out_of_stock" result.
         */

        if (
          availability === 'unknown'
        ) {
          const addToCartElement =
            Array.from(
              document.querySelectorAll(
                'button, a'
              )
            ).find(
              (element) => {
                const text =
                  cleanText(
                    element.textContent
                  ) || '';

                return /\badd\s+to\s+cart\b/i.test(
                  text
                );
              }
            );

          if (addToCartElement) {
            availability =
              'in_stock';

            diagnostics.availabilitySource =
              'FALLBACK:DOM:Add-to-Cart';
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
          ) ||
          window.location.href;

        return {
          name,
          sku,
          price,
          originalPrice,
          saleEndDate,
          availability,
          store,
          canonicalUrl,
          diagnostics,
        };
      },
      {
        expectedStoreName:
          this.storeName,
        expectedStoreId:
          this.storeId,
      }
    );
  }

  /**
   * Main scraping method.
   */
  async scrapeProduct(
    url: string
  ): Promise<SupercheapAutoScrapedProduct> {
    let page: Page | null = null;

    try {
      await browserService.initialize();

      page =
        await browserService.createPage();

      logger.info(
        `Scraping Supercheap Auto product: ${url} ` +
          `using store ${this.storeName} ` +
          `(${this.postalCode})`
      );

      /*
       * ------------------------------------------------------------
       * NAVIGATE TO PRODUCT
       * ------------------------------------------------------------
       */

      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout:
          this.navigationTimeout,
      });

      const productPageUrl =
        page.url();

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

      await page.waitForTimeout(
        1500
      );

      /*
       * ------------------------------------------------------------
       * SELECT STORE
       * ------------------------------------------------------------
       */

      await this.ensureStoreSelected(
        page,
        productPageUrl
      );

      /*
       * Ecommerce pages often keep connections open, so networkidle
       * is only an optional wait.
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
            `continuing with rendered page`
        );
      }

      /*
       * Give the store/product fulfilment AJAX time to update.
       */
      await page.waitForTimeout(
        2000
      );

      /*
       * Ensure store selection did not send us to search.
       */
      await this.validateProductPage(
        page,
        productPageUrl
      );

      /*
       * ------------------------------------------------------------
       * EXTRACT
       * ------------------------------------------------------------
       */

      const product =
        await this.extractProduct(
          page
        );

      logger.info(
        `Supercheap Auto extraction result for ${url}: ` +
          `${JSON.stringify({
            finalPageUrl:
              page.url(),
            name:
              product.name,
            sku:
              product.sku,
            price:
              product.price,
            originalPrice:
              product.originalPrice,
            saleEndDate:
              product.saleEndDate,
            availability:
              product.availability,
            store:
              product.store,
            diagnostics:
              product.diagnostics,
          })}`
      );

      /*
       * ------------------------------------------------------------
       * WARNINGS
       * ------------------------------------------------------------
       */

      if (!product.name) {
        logger.warn(
          `Supercheap Auto product name could not be extracted for ${url}`
        );
      }

      if (!product.sku) {
        logger.warn(
          `Supercheap Auto SKU could not be extracted for ${url}`
        );
      }

      if (
        product.price === null
      ) {
        logger.warn(
          `Supercheap Auto price could not be extracted for ${url}`
        );
      }

      if (!product.store) {
        logger.warn(
          `Supercheap Auto could not confirm store ${this.storeName} for ${url}`
        );
      } else if (
        !product.store
          .toLowerCase()
          .includes(
            this.storeName.toLowerCase()
          )
      ) {
        logger.warn(
          `Supercheap Auto returned store "${product.store}" ` +
            `instead of "${this.storeName}"`
        );
      }

      if (
        product.availability ===
        'unknown'
      ) {
        logger.warn(
          `Supercheap Auto availability could not be determined ` +
            `for SKU ${product.sku} at ${this.storeName}`
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
       * ------------------------------------------------------------
       * RETURN
       * ------------------------------------------------------------
       */

      return {
        site:
          'supercheapauto',

        url:
          product.canonicalUrl ||
          page.url(),

        name:
          product.name,

        sku:
          product.sku,

        price:
          product.price,

        originalPrice:
          product.originalPrice,

        saleEndDate:
          product.saleEndDate,

        currency:
          'NZD',

        availability:
          product.availability,

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
        await browserService.closePage(
          page
        );
      }
    }
  }
}

export const supercheapAutoAdapter =
  new SupercheapAutoAdapter();
