import { Page } from 'playwright';
import logger from '../../config/logger';
import { browserService } from '../browser.service';
import { ProductScraperAdapter } from './scraper-adapter.interface';
import {
  ProductAvailability,
  SupercheapAutoScrapedProduct,
} from '../../types/product-scrape.types';

type Availability = ProductAvailability;

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

interface StoreProducts {
  available?: string[];
  unavailable?: string[];
  specialProduct?: string[];
  lowStock?: string[];
}

export class SupercheapAutoAdapter
  implements ProductScraperAdapter
{
  readonly site = 'supercheapauto' as const;

  /*
   * ============================================================
   * CONFIGURATION
   * ============================================================
   */

  private readonly storeName =
    'SCA Wairau Park';

  private readonly storeId =
    '7030';

  private readonly postalCode =
    '0627';

  /*
   * Keep navigation reasonably fast.
   * We do NOT use networkidle because ecommerce pages
   * can keep analytics requests open indefinitely.
   */
  private readonly navigationTimeout =
    45000;

  private readonly productWaitTimeout =
    10000;

  private readonly storeWaitTimeout =
    12000;

  private readonly inventoryWaitTimeout =
    10000;

  /*
   * ============================================================
   * URL HANDLING
   * ============================================================
   */

  canHandle(url: string): boolean {
    try {
      const parsedUrl =
        new URL(url);

      const hostname =
        parsedUrl.hostname.toLowerCase();

      return (
        hostname ===
          'supercheapauto.co.nz' ||
        hostname.endsWith(
          '.supercheapauto.co.nz'
        )
      );
    } catch {
      return false;
    }
  }

  private isSearchResultsUrl(
    url: string
  ): boolean {
    try {
      const parsedUrl =
        new URL(url);

      return (
        parsedUrl.pathname ===
          '/search' ||
        parsedUrl.pathname.startsWith(
          '/search/'
        )
      );
    } catch {
      return (
        url.includes('/search?') ||
        url.includes('/search/')
      );
    }
  }

  /*
   * ============================================================
   * PRODUCT PAGE
   * ============================================================
   */

  private async waitForProductPage(
    page: Page
  ): Promise<void> {
    await page
      .locator('h1')
      .first()
      .waitFor({
        state: 'visible',
        timeout:
          this.productWaitTimeout,
      })
      .catch(() => {
        logger.debug(
          'Supercheap Auto H1 was not detected within the expected time.'
        );
      });
  }

  private async restoreProductPage(
    page: Page,
    productUrl: string
  ): Promise<void> {
    if (
      !this.isSearchResultsUrl(
        page.url()
      )
    ) {
      return;
    }

    logger.warn(
      `Supercheap Auto navigated to search results. ` +
        `Restoring product page: ${productUrl}`
    );

    await page.goto(
      productUrl,
      {
        waitUntil:
          'domcontentloaded',
        timeout:
          this.navigationTimeout,
      }
    );

    await this.waitForProductPage(
      page
    );
  }

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
        `Supercheap Auto resolved to search results instead of ` +
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
        `Supercheap Auto returned product search results instead of a product page.`
      );
    }
  }

  /*
   * ============================================================
   * STORE DETECTION
   * ============================================================
   *
   * This is the ACTUAL product-page element:
   *
   * <div
   *   class="store-item pdp available"
   *   data-store-id="7030"
   *   data-status="available"
   *   data-products="..."
   * >
   *
   * This is different from the store-selection modal's:
   *
   * .fulfilment-store-item
   *
   * We only use .store-item[data-store-id="7030"] for
   * product availability.
   */

  private getProductStoreSelector(): string {
    return (
      `.store-item[data-store-id="${this.storeId}"]`
    );
  }

  private async isStoreAlreadyPresent(
    page: Page
  ): Promise<boolean> {
    const selector =
      this.getProductStoreSelector();

    return page
      .locator(selector)
      .first()
      .isVisible({
        timeout: 2500,
      })
      .catch(() => false);
  }

  /*
   * ============================================================
   * STORE SELECTION
   * ============================================================
   */

  private async ensureStoreSelected(
    page: Page,
    productUrl: string
  ): Promise<void> {
    /*
     * If Wairau Park is already on the product page,
     * don't open the store selector at all.
     *
     * This is important for performance when n8n makes
     * many separate calls.
     */
    if (
      await this.isStoreAlreadyPresent(
        page
      )
    ) {
      logger.info(
        `Supercheap Auto ${this.storeName} is already present. ` +
          `Skipping store selection.`
      );

      return;
    }

    logger.info(
      `Selecting Supercheap Auto store ${this.storeName} ` +
        `(${this.postalCode}), store ID ${this.storeId}`
    );

    try {
      /*
       * --------------------------------------------------------
       * 1. Open Change Store
       * --------------------------------------------------------
       */

      const changeStoreButton =
        page
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

      const changeStoreVisible =
        await changeStoreButton
          .isVisible({
            timeout: 3000,
          })
          .catch(() => false);

      if (changeStoreVisible) {
        await changeStoreButton.click({
          timeout: 5000,
        });
      }

      /*
       * --------------------------------------------------------
       * 2. Click "Change" in fulfilment panel if required
       * --------------------------------------------------------
       */

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
          timeout: 5000,
        });
      }

      /*
       * --------------------------------------------------------
       * 3. Find postcode input
       * --------------------------------------------------------
       */

      const postcodeInput =
        page
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
        timeout:
          this.storeWaitTimeout,
      });

      const inputDetails =
        await postcodeInput.evaluate(
          (
            element: HTMLInputElement
          ) => ({
            id:
              element.id ||
              null,
            name:
              element.name ||
              null,
            type:
              element.type ||
              null,
            placeholder:
              element.placeholder ||
              null,
          })
        );

      /*
       * Never accidentally use the global product search.
       */
      if (
        inputDetails.name
          ?.toLowerCase() ===
          'q' ||
        /search products|what are you looking for/i.test(
          inputDetails.placeholder ||
            ''
        )
      ) {
        throw new Error(
          `The selected input appears to be the global product search input: ` +
            `${JSON.stringify(
              inputDetails
            )}`
        );
      }

      await postcodeInput.fill(
        this.postalCode
      );

      /*
       * --------------------------------------------------------
       * 4. Search for store
       * --------------------------------------------------------
       */

      const storeSearchButton =
        page
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

      const searchVisible =
        await storeSearchButton
          .isVisible({
            timeout: 2000,
          })
          .catch(() => false);

      if (searchVisible) {
        await storeSearchButton.click({
          timeout: 5000,
        });
      }

      /*
       * --------------------------------------------------------
       * 5. Find Wairau Park
       * --------------------------------------------------------
       *
       * Store selection modal uses:
       *
       * .fulfilment-store-item[data-id="7030"]
       *
       * This is ONLY for selecting the store.
       *
       * Product availability later uses:
       *
       * .store-item[data-store-id="7030"]
       */

      const wairauStore =
        page
          .locator(
            [
              `.fulfilment-store-item[data-id="${this.storeId}"]`,
              `.fulfilment-store-item[data-preferred-id="${this.storeId}"]`,
              `.fulfilment-store-item[data-name="${this.storeName}"]`,
              `.fulfilment-store-item:has(.store-name:text-is("${this.storeName}"))`,
            ].join(', ')
          )
          .first();

      await wairauStore.waitFor({
        state: 'visible',
        timeout:
          this.storeWaitTimeout,
      });

      const storeDetails =
        await wairauStore.evaluate(
          (element) => ({
            storeName:
              element.getAttribute(
                'data-name'
              ) ||
              element
                .querySelector(
                  '.store-name'
                )
                ?.textContent
                ?.replace(
                  /\s+/g,
                  ' '
                )
                .trim() ||
              null,

            dataId:
              element.getAttribute(
                'data-id'
              ),

            preferredId:
              element.getAttribute(
                'data-preferred-id'
              ),
          })
        );

      logger.info(
        `Supercheap Auto store result: ${JSON.stringify(
          storeDetails
        )}`
      );

      /*
       * Safety check.
       */
      if (
        storeDetails.dataId !==
          this.storeId &&
        storeDetails.preferredId !==
          this.storeId &&
        storeDetails.storeName !==
          this.storeName
      ) {
        throw new Error(
          `Unexpected store selected: ${JSON.stringify(
            storeDetails
          )}`
        );
      }

      await wairauStore.scrollIntoViewIfNeeded();

      await wairauStore.click({
        timeout: 5000,
      });

      /*
       * --------------------------------------------------------
       * 6. Confirm selection
       * --------------------------------------------------------
       */

      const confirmButton =
        page
          .locator(
            [
              `button.fulfilment-cta[data-selected-id="${this.storeId}"]`,
              `button.fulfilment-cta[data-preferred-id="${this.storeId}"]`,
              'button.fulfilment-cta:has-text("Confirm")',
            ].join(', ')
          )
          .first();

      const confirmVisible =
        await confirmButton
          .isVisible({
            timeout: 5000,
          })
          .catch(() => false);

      if (confirmVisible) {
        await confirmButton.click({
          timeout: 5000,
        });
      }

      /*
       * Do NOT use networkidle.
       *
       * The store selection is AJAX-driven and the product
       * store element will tell us when the update is ready.
       */
      logger.info(
        `Supercheap Auto store selection submitted for ${this.storeName}`
      );

      /*
       * --------------------------------------------------------
       * 7. Wait for product-page store element
       * --------------------------------------------------------
       */

      await this.waitForProductStoreElement(
        page
      );

      /*
       * Make sure we didn't accidentally land on search.
       */
      await this.restoreProductPage(
        page,
        productUrl
      );
    } catch (error) {
      logger.warn(
        `Supercheap Auto store selection failed: ${
          error instanceof Error
            ? error.message
            : String(error)
        }`
      );

      /*
       * If store selection failed but the product page itself
       * is still valid, allow extraction to continue.
       */
      await this.restoreProductPage(
        page,
        productUrl
      );
    }
  }

  /*
   * ============================================================
   * PRODUCT STORE ELEMENT
   * ============================================================
   */

  private async waitForProductStoreElement(
    page: Page
  ): Promise<void> {
    const selector =
      this.getProductStoreSelector();

    await page
      .locator(selector)
      .first()
      .waitFor({
        state: 'visible',
        timeout:
          this.storeWaitTimeout,
      })
      .catch(() => {
        logger.warn(
          `Supercheap Auto product store element ${selector} ` +
            `was not detected within ${this.storeWaitTimeout}ms`
        );
      });
  }

  /*
   * ============================================================
   * SKU
   * ============================================================
   *
   * The URL itself is a reliable fallback:
   *
   * /518963.html
   * /663684.html
   */

  private async extractSku(
    page: Page
  ): Promise<string | null> {
    return page.evaluate(
      () => {
        const clean =
          (
            value:
              | string
              | null
              | undefined
          ): string | null => {
            if (!value) {
              return null;
            }

            const result =
              value
                .replace(
                  /\u00a0/g,
                  ' '
                )
                .replace(
                  /\s+/g,
                  ' '
                )
                .trim();

            return result || null;
          };

        /*
         * 1. Meta SKU
         */
        const meta =
          document.querySelector(
            'meta[itemprop="productID"], meta[itemprop="sku"]'
          );

        const metaValue =
          clean(
            meta?.getAttribute(
              'content'
            )
          );

        if (metaValue) {
          return metaValue;
        }

        /*
         * 2. data-masterid
         */
        const master =
          document.querySelector(
            '[data-masterid]'
          );

        const masterValue =
          clean(
            master?.getAttribute(
              'data-masterid'
            )
          );

        if (masterValue) {
          return masterValue;
        }

        /*
         * 3. Product number text
         */
        const productNumber =
          document.querySelector(
            [
              '.product-number',
              '[class*="product-number" i]',
              '[class*="product-code" i]',
              '[class*="item-number" i]',
              '[class*="sku" i]',
            ].join(', ')
          );

        const productNumberText =
          clean(
            productNumber?.textContent
          );

        const match =
          productNumberText?.match(
            /(?:Item\s*No\.?|SKU|Product\s*Code)\s*:?\s*([A-Z0-9._-]+)/i
          );

        if (match) {
          return match[1];
        }

        /*
         * 4. URL fallback
         *
         * /.../663684.html
         */
        const urlMatch =
          window.location.pathname.match(
            /\/([A-Za-z0-9_-]+)\.html(?:\/)?$/
          );

        if (urlMatch) {
          return urlMatch[1];
        }

        return null;
      }
    );
  }

  /*
   * ============================================================
   * WAIT FOR INVENTORY
   * ============================================================
   *
   * We wait for the ACTUAL product-page store element:
   *
   * .store-item[data-store-id="7030"]
   *
   * Then we wait until:
   *
   *   data-products
   *
   * contains the SKU.
   *
   * Example:
   *
   * {
   *   "available": ["663684"],
   *   "unavailable": [],
   *   "specialProduct": [],
   *   "lowStock": []
   * }
   *
   * We also support:
   *
   * data-status="available"
   *
   * and:
   *
   * <span class="text-status pdp">
   *   In Stock
   * </span>
   */

  private async waitForInventory(
    page: Page,
    sku: string | null
  ): Promise<void> {
    const selector =
      this.getProductStoreSelector();

    try {
      await page.waitForFunction(
        ({
          selector,
          sku,
        }) => {
          const store =
            document.querySelector(
              selector
            );

          if (!store) {
            return false;
          }

          /*
           * ------------------------------------------------------
           * data-status
           * ------------------------------------------------------
           */

          const status =
            store.getAttribute(
              'data-status'
            );

          if (
            status ===
              'available' ||
            status ===
              'unavailable'
          ) {
            return true;
          }

          /*
           * ------------------------------------------------------
           * data-products
           * ------------------------------------------------------
           */

          const productsJson =
            store.getAttribute(
              'data-products'
            );

          if (
            productsJson &&
            sku
          ) {
            try {
              const products =
                JSON.parse(
                  productsJson
                ) as StoreProducts;

              const available =
                Array.isArray(
                  products.available
                )
                  ? products.available
                  : [];

              const unavailable =
                Array.isArray(
                  products.unavailable
                )
                  ? products.unavailable
                  : [];

              const lowStock =
                Array.isArray(
                  products.lowStock
                )
                  ? products.lowStock
                  : [];

              if (
                available.includes(
                  sku
                ) ||
                unavailable.includes(
                  sku
                ) ||
                lowStock.includes(
                  sku
                )
              ) {
                return true;
              }
            } catch {
              /*
               * AJAX may have written incomplete JSON.
               * Keep polling.
               */
            }
          }

          /*
           * ------------------------------------------------------
           * Visible status text
           * ------------------------------------------------------
           */

          const statusText =
            store
              .querySelector(
                '.text-status.pdp'
              )
              ?.textContent
              ?.replace(
                /\s+/g,
                ' '
              )
              .trim() || '';

          if (
            /\bin\s+stock\b/i.test(
              statusText
            ) ||
            /\bout\s+of\s+stock\b/i.test(
              statusText
            ) ||
            /\bunavailable\b/i.test(
              statusText
            )
          ) {
            return true;
          }

          return false;
        },
        {
          selector,
          sku,
        },
        {
          timeout:
            this.inventoryWaitTimeout,
          polling: 200,
        }
      );

      logger.debug(
        `Supercheap Auto inventory data is ready for SKU ${sku}`
      );
    } catch {
      logger.warn(
        `Supercheap Auto inventory did not fully resolve within ` +
          `${this.inventoryWaitTimeout}ms for SKU ${sku}`
      );
    }
  }

  /*
   * ============================================================
   * PRODUCT EXTRACTION
   * ============================================================
   */

  private async extractProduct(
    page: Page
  ): Promise<ExtractedProduct> {
    const expectedStoreId =
      this.storeId;

    return page.evaluate(
      ({
        expectedStoreId,
      }) => {
        /*
         * --------------------------------------------------------
         * Types
         * --------------------------------------------------------
         */

        const cleanText =
          (
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
                .replace(
                  /\u00a0/g,
                  ' '
                )
                .replace(
                  /\s+/g,
                  ' '
                )
                .trim();

            return cleaned || null;
          };

        const parsePrice =
          (
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
                .replace(
                  /\u00a0/g,
                  ' '
                )
                .replace(
                  /,/g,
                  ''
                )
                .trim();

            const match =
              text.match(
                /(?:NZD|NZ|\$)?\s*(\d+(?:\.\d{1,2})?)/
              );

            if (!match) {
              return null;
            }

            const parsed =
              Number(
                match[1]
              );

            return Number.isFinite(
              parsed
            )
              ? parsed
              : null;
          };

        const getText =
          (
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

        const getAttribute =
          (
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

        const getFirstText =
          (
            selectors: string[]
          ): {
            value: string | null;
            selector: string | null;
          } => {
            for (
              const selector of selectors
            ) {
              const value =
                getText(
                  selector
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

        const diagnostics: ExtractionDiagnostics =
          {
            nameSource:
              null,
            skuSource:
              null,
            priceSource:
              null,
            originalPriceSource:
              null,
            saleEndDateSource:
              null,
            storeSource:
              null,
            availabilitySource:
              null,
          };

        /*
         * --------------------------------------------------------
         * NAME
         * --------------------------------------------------------
         */

        let name:
          string | null = null;

        /*
         * pageContext
         */
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
            /*
             * Ignore malformed pageContext.
             */
          }
        }

        /*
         * H1 fallback
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
            name =
              result.value;

            diagnostics.nameSource =
              `DOM:${result.selector}`;
          }
        }

        /*
         * Title fallback
         */
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
         * --------------------------------------------------------
         * SKU
         * --------------------------------------------------------
         */

        let sku:
          string | null = null;

        /*
         * Meta
         */
        const metaSku =
          getAttribute(
            'meta[itemprop="productID"]',
            'content'
          ) ||
          getAttribute(
            'meta[itemprop="sku"]',
            'content'
          );

        if (metaSku) {
          sku =
            metaSku;

          diagnostics.skuSource =
            'META:itemprop=productID/sku';
        }

        /*
         * data-masterid
         */
        if (!sku) {
          const master =
            document.querySelector(
              '[data-masterid]'
            );

          const value =
            cleanText(
              master?.getAttribute(
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

        /*
         * Product number
         */
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
         * URL fallback.
         *
         * Example:
         *
         * /663684.html
         */
        if (!sku) {
          const urlMatch =
            window.location.pathname.match(
              /\/([A-Za-z0-9_-]+)\.html(?:\/)?$/
            );

          if (urlMatch) {
            sku =
              urlMatch[1];

            diagnostics.skuSource =
              'URL:product-id';
          }
        }

        /*
         * --------------------------------------------------------
         * PRICE
         * --------------------------------------------------------
         */

        let price:
          number | null = null;

        const priceSelectors =
          [
            '.price-sales .promo-price',
            '.promo-price',
            '.price-sales',
            '[class*="promo-price" i]',
            '[class*="sale-price" i]',
            '[class*="price-sales" i]',
            '[itemprop="price"]',
          ];

        for (
          const selector of
            priceSelectors
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
            candidate !==
            null
          ) {
            price =
              candidate;

            diagnostics.priceSource =
              `DOM:${selector}`;

            break;
          }
        }

        /*
         * --------------------------------------------------------
         * ORIGINAL PRICE
         * --------------------------------------------------------
         */

        let originalPrice:
          number | null = null;

        const originalPriceSelectors =
          [
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
            candidate !==
              null &&
            (
              price ===
                null ||
              candidate >
                price
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
         * "Was $xxx" fallback
         */
        if (
          originalPrice ===
          null
        ) {
          const bodyText =
            cleanText(
              document.body
                ?.innerText
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
              candidate !==
                null &&
              (
                price ===
                  null ||
                candidate >
                  price
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
         * --------------------------------------------------------
         * SALE END DATE
         * --------------------------------------------------------
         */

        let saleEndDate:
          string | null =
            null;

        const saleEnd =
          getFirstText([
            '.saleprice-end-date',
            '[class*="saleprice-end-date" i]',
            '[class*="sale-end-date" i]',
            '[class*="promotion-end" i]',
            '[class*="promo-end" i]',
          ]);

        if (saleEnd.value) {
          const dateMatch =
            saleEnd.value.match(
              /(\d{1,2}\/\d{1,2}\/\d{2,4})/
            );

          saleEndDate =
            dateMatch
              ? dateMatch[1]
              : saleEnd.value;

          diagnostics.saleEndDateSource =
            `DOM:${saleEnd.selector}`;
        }

        /*
         * ========================================================
         * STORE + AVAILABILITY
         * ========================================================
         *
         * THIS IS THE IMPORTANT PART.
         *
         * Actual HTML:
         *
         * <div
         *   class="store-item pdp available"
         *   data-store-id="7030"
         *   data-status="available"
         *   data-products="..."
         * >
         *
         * <span class="text-status pdp">
         *   In Stock
         * </span>
         *
         * </div>
         */

        let store:
          string | null = null;

        let availability:
          Availability =
            'unknown';

        const storeSelector =
          `.store-item[data-store-id="${expectedStoreId}"]`;

        const storeElement =
          document.querySelector(
            storeSelector
          );

        if (storeElement) {
          /*
           * ------------------------------------------------------
           * Store name
           * ------------------------------------------------------
           */

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
              `DOM:${storeSelector}`;
          }

          /*
           * ------------------------------------------------------
           * 1. data-products
           * ------------------------------------------------------
           *
           * This is the strongest product-specific signal.
           */

          const productsJson =
            storeElement.getAttribute(
              'data-products'
            );

          if (
            productsJson &&
            sku
          ) {
            try {
              const products =
                JSON.parse(
                  productsJson
                ) as StoreProducts;

              const available =
                Array.isArray(
                  products.available
                )
                  ? products.available
                  : [];

              const unavailable =
                Array.isArray(
                  products.unavailable
                )
                  ? products.unavailable
                  : [];

              const lowStock =
                Array.isArray(
                  products.lowStock
                )
                  ? products.lowStock
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
                /*
                 * Low stock still means the item is in stock.
                 */
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
            } catch {
              /*
               * Ignore malformed JSON.
               */
            }
          }

          /*
           * ------------------------------------------------------
           * 2. data-status
           * ------------------------------------------------------
           */

          if (
            availability ===
            'unknown'
          ) {
            const dataStatus =
              cleanText(
                storeElement.getAttribute(
                  'data-status'
                )
              );

            if (
              dataStatus?.toLowerCase() ===
              'available'
            ) {
              availability =
                'in_stock';

              diagnostics.availabilitySource =
                'data-status=available';
            } else if (
              dataStatus?.toLowerCase() ===
                'unavailable' ||
              dataStatus?.toLowerCase() ===
                'out_of_stock' ||
              dataStatus?.toLowerCase() ===
                'out-of-stock'
            ) {
              availability =
                'out_of_stock';

              diagnostics.availabilitySource =
                `data-status=${dataStatus}`;
            }
          }

          /*
           * ------------------------------------------------------
           * 3. Actual visible text
           * ------------------------------------------------------
           *
           * Your supplied HTML:
           *
           * <span class="text-status pdp">
           *     In Stock
           * </span>
           */

          if (
            availability ===
            'unknown'
          ) {
            const statusElement =
              storeElement.querySelector(
                '.text-status.pdp'
              );

            const statusText =
              cleanText(
                statusElement
                  ?.textContent
              );

            if (
              /\bin\s+stock\b/i.test(
                statusText ||
                  ''
              )
            ) {
              availability =
                'in_stock';

              diagnostics.availabilitySource =
                'DOM:.store-item .text-status.pdp';
            } else if (
              /\bout\s+of\s+stock\b/i.test(
                statusText ||
                  ''
              ) ||
              /\bunavailable\b/i.test(
                statusText ||
                  ''
              ) ||
              /\bnot\s+available\b/i.test(
                statusText ||
                  ''
              )
            ) {
              availability =
                'out_of_stock';

              diagnostics.availabilitySource =
                'DOM:.store-item .text-status.pdp';
            }
          }

          /*
           * ------------------------------------------------------
           * 4. Generic store class fallback
           * ------------------------------------------------------
           */

          if (
            availability ===
            'unknown'
          ) {
            const className =
              storeElement.className ||
              '';

            if (
              /\bavailable\b/i.test(
                className
              )
            ) {
              availability =
                'in_stock';

              diagnostics.availabilitySource =
                'DOM:.store-item.available';
            }
          }
        }

        /*
         * --------------------------------------------------------
         * Final fallback:
         *
         * Do NOT use general page availability here.
         *
         * We specifically want availability for Wairau Park.
         * --------------------------------------------------------
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
        expectedStoreId,
      }
    );
  }

  /*
   * ============================================================
   * MAIN SCRAPER
   * ============================================================
   */

  async scrapeProduct(
    url: string
  ): Promise<SupercheapAutoScrapedProduct> {
    let page:
      | Page
      | null = null;

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
       * --------------------------------------------------------
       * 1. Load product page
       * --------------------------------------------------------
       */

      await page.goto(
        url,
        {
          waitUntil:
            'domcontentloaded',
          timeout:
            this.navigationTimeout,
        }
      );

      const productPageUrl =
        page.url();

      if (
        this.isSearchResultsUrl(
          productPageUrl
        )
      ) {
        throw new Error(
          `Supercheap Auto URL resolved to search results: ${productPageUrl}`
        );
      }

      /*
       * Wait for actual product content.
       */
      await this.waitForProductPage(
        page
      );

      /*
       * --------------------------------------------------------
       * 2. Select Wairau Park
       * --------------------------------------------------------
       */

      await this.ensureStoreSelected(
        page,
        productPageUrl
      );

      /*
       * Make absolutely sure we're still on product page.
       */
      await this.restoreProductPage(
        page,
        productPageUrl
      );

      await this.validateProductPage(
        page,
        productPageUrl
      );

      /*
       * --------------------------------------------------------
       * 3. Extract SKU first
       * --------------------------------------------------------
       */

      const sku =
        await this.extractSku(
          page
        );

      logger.debug(
        `Supercheap Auto SKU detected: ${sku}`
      );

      /*
       * --------------------------------------------------------
       * 4. Wait for Wairau Park inventory
       * --------------------------------------------------------
       *
       * This waits for the ACTUAL:
       *
       * .store-item[data-store-id="7030"]
       *
       * and its data-products/status.
       */

      await this.waitForInventory(
        page,
        sku
      );

      /*
       * --------------------------------------------------------
       * 5. Extract everything
       * --------------------------------------------------------
       */

      const product =
        await this.extractProduct(
          page
        );

      const durationMs =
        Date.now() -
        startTime;

      logger.info(
        `Supercheap Auto extraction result: ${JSON.stringify(
          {
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
            availabilitySource:
              product
                .diagnostics
                .availabilitySource,
            durationMs,
          }
        )}`
      );

      /*
       * --------------------------------------------------------
       * Diagnostics / warnings
       * --------------------------------------------------------
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
        product.price ===
        null
      ) {
        logger.warn(
          `Supercheap Auto price could not be extracted: ${url}`
        );
      }

      if (!product.store) {
        logger.warn(
          `Supercheap Auto could not confirm store ${this.storeName}: ${url}`
        );
      }

      if (
        product.availability ===
        'unknown'
      ) {
        logger.warn(
          `Supercheap Auto availability is still unknown for ` +
            `SKU ${product.sku}, store ${this.storeName}. ` +
            `Source: ${product.diagnostics.availabilitySource}`
        );
      }

      /*
       * --------------------------------------------------------
       * Return
       * --------------------------------------------------------
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
