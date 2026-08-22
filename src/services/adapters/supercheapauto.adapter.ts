import { Page, Locator } from 'playwright';
import logger from '../../config/logger';
import { browserService } from '../browser.service';
import {
  ProductAvailability,
  SupercheapAutoScrapedProduct,
} from '../../types/product-scrape.types';
import { ProductScraperAdapter } from './scraper-adapter.interface';

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
  availability: ProductAvailability;
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

  /**
   * Configured Supercheap Auto store.
   *
   * SCA Wairau Park
   * Store ID: 7030
   * Postcode: 0627
   */
  private readonly storeName = 'SCA Wairau Park';
  private readonly storeId = '7030';
  private readonly postalCode = '0627';

  /**
   * Performance-related timeouts.
   *
   * We avoid arbitrary long sleeps and networkidle.
   * Instead, we wait for the actual elements/data we need.
   */
  private readonly navigationTimeout = 30000;
  private readonly productWaitTimeout = 10000;
  private readonly storeWaitTimeout = 8000;
  private readonly selectorTimeout = 8000;
  private readonly inventoryWaitTimeout = 12000;

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
   * navigates to a search page.
   */
  private async restoreProductPage(
    page: Page,
    productUrl: string
  ): Promise<void> {
    if (!this.isSearchResultsUrl(page.url())) {
      return;
    }

    logger.warn(
      `Supercheap Auto navigated to search page ${page.url()}. ` +
        `Restoring product page.`
    );

    await page.goto(productUrl, {
      waitUntil: 'domcontentloaded',
      timeout: this.navigationTimeout,
    });

    await this.waitForProductPage(page);
  }

  /**
   * Wait for the product page to become usable.
   *
   * We intentionally do NOT use networkidle because ecommerce
   * pages can keep analytics/tracking requests open for a long time.
   */
  private async waitForProductPage(
    page: Page
  ): Promise<void> {
    await page
      .locator('h1')
      .first()
      .waitFor({
        state: 'visible',
        timeout: this.productWaitTimeout,
      })
      .catch(() => {
        logger.debug(
          'Supercheap Auto H1 was not detected within the normal wait period.'
        );
      });
  }

  /**
   * Check whether the configured store is already present.
   *
   * If store 7030 is already present, there is no need to open
   * the store selector and perform another postcode search.
   */
  private async isConfiguredStorePresent(
    page: Page
  ): Promise<boolean> {
    const store = page
      .locator(
        [
          `.store-item[data-store-id="${this.storeId}"]`,
          `.store-item[data-id="${this.storeId}"]`,
          `.fulfilment-store-item[data-store-id="${this.storeId}"]`,
          `.fulfilment-store-item[data-id="${this.storeId}"]`,
        ].join(', ')
      )
      .first();

    return store
      .isVisible({
        timeout: 3000,
      })
      .catch(() => false);
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

    const visible =
      await changeStoreButton
        .isVisible({
          timeout: 3000,
        })
        .catch(() => false);

    if (visible) {
      logger.debug(
        'Opening Supercheap Auto store selector.'
      );

      await changeStoreButton.click({
        timeout: this.selectorTimeout,
      });
    }

    const preferredStoreButton =
      page.locator(
        '#change-preferred-store-button'
      );

    const preferredVisible =
      await preferredStoreButton
        .isVisible({
          timeout: 2000,
        })
        .catch(() => false);

    if (preferredVisible) {
      await preferredStoreButton.click({
        timeout: this.selectorTimeout,
      });
    }
  }

  /**
   * Find the store postcode/suburb input.
   *
   * We explicitly exclude the global product search input.
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
      timeout: this.storeWaitTimeout,
    });

    const details =
      await postcodeInput.evaluate(
        (
          element: HTMLInputElement
        ) => ({
          id: element.id || null,
          name: element.name || null,
          type: element.type || null,
          placeholder:
            element.placeholder || null,
          className:
            element.className || null,
        })
      );

    logger.debug(
      `Supercheap Auto store input found: ${JSON.stringify(details)}`
    );

    if (
      details.name?.toLowerCase() === 'q' ||
      /search products|what are you looking for/i.test(
        details.placeholder || ''
      )
    ) {
      throw new Error(
        `Selected input is the global product search input: ` +
          `${JSON.stringify(details)}`
      );
    }

    return postcodeInput;
  }

  /**
   * Search for the configured store.
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

    const visible =
      await searchButton
        .isVisible({
          timeout: 3000,
        })
        .catch(() => false);

    if (visible) {
      await searchButton.click({
        timeout: this.selectorTimeout,
      });
    }
  }

  /**
   * Find the configured store.
   */
  private async findConfiguredStore(
    page: Page
  ): Promise<Locator> {
    const store = page
      .locator(
        [
          `.store-item[data-store-id="${this.storeId}"]`,
          `.store-item[data-id="${this.storeId}"]`,

          `.fulfilment-store-item[data-store-id="${this.storeId}"]`,
          `.fulfilment-store-item[data-id="${this.storeId}"]`,

          `.store-item:has(.store-name:text-is("${this.storeName}"))`,
          `.fulfilment-store-item:has(.store-name:text-is("${this.storeName}"))`,
        ].join(', ')
      )
      .first();

    await store.waitFor({
      state: 'visible',
      timeout: this.storeWaitTimeout,
    });

    return store;
  }

  /**
   * Validate that the selected store is really Wairau Park.
   */
  private async validateConfiguredStore(
    store: Locator
  ): Promise<void> {
    const details =
      await store.evaluate(
        (element: HTMLElement) => ({
          storeId:
            element.getAttribute(
              'data-store-id'
            ) ||
            element.getAttribute(
              'data-id'
            ),

          storeName:
            element.getAttribute(
              'data-name'
            ) ||
            element
              .querySelector(
                '.store-name'
              )
              ?.textContent
              ?.replace(/\s+/g, ' ')
              .trim() ||
            element
              .querySelector(
                '.my-store-name'
              )
              ?.textContent
              ?.replace(/\s+/g, ' ')
              .trim() ||
            null,

          status:
            element.getAttribute(
              'data-status'
            ),
        })
      );

    const matchesId =
      details.storeId ===
      this.storeId;

    const matchesName =
      details.storeName
        ?.toLowerCase()
        .includes(
          this.storeName.toLowerCase()
        );

    if (
      !matchesId &&
      !matchesName
    ) {
      throw new Error(
        `Unexpected Supercheap Auto store returned: ` +
          `${JSON.stringify(details)}`
      );
    }

    logger.debug(
      `Confirmed Supercheap Auto store: ${JSON.stringify(details)}`
    );
  }

  /**
   * Confirm the store selection if the UI provides a confirmation button.
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

    const visible =
      await confirmButton
        .isVisible({
          timeout: 2000,
        })
        .catch(() => false);

    if (!visible) {
      return;
    }

    await confirmButton.click({
      timeout: this.selectorTimeout,
    });
  }

  /**
   * Wait until the configured store element exists.
   *
   * This does NOT mean inventory is ready. Inventory is handled
   * separately by waitForStoreInventory().
   */
  private async waitForStoreData(
    page: Page
  ): Promise<void> {
    const store = page
      .locator(
        [
          `.store-item[data-store-id="${this.storeId}"]`,
          `.store-item[data-id="${this.storeId}"]`,
          `.fulfilment-store-item[data-store-id="${this.storeId}"]`,
          `.fulfilment-store-item[data-id="${this.storeId}"]`,
        ].join(', ')
      )
      .first();

    await store.waitFor({
      state: 'visible',
      timeout: this.storeWaitTimeout,
    });
  }

  /**
   * Select Wairau Park only when necessary.
   */
  private async ensureStoreSelected(
    page: Page,
    productUrl: string
  ): Promise<void> {
    /*
     * First check whether Wairau Park is already present.
     */
    const alreadyPresent =
      await this.isConfiguredStorePresent(
        page
      );

    if (alreadyPresent) {
      logger.info(
        `Supercheap Auto store ${this.storeName} is already present. ` +
          `Skipping store selection.`
      );

      return;
    }

    logger.info(
      `Supercheap Auto store ${this.storeName} not present. ` +
        `Starting store selection.`
    );

    try {
      await this.openStoreSelector(
        page
      );

      const postcodeInput =
        await this.findStorePostcodeInput(
          page
        );

      /*
       * Do not press Enter because it can submit the wrong form.
       */
      await postcodeInput.fill(
        this.postalCode
      );

      await this.searchForStore(
        page
      );

      const store =
        await this.findConfiguredStore(
          page
        );

      await this.validateConfiguredStore(
        store
      );

      await store.scrollIntoViewIfNeeded();

      await store.click({
        timeout: this.selectorTimeout,
      });

      await this.confirmStoreSelection(
        page
      );

      /*
       * Wait for the store element itself.
       *
       * Inventory is waited for separately.
       */
      await this.waitForStoreData(
        page
      );

      /*
       * Only restore the product page if necessary.
       */
      await this.restoreProductPage(
        page,
        productUrl
      );

      logger.info(
        `Supercheap Auto store ${this.storeName} selected successfully.`
      );
    } catch (error) {
      logger.warn(
        `Could not select Supercheap Auto store ${this.storeName}: ` +
          `${
            error instanceof Error
              ? error.message
              : String(error)
          }`
      );

      /*
       * Never allow the scraper to accidentally process a search page.
       */
      await this.restoreProductPage(
        page,
        productUrl
      );
    }
  }

  /**
   * Validate that we are still on a product page.
   */
  private async validateProductPage(
    page: Page,
    expectedProductUrl: string
  ): Promise<void> {
    const currentUrl =
      page.url();

    if (
      this.isSearchResultsUrl(
        currentUrl
      )
    ) {
      throw new Error(
        `Supercheap Auto is on a search-results page instead of ` +
          `the product page. Current URL: ${currentUrl}; ` +
          `expected: ${expectedProductUrl}`
      );
    }

    const heading =
      await page
        .locator('h1')
        .first()
        .textContent({
          timeout: 3000,
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
        `Supercheap Auto returned product search results instead ` +
          `of the requested product.`
      );
    }
  }

  /**
   * Extract the product SKU before waiting for inventory.
   *
   * This is intentionally lightweight.
   */
  private async extractSkuForWaiting(
    page: Page
  ): Promise<string | null> {
    return page.evaluate(() => {
      const cleanText = (
        value:
          | string
          | null
          | undefined
      ): string | null => {
        if (!value) {
          return null;
        }

        const cleaned =
          value
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        return cleaned || null;
      };

      /*
       * First choice:
       * productID / SKU meta tags.
       */
      const metaSelectors = [
        'meta[itemprop="productID"]',
        'meta[itemprop="sku"]',
      ];

      for (
        const selector of metaSelectors
      ) {
        const element =
          document.querySelector(
            selector
          );

        const value =
          cleanText(
            element?.getAttribute(
              'content'
            )
          );

        if (value) {
          return value;
        }
      }

      /*
       * Second choice:
       * data-masterid.
       */
      const masterId =
        document.querySelector(
          '[data-masterid]'
        );

      const masterIdValue =
        cleanText(
          masterId?.getAttribute(
            'data-masterid'
          )
        );

      if (masterIdValue) {
        return masterIdValue;
      }

      /*
       * Third choice:
       * product number / SKU text.
       */
      const selectors = [
        '.product-number',
        '[class*="product-number" i]',
        '[class*="product-code" i]',
        '[class*="item-number" i]',
        '[class*="sku" i]',
      ];

      for (
        const selector of selectors
      ) {
        const element =
          document.querySelector(
            selector
          );

        const text =
          cleanText(
            element?.textContent
          );

        if (!text) {
          continue;
        }

        const match =
          text.match(
            /(?:Item\s*No\.?|SKU|Product\s*Code)\s*:?\s*([A-Z0-9._-]+)/i
          );

        if (match) {
          return match[1];
        }
      }

      return null;
    });
  }

  /**
   * Wait specifically for the inventory decision for this SKU.
   *
   * This is the critical fix for the performance regression.
   *
   * We DO NOT simply wait for the store element.
   *
   * We wait until data-products contains this exact SKU in:
   *
   *   available
   *   unavailable
   *   lowStock
   *
   * This allows us to continue immediately once inventory is ready.
   */
  private async waitForStoreInventory(
    page: Page,
    sku: string | null
  ): Promise<ProductAvailability> {
    if (!sku) {
      logger.warn(
        'Cannot determine Supercheap Auto inventory because SKU is unknown.'
      );

      return 'unknown';
    }

    const storeSelector =
      `.store-item[data-store-id="${this.storeId}"],` +
      `.store-item[data-id="${this.storeId}"],` +
      `.fulfilment-store-item[data-store-id="${this.storeId}"],` +
      `.fulfilment-store-item[data-id="${this.storeId}"]`;

    try {
      const result =
        await page.waitForFunction(
          ({
            selector,
            expectedSku,
          }) => {
            const store =
              document.querySelector(
                selector
              );

            if (!store) {
              return null;
            }

            const productsJson =
              store.getAttribute(
                'data-products'
              );

            if (!productsJson) {
              return null;
            }

            try {
              const data =
                JSON.parse(
                  productsJson
                ) as {
                  available?: string[];
                  unavailable?: string[];
                  specialProduct?: string[];
                  lowStock?: string[];
                };

              const available =
                Array.isArray(
                  data.available
                )
                  ? data.available
                  : [];

              const unavailable =
                Array.isArray(
                  data.unavailable
                )
                  ? data.unavailable
                  : [];

              const lowStock =
                Array.isArray(
                  data.lowStock
                )
                  ? data.lowStock
                  : [];

              /*
               * Available.
               */
              if (
                available.includes(
                  expectedSku
                )
              ) {
                return 'in_stock';
              }

              /*
               * Low stock is still considered in stock.
               */
              if (
                lowStock.includes(
                  expectedSku
                )
              ) {
                return 'in_stock';
              }

              /*
               * Explicitly unavailable.
               */
              if (
                unavailable.includes(
                  expectedSku
                )
              ) {
                return 'out_of_stock';
              }

              /*
               * The inventory object exists but this SKU hasn't
               * been classified yet.
               */
              return null;
            } catch {
              return null;
            }
          },
          {
            selector:
              storeSelector,
            expectedSku:
              sku,
          },
          {
            timeout:
              this.inventoryWaitTimeout,
            polling: 200,
          }
        );

      const availability =
        (await result.jsonValue()) as
          | ProductAvailability
          | null;

      if (availability) {
        logger.debug(
          `Supercheap Auto inventory resolved: ` +
            `SKU=${sku}, store=${this.storeId}, ` +
            `availability=${availability}`
        );

        return availability;
      }
    } catch {
      logger.warn(
        `Supercheap Auto inventory did not resolve within ` +
          `${this.inventoryWaitTimeout}ms for SKU ${sku}, ` +
          `store ${this.storeId}.`
      );
    }

    return 'unknown';
  }

  /**
   * Extract product information from the rendered page.
   */
  private async extractProduct(
    page: Page,
    resolvedAvailability?: ProductAvailability
  ): Promise<ExtractedProduct> {
    return page.evaluate(
      ({
        expectedStoreId,
        resolvedAvailability,
      }): ExtractedProduct => {
        const cleanText = (
          value:
            | string
            | null
            | undefined
        ): string | null => {
          if (!value) {
            return null;
          }

          const cleaned =
            value
              .replace(/\u00a0/g, ' ')
              .replace(/\s+/g, ' ')
              .trim();

          return cleaned || null;
        };

        const parsePrice = (
          value:
            | string
            | null
            | undefined
        ): number | null => {
          if (!value) {
            return null;
          }

          const text =
            value
              .replace(/\u00a0/g, ' ')
              .replace(/,/g, '')
              .trim();

          const currencyMatch =
            text.match(
              /(?:NZD|NZ|\$)\s*(\d+(?:\.\d{1,2})?)/
            );

          if (currencyMatch) {
            const parsed =
              Number(
                currencyMatch[1]
              );

            return Number.isFinite(
              parsed
            )
              ? parsed
              : null;
          }

          const numericMatch =
            text.match(
              /^\s*(\d+(?:\.\d{1,2})?)\s*$/
            );

          if (!numericMatch) {
            return null;
          }

          const parsed =
            Number(
              numericMatch[1]
            );

          return Number.isFinite(
            parsed
          )
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
          for (
            const selector of selectors
          ) {
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
         * NAME
         * ============================================================
         */

        let name:
          string | null = null;

        const scripts =
          Array.from(
            document.querySelectorAll(
              'script'
            )
          );

        for (
          const script of scripts
        ) {
          const text =
            script.textContent ||
            '';

          const match =
            text.match(
              /pageContext\s*=\s*({[\s\S]*?});/
            );

          if (!match) {
            continue;
          }

          try {
            const parsed =
              JSON.parse(
                match[1]
              );

            if (
              parsed?.title
            ) {
              name =
                cleanText(
                  String(
                    parsed.title
                  )
                );

              diagnostics.nameSource =
                'JS:pageContext.title';

              break;
            }
          } catch {
            // Ignore malformed pageContext.
          }
        }

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

          if (
            result.value
          ) {
            name =
              result.value;

            diagnostics.nameSource =
              `DOM:${result.selector}`;
          }
        }

        if (!name) {
          const title =
            cleanText(
              document.title
            );

          if (title) {
            name =
              title
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
          diagnostics.nameSource =
            null;
        }

        /*
         * ============================================================
         * SKU
         * ============================================================
         */

        let sku:
          string | null = null;

        const productIdMeta =
          getAttribute(
            'meta[itemprop="productID"]',
            'content'
          ) ||
          getAttribute(
            'meta[itemprop="sku"]',
            'content'
          );

        if (
          productIdMeta
        ) {
          sku =
            productIdMeta;

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
            sku =
              value;

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
            sku =
              match[1];

            diagnostics.skuSource =
              `TEXT:${result.selector}`;
          }
        }

        /*
         * ============================================================
         * PRICE
         * ============================================================
         */

        let price:
          number | null = null;

        const priceSelectors = [
          '.price-sales .promo-price',
          '.promo-price',
          '.price-sales',
          '[class*="promo-price" i]',
          '[class*="sale-price" i]',
          '[class*="price-sales" i]',
          '[itemprop="price"]',
        ];

        for (
          const selector of priceSelectors
        ) {
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

          if (
            candidate !== null
          ) {
            price =
              candidate;

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

        for (
          const selector of
            originalPriceSelectors
        ) {
          const candidate =
            parsePrice(
              getText(
                selector
              )
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

        if (
          saleEndResult.value
        ) {
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
         * STORE / AVAILABILITY
         * ============================================================
         */

        let availability:
          ProductAvailability =
            resolvedAvailability ??
            'unknown';

        let store:
          string | null = null;

        const storeElement =
          document.querySelector(
            `.store-item[data-store-id="${expectedStoreId}"]`
          ) ||
          document.querySelector(
            `.store-item[data-id="${expectedStoreId}"]`
          ) ||
          document.querySelector(
            `.fulfilment-store-item[data-store-id="${expectedStoreId}"]`
          ) ||
          document.querySelector(
            `.fulfilment-store-item[data-id="${expectedStoreId}"]`
          );

        if (
          storeElement
        ) {
          store =
            cleanText(
              storeElement.getAttribute(
                'data-name'
              )
            ) ||
            cleanText(
              storeElement
                .querySelector(
                  '.store-name'
                )
                ?.textContent
            ) ||
            cleanText(
              storeElement
                .querySelector(
                  '.my-store-name'
                )
                ?.textContent
            );

          if (store) {
            diagnostics.storeSource =
              'DOM:.store-item[data-store-id]';
          }

          /*
           * If the waiting step didn't resolve availability,
           * perform a final direct extraction from data-products.
           */
          const productsJson =
            storeElement.getAttribute(
              'data-products'
            );

          let productsData:
            StoreProductData | null =
            null;

          if (
            productsJson
          ) {
            try {
              productsData =
                JSON.parse(
                  productsJson
                ) as StoreProductData;
            } catch {
              productsData = null;
            }
          }

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
              available.includes(
                sku
              )
            ) {
              availability =
                'in_stock';

              diagnostics.availabilitySource =
                'data-products.available';
            } else if (
              lowStock.includes(
                sku
              )
            ) {
              availability =
                'in_stock';

              diagnostics.availabilitySource =
                'data-products.lowStock';
            } else if (
              unavailable.includes(
                sku
              )
            ) {
              availability =
                'out_of_stock';

              diagnostics.availabilitySource =
                'data-products.unavailable';
            }
          }

          /*
           * Fallback to data-status.
           */
          if (
            availability ===
            'unknown'
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
                'data-status=available';
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
                `data-status=${status}`;
            }
          }

          /*
           * Final fallback to visible status text inside the
           * exact configured store element.
           */
          if (
            availability ===
            'unknown'
          ) {
            const statusText =
              cleanText(
                storeElement
                  .querySelector(
                    '.text-status.pdp'
                  )
                  ?.textContent
              ) ||
              cleanText(
                storeElement
                  .querySelector(
                    '.store-status'
                  )
                  ?.textContent
              );

            if (
              /\bin\s+stock\b/i.test(
                statusText || ''
              )
            ) {
              availability =
                'in_stock';

              diagnostics.availabilitySource =
                '.text-status.pdp';
            } else if (
              /\bout\s+of\s+stock\b/i.test(
                statusText || ''
              ) ||
              /\bunavailable\b/i.test(
                statusText || ''
              )
            ) {
              availability =
                'out_of_stock';

              diagnostics.availabilitySource =
                '.text-status.pdp';
            }
          }
        }

        return {
          name,
          sku,
          price,
          originalPrice,
          saleEndDate,
          availability,
          store,
          canonicalUrl:
            getAttribute(
              'link[rel="canonical"]',
              'href'
            ) ||
            window.location.href,
          diagnostics,
        };
      },
      {
        expectedStoreId:
          this.storeId,
        resolvedAvailability:
          resolvedAvailability ??
          'unknown',
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

    const startTime =
      Date.now();

    try {
      await browserService.initialize();

      page =
        await browserService.createPage();

      logger.info(
        `Scraping Supercheap Auto: ${url}`
      );

      /*
       * ============================================================
       * STEP 1: PRODUCT PAGE
       * ============================================================
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
          `Supercheap Auto URL resolved to search results: ` +
            `${productPageUrl}`
        );
      }

      /*
       * Wait for the product page itself.
       */
      await this.waitForProductPage(
        page
      );

      /*
       * ============================================================
       * STEP 2: STORE
       * ============================================================
       */

      await this.ensureStoreSelected(
        page,
        productPageUrl
      );

      await this.restoreProductPage(
        page,
        productPageUrl
      );

      await this.validateProductPage(
        page,
        productPageUrl
      );

      /*
       * ============================================================
       * STEP 3: GET SKU
       * ============================================================
       */

      const skuForInventory =
        await this.extractSkuForWaiting(
          page
        );

      logger.debug(
        `Supercheap Auto SKU for inventory lookup: ${skuForInventory}`
      );

      /*
       * ============================================================
       * STEP 4: WAIT FOR INVENTORY
       * ============================================================
       *
       * This is the key difference from the previous performance
       * refactor.
       *
       * We wait for the actual SKU to appear in data-products,
       * rather than merely waiting for the store element.
       */

      const resolvedAvailability =
        await this.waitForStoreInventory(
          page,
          skuForInventory
        );

      /*
       * ============================================================
       * STEP 5: EXTRACT
       * ============================================================
       */

      const product =
        await this.extractProduct(
          page,
          resolvedAvailability
        );

      const durationMs =
        Date.now() -
        startTime;

      logger.info(
        `Supercheap Auto completed in ${durationMs}ms: ` +
          `${JSON.stringify({
            name:
              product.name,
            sku:
              product.sku,
            price:
              product.price,
            originalPrice:
              product.originalPrice,
            availability:
              product.availability,
            store:
              product.store,
            availabilitySource:
              product.diagnostics
                .availabilitySource,
          })}`
      );

      /*
       * ============================================================
       * WARNINGS
       * ============================================================
       */

      if (!product.name) {
        logger.warn(
          `Supercheap Auto product name could not be extracted: ${url}`
        );
      }

      if (!product.sku) {
        logger.warn(
          `Supercheap Auto SKU could not be extracted: ${url}`
        );
      }

      if (
        product.price === null
      ) {
        logger.warn(
          `Supercheap Auto price could not be extracted: ${url}`
        );
      }

      if (!product.store) {
        logger.warn(
          `Supercheap Auto store ${this.storeName} could not be confirmed.`
        );
      }

      if (
        product.availability ===
        'unknown'
      ) {
        logger.warn(
          `Supercheap Auto availability is unknown for ` +
            `SKU ${product.sku} at ${this.storeName}.`
        );
      }

      /*
       * ============================================================
       * RETURN
       * ============================================================
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
      const durationMs =
        Date.now() -
        startTime;

      logger.error(
        `Supercheap Auto scraping failed after ${durationMs}ms for ${url}:`,
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
