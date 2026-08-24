import { Page } from 'playwright';
import logger from '../../config/logger';
import { browserService } from '../browser.service';
import { ProductScraperAdapter } from './scraper-adapter.interface';
import { WoolworthsScrapedProduct } from '../../types/product-scrape.types';

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
  savingsSource: string | null;
  packageSizeSource: string | null;
  cupPriceSource: string | null;
  availabilitySource: string | null;
}

interface ExtractedProduct {
  name: string | null;
  sku: string | null;
  price: number | null;
  originalPrice: number | null;
  savings: number | null;
  packageSize: string | null;
  cupPrice: string | null;
  availability: Availability;
  canonicalUrl: string;
  diagnostics: ExtractionDiagnostics;
}

export class WoolworthsAdapter
  implements ProductScraperAdapter
{
  readonly site = 'woolworths' as const;

  /*
   * ============================================================
   * CONFIGURATION
   * ============================================================
   */

  private readonly storeName =
    'Woolworths Birkenhead';

  private readonly regionName =
    'Auckland (North)';

  private readonly regionValue =
    '600';

  private readonly navigationTimeout =
    60000;

  private readonly storeSelectionTimeout =
    20000;

  /*
   * ============================================================
   * URL
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
          'woolworths.co.nz' ||
        hostname.endsWith(
          '.woolworths.co.nz'
        )
      );
    } catch {
      return false;
    }
  }

  /*
   * ============================================================
   * HELPERS
   * ============================================================
   */

  private cleanText(
    value:
      | string
      | null
      | undefined
  ): string | null {
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
  }

  private escapeRegExp(
    value: string
  ): string {
    return value.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&'
    );
  }

  private storeShortName(): string {
    return this.storeName
      .replace(
        /^Woolworths\s+/i,
        ''
      )
      .trim();
  }

  /*
   * ============================================================
   * FAST STORE CHECK
   * ============================================================
   *
   * Woolworths displays the selected store in:
   *
   * global-nav-how-where-when-bar
   *
   * If Birkenhead is already selected, don't open the selector.
   *
   * This is particularly important because browserService now
   * persists the Woolworths context between separate n8n calls.
   */

  private async isStoreAlreadyConfigured(
    page: Page
  ): Promise<boolean> {
    const banner =
      page
        .locator(
          'global-nav-how-where-when-bar .information-message'
        )
        .first();

    const text =
      await banner
        .textContent({
          timeout: 3000,
        })
        .catch(
          () => null
        );

    const cleaned =
      this.cleanText(text) ||
      '';

    const configured =
      new RegExp(
        `${this.escapeRegExp(
          this.storeShortName()
        )}\\s+store`,
        'i'
      ).test(
        cleaned
      );

    logger.debug(
      `Woolworths store check: ${
        configured
          ? 'configured'
          : 'not configured'
      }; banner="${cleaned}"`
    );

    return configured;
  }

  /*
   * ============================================================
   * STORE SELECTION
   * ============================================================
   */

  private async openChangeLocation(
    page: Page
  ): Promise<void> {
    const selector =
      [
        'a.actionButtonLink[aria-label="Change location"]',
        'a:has-text("Change location")',
        'button:has-text("Change location")',
      ].join(', ');

    const button =
      page
        .locator(selector)
        .first();

    await button.waitFor({
      state: 'visible',
      timeout:
        this.storeSelectionTimeout,
    });

    logger.debug(
      'Woolworths: clicking Change location'
    );

    await button.click({
      timeout: 10000,
    });
  }

  private async selectPickup(
    page: Page
  ): Promise<void> {
    const selector =
      [
        'form-selection-tile[data-cy="selectionTilePickup"]',
        'label[for="method-pickup"]',
        '#method-pickup',
      ].join(', ');

    const pickup =
      page
        .locator(selector)
        .first();

    await pickup.waitFor({
      state: 'visible',
      timeout:
        this.storeSelectionTimeout,
    });

    logger.debug(
      'Woolworths: selecting Pick up'
    );

    await pickup.click({
      timeout: 10000,
    });
  }

  private async openChangeStore(
    page: Page
  ): Promise<void> {
    const selector =
      [
        'button[data-cy="link"]:has-text("Change store")',
        'button:has-text("Change store")',
        'a:has-text("Change store")',
      ].join(', ');

    const button =
      page
        .locator(selector)
        .first();

    await button.waitFor({
      state: 'visible',
      timeout:
        this.storeSelectionTimeout,
    });

    logger.debug(
      'Woolworths: clicking Change store'
    );

    await button.click({
      timeout: 10000,
    });
  }

  private async selectRegion(
    page: Page
  ): Promise<void> {
    const selector =
      [
        'select#area-dropdown-1',
        'select[name="area-dropdown-1"]',
        'select[id*="area-dropdown"]',
      ].join(', ');

    const region =
      page
        .locator(selector)
        .first();

    await region.waitFor({
      state: 'visible',
      timeout:
        this.storeSelectionTimeout,
    });

    logger.debug(
      `Woolworths: selecting region ${this.regionName}`
    );

    try {
      await region.selectOption({
        value:
          this.regionValue,
      });
    } catch {
      logger.debug(
        `Woolworths region value "${this.regionValue}" ` +
          `not found; falling back to label`
      );

      await region.selectOption({
        label:
          this.regionName,
      });
    }

    /*
     * Give React/the page a very short opportunity to update
     * the store list after changing the region.
     */
    await page
      .waitForTimeout(300);
  }

  private async selectStore(
    page: Page
  ): Promise<void> {
    const storeList =
      page.locator(
        'fulfilment-address-selector .addressList'
      );

    await storeList.waitFor({
      state: 'visible',
      timeout:
        this.storeSelectionTimeout,
    });

    /*
     * Primary selector.
     */
    let storeItem =
      page
        .locator(
          'fulfilment-address-selector .addressList-item'
        )
        .filter({
          hasText:
            this.storeName,
        })
        .first();

    let visible =
      await storeItem
        .isVisible({
          timeout: 5000,
        })
        .catch(
          () => false
        );

    /*
     * Fallback if the exact text filtering doesn't work because
     * Woolworths changes the markup slightly.
     */
    if (!visible) {
      storeItem =
        page
          .locator(
            'fulfilment-address-selector .addressList-item'
          )
          .filter({
            has: page.locator(
              `.addressList-title:has-text("${this.storeName}")`
            ),
          })
          .first();

      visible =
        await storeItem
          .isVisible({
            timeout: 5000,
          })
          .catch(
            () => false
          );
    }

    if (!visible) {
      throw new Error(
        `Woolworths store "${this.storeName}" ` +
          `could not be found in the store list`
      );
    }

    const storeButton =
      storeItem
        .locator(
          'button.addressList-button'
        )
        .first();

    await storeButton.waitFor({
      state: 'visible',
      timeout: 10000,
    });

    const ariaDisabled =
      await storeButton.getAttribute(
        'aria-disabled'
      );

    if (
      ariaDisabled ===
      'true'
    ) {
      logger.debug(
        `Woolworths ${this.storeName} ` +
          `is already selected`
      );

      return;
    }

    logger.debug(
      `Woolworths: selecting ${this.storeName}`
    );

    await storeButton
      .scrollIntoViewIfNeeded();

    await storeButton.click({
      timeout: 10000,
    });
  }

  private async confirmKeepShopping(
    page: Page
  ): Promise<void> {
    const selector =
      [
        'button.actionBar-keepShoppingButton',
        'button:has-text("Keep shopping")',
      ].join(', ');

    const button =
      page
        .locator(selector)
        .first();

    const visible =
      await button
        .isVisible({
          timeout: 5000,
        })
        .catch(
          () => false
        );

    if (!visible) {
      logger.debug(
        'Woolworths: no Keep shopping button; ' +
          'assuming store selector closed automatically'
      );

      return;
    }

    logger.debug(
      'Woolworths: clicking Keep shopping'
    );

    await button.click({
      timeout: 10000,
    });
  }

  /*
   * ============================================================
   * FULL STORE SELECTION
   * ============================================================
   */

  private async ensureStoreSelected(
    page: Page
  ): Promise<boolean> {
    try {
      logger.info(
        `Woolworths: selecting ${this.storeName} ` +
          `(${this.regionName})`
      );

      await this.openChangeLocation(
        page
      );

      await this.selectPickup(
        page
      );

      await this.openChangeStore(
        page
      );

      await this.selectRegion(
        page
      );

      await this.selectStore(
        page
      );

      await this.confirmKeepShopping(
        page
      );

      /*
       * Wait for the store banner rather than networkidle.
       *
       * Woolworths is an AJAX/React-style site and networkidle
       * is unnecessary here.
       */
      const configured =
        await this.waitForStoreBanner(
          page,
          10000
        );

      if (!configured) {
        logger.warn(
          `Woolworths store selection completed but ` +
            `the page did not confirm ${this.storeName}`
        );

        return false;
      }

      /*
       * Persist cookies/localStorage.
       *
       * BrowserService now has a persistent per-site context,
       * so subsequent n8n calls can skip this whole flow.
       */
      await browserService
        .persistStorageState(
          'woolworths'
        );

      logger.info(
        `Woolworths store ${this.storeName} ` +
          `selected and storage state persisted`
      );

      return true;
    } catch (error) {
      logger.error(
        `Woolworths store selection failed:`,
        error
      );

      return false;
    }
  }

  /*
   * ============================================================
   * WAIT FOR STORE BANNER
   * ============================================================
   */

  private async waitForStoreBanner(
    page: Page,
    timeout: number
  ): Promise<boolean> {
    try {
      await page.waitForFunction(
        ({
          storeShortName,
        }) => {
          const element =
            document.querySelector(
              'global-nav-how-where-when-bar .information-message'
            );

          const text =
            element
              ?.textContent
              ?.replace(
                /\s+/g,
                ' '
              )
              .trim() || '';

          const escaped =
            storeShortName.replace(
              /[.*+?^${}()|[\]\\]/g,
              '\\$&'
            );

          return new RegExp(
            `${escaped}\\s+store`,
            'i'
          ).test(text);
        },
        {
          storeShortName:
            this.storeShortName(),
        },
        {
          timeout,
          polling: 200,
        }
      );

      return true;
    } catch {
      return false;
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
    return page.evaluate(
      (): ExtractedProduct => {
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

        const parseMoney =
          (
            value:
              | string
              | null
              | undefined
          ): number | null => {
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
                  /,/g,
                  ''
                );

            /*
             * Woolworths sometimes uses:
             *
             * "$26.89 each"
             * "26.89"
             * "Was 46.00"
             * "Was 46$"
             */
            const match =
              cleaned.match(
                /(\d+(?:\.\d{1,2})?)/
              );

            if (!match) {
              return null;
            }

            const valueNumber =
              Number(
                match[1]
              );

            return Number.isFinite(
              valueNumber
            )
              ? valueNumber
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

        const diagnostics:
          ExtractionDiagnostics = {
          nameSource: null,
          skuSource: null,
          priceSource: null,
          originalPriceSource:
            null,
          savingsSource: null,
          packageSizeSource:
            null,
          cupPriceSource: null,
          availabilitySource:
            null,
        };

        /*
         * ========================================================
         * NAME
         * ========================================================
         */

        let name:
          string | null = null;

        const nameSelectors =
          [
            'h1.product-title',
            'h1[itemprop="name"]',
            '[itemprop="name"]',
            'h1[class*="product-title" i]',
            'h1[class*="product-name" i]',
            'h1',
          ];

        for (
          const selector of
            nameSelectors
        ) {
          const value =
            getText(
              selector
            );

          if (value) {
            name =
              value;

            diagnostics.nameSource =
              `DOM:${selector}`;

            break;
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
                  /\s*\|\s*Woolworths\s*$/i,
                  ''
                )
                .trim();

            diagnostics.nameSource =
              'document.title';
          }
        }

        /*
         * ========================================================
         * SKU
         * ========================================================
         *
         * Existing Woolworths markup uses:
         *
         * product-724632-top-price
         *
         * Therefore 724632 is the SKU/product ID.
         */

        let sku:
          string | null = null;

        const idCarrier =
          document.querySelector(
            '[id^="product-"][id$="-top-price"]'
          );

        if (idCarrier) {
          const match =
            idCarrier.id.match(
              /^product-(\d+)-top-price$/
            );

          if (match) {
            sku =
              match[1];

            diagnostics.skuSource =
              'DOM:id=product-{id}-top-price';
          }
        }

        /*
         * Fallback: any product-{number} element.
         */
        if (!sku) {
          const elements =
            Array.from(
              document.querySelectorAll(
                '[id^="product-"]'
              )
            );

          for (
            const element of
              elements
          ) {
            const match =
              element.id.match(
                /^product-(\d+)/
              );

            if (match) {
              sku =
                match[1];

              diagnostics.skuSource =
                'DOM:id=product-{id}';

              break;
            }
          }
        }

        /*
         * ========================================================
         * CURRENT PRICE
         * ========================================================
         */

        let price:
          number | null = null;

        const priceSelectors =
          [
            '.presentPrice',
            '[id$="-top-price"]',
            '[class*="presentPrice" i]',
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

          const ariaPrice =
            element.getAttribute(
              'aria-label'
            );

          const fromAria =
            parseMoney(
              ariaPrice
            );

          if (
            fromAria !==
            null
          ) {
            price =
              fromAria;

            diagnostics.priceSource =
              `ATTR:${selector}[aria-label]`;

            break;
          }

          const fromText =
            parseMoney(
              element.textContent
            );

          if (
            fromText !==
            null
          ) {
            price =
              fromText;

            diagnostics.priceSource =
              `DOM:${selector}`;

            break;
          }
        }

        /*
         * ========================================================
         * ORIGINAL PRICE
         * ========================================================
         */

        let originalPrice:
          number | null = null;

        const wasSelectors =
          [
            '.price--was',
            '[aria-label^="Was" i]',
            '[class*="price--was" i]',
            '[class*="was-price" i]',
          ];

        for (
          const selector of
            wasSelectors
        ) {
          const element =
            document.querySelector(
              selector
            );

          if (!element) {
            continue;
          }

          const fromText =
            parseMoney(
              element.textContent
            );

          if (
            fromText !==
              null &&
            (
              price ===
                null ||
              fromText >
                price
            )
          ) {
            originalPrice =
              fromText;

            diagnostics.originalPriceSource =
              `DOM:${selector}`;

            break;
          }

          const fromAria =
            parseMoney(
              element.getAttribute(
                'aria-label'
              )
            );

          if (
            fromAria !==
              null &&
            (
              price ===
                null ||
              fromAria >
                price
            )
          ) {
            originalPrice =
              fromAria;

            diagnostics.originalPriceSource =
              `ATTR:${selector}[aria-label]`;

            break;
          }
        }

        /*
         * Text fallback:
         *
         * Was 46.00
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

          const match =
            bodyText.match(
              /\bWas\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i
            );

          if (match) {
            const candidate =
              parseMoney(
                match[1]
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
         * ========================================================
         * SAVINGS
         * ========================================================
         */

        let savings:
          number | null = null;

        const saveSelectors =
          [
            '.price--save',
            '[aria-label^="Save" i]',
            '[class*="price--save" i]',
            '[class*="save-price" i]',
          ];

        for (
          const selector of
            saveSelectors
        ) {
          const element =
            document.querySelector(
              selector
            );

          if (!element) {
            continue;
          }

          const value =
            parseMoney(
              element.textContent
            ) ??
            parseMoney(
              element.getAttribute(
                'aria-label'
              )
            );

          if (
            value !== null
          ) {
            savings =
              value;

            diagnostics.savingsSource =
              `DOM:${selector}`;

            break;
          }
        }

        /*
         * If Woolworths doesn't expose savings directly,
         * calculate it from original - current price.
         */
        if (
          savings ===
            null &&
          originalPrice !==
            null &&
          price !== null &&
          originalPrice >
            price
        ) {
          savings =
            Number(
              (
                originalPrice -
                price
              ).toFixed(2)
            );

          diagnostics.savingsSource =
            'CALCULATED:originalPrice-price';
        }

        /*
         * ========================================================
         * PACKAGE SIZE
         * ========================================================
         */

        let packageSize:
          string | null = null;

        const sizeSelectors =
          [
            'product-price-meta .size',
            'product-price-meta [class*="size" i]',
            '[class*="product-size" i]',
            '[class*="package-size" i]',
          ];

        for (
          const selector of
            sizeSelectors
        ) {
          const value =
            getText(
              selector
            );

          if (value) {
            packageSize =
              value;

            diagnostics.packageSizeSource =
              `DOM:${selector}`;

            break;
          }
        }

        /*
         * ========================================================
         * CUP PRICE
         * ========================================================
         */

        let cupPrice:
          string | null = null;

        const cupSelectors =
          [
            'product-price-meta .cupPrice',
            'product-price-meta [class*="cupPrice" i]',
            '[class*="cup-price" i]',
            '[class*="unit-price" i]',
          ];

        for (
          const selector of
            cupSelectors
        ) {
          const value =
            getText(
              selector
            );

          if (value) {
            cupPrice =
              value;

            diagnostics.cupPriceSource =
              `DOM:${selector}`;

            break;
          }
        }

        /*
         * ========================================================
         * AVAILABILITY
         * ========================================================
         */

        let availability:
          Availability =
            'unknown';

        const bodyText =
          cleanText(
            document.body
              ?.innerText
          ) || '';

        /*
         * Explicit OUT OF STOCK signals first.
         */
        if (
          /\bout\s+of\s+stock\b/i.test(
            bodyText
          ) ||
          /\bcurrently\s+unavailable\b/i.test(
            bodyText
          ) ||
          /\btemporarily\s+unavailable\b/i.test(
            bodyText
          ) ||
          /\bnot\s+available\b/i.test(
            bodyText
          )
        ) {
          availability =
            'out_of_stock';

          diagnostics.availabilitySource =
            'TEXT:out-of-stock';
        }

        /*
         * Add-to-trolley button.
         */
        if (
          availability ===
          'unknown'
        ) {
          const addButtons =
            Array.from(
              document.querySelectorAll(
                [
                  '[data-cy="addToTrolleyBtn"]',
                  'button',
                  'a',
                ].join(', ')
              )
            );

          const addButton =
            addButtons.find(
              (
                element
              ) => {
                const text =
                  cleanText(
                    element.textContent
                  ) || '';

                return (
                  /add\s+to\s+trolley/i.test(
                    text
                  ) ||
                  /add\s+to\s+cart/i.test(
                    text
                  )
                );
              }
            );

          if (addButton) {
            const disabled =
              addButton.getAttribute(
                'disabled'
              );

            const ariaDisabled =
              addButton.getAttribute(
                'aria-disabled'
              );

            if (
              disabled !==
                null ||
              ariaDisabled ===
                'true'
            ) {
              availability =
                'out_of_stock';

              diagnostics.availabilitySource =
                'DOM:add-to-trolley-disabled';
            } else {
              availability =
                'in_stock';

              diagnostics.availabilitySource =
                'DOM:add-to-trolley';
            }
          }
        }

        /*
         * Explicit "in stock" text.
         */
        if (
          availability ===
          'unknown'
        ) {
          if (
            /\bin\s+stock\b/i.test(
              bodyText
            ) ||
            /\bpick\s+up\s+today\b/i.test(
              bodyText
            ) ||
            /\bavailable\s+for\s+pickup\b/i.test(
              bodyText
            )
          ) {
            availability =
              'in_stock';

            diagnostics.availabilitySource =
              'TEXT:in-stock';
          }
        }

        /*
         * ========================================================
         * CANONICAL URL
         * ========================================================
         */

        const canonical =
          getAttribute(
            'link[rel="canonical"]',
            'href'
          );

        const canonicalUrl =
          canonical ||
          window.location.href;

        return {
          name,
          sku,
          price,
          originalPrice,
          savings,
          packageSize,
          cupPrice,
          availability,
          canonicalUrl,
          diagnostics,
        };
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
  ): Promise<WoolworthsScrapedProduct> {
    let page:
      | Page
      | null = null;

    const startTime =
      Date.now();

    try {
      await browserService.initialize();

      /*
       * IMPORTANT:
       *
       * Use the persistent Woolworths context.
       */
      page =
        await browserService.createPage(
          'woolworths'
        );

      logger.info(
        `Scraping Woolworths product: ${url} ` +
          `using ${this.storeName}`
      );

      /*
       * ========================================================
       * 1. NAVIGATE
       * ========================================================
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

      /*
       * Don't wait for networkidle.
       *
       * Woolworths has ongoing requests and networkidle adds
       * unnecessary latency / possible timeouts.
       */

      /*
       * Give the product React components a short opportunity
       * to render.
       */
      await page
        .waitForTimeout(500);

      /*
       * ========================================================
       * 2. STORE
       * ========================================================
       */

      let storeConfigured =
        await this.isStoreAlreadyConfigured(
          page
        );

      if (
        !storeConfigured
      ) {
        storeConfigured =
          await this.ensureStoreSelected(
            page
          );
      }

      /*
       * ========================================================
       * 3. WAIT FOR PRODUCT
       * ========================================================
       */

      await page
        .locator(
          [
            'h1.product-title',
            'h1',
            '[id^="product-"][id$="-top-price"]',
          ].join(', ')
        )
        .first()
        .waitFor({
          state: 'visible',
          timeout: 15000,
        })
        .catch(
          () => {
            logger.warn(
              `Woolworths product elements were not detected ` +
                `within the expected time for ${url}`
            );
          }
        );

      /*
       * After store selection, Woolworths may update price /
       * fulfilment asynchronously. Wait for the important product
       * price element rather than networkidle.
       */
      await page
        .locator(
          '.presentPrice, [id$="-top-price"]'
        )
        .first()
        .waitFor({
          state: 'visible',
          timeout: 10000,
        })
        .catch(
          () => {
            logger.debug(
              `Woolworths price element not detected immediately`
            );
          }
        );

      /*
       * ========================================================
       * 4. EXTRACT
       * ========================================================
       */

      let product =
        await this.extractProduct(
          page
        );

      /*
       * ========================================================
       * 5. SAFETY CHECK
       * ========================================================
       *
       * If the persistent storage state said Birkenhead was
       * configured but the banner disappeared / changed, try
       * the explicit store flow once.
       */

      if (
        !storeConfigured
      ) {
        logger.warn(
          `Woolworths could not confirm ${this.storeName} ` +
            `after store-selection flow`
        );
      }

      const bannerConfirmed =
        await this.waitForStoreBanner(
          page,
          3000
        );

      if (
        !bannerConfirmed
      ) {
        logger.warn(
          `Woolworths banner does not currently confirm ` +
            `${this.storeName}`
        );
      }

      /*
       * If extraction failed badly, retry once after a short
       * AJAX wait. This is much safer than blindly waiting
       * networkidle.
       */
      if (
        !product.name ||
        product.price ===
          null ||
        product.sku ===
          null
      ) {
        logger.debug(
          `Woolworths product data incomplete; ` +
            `waiting for AJAX update and retrying extraction`
        );

        await page
          .waitForTimeout(1000);

        product =
          await this.extractProduct(
            page
          );
      }

      /*
       * ========================================================
       * 6. LOG
       * ========================================================
       */

      const durationMs =
        Date.now() -
        startTime;

      logger.info(
        `Woolworths extraction result: ` +
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
            savings:
              product.savings,
            packageSize:
              product.packageSize,
            cupPrice:
              product.cupPrice,
            availability:
              product.availability,
            store:
              this.storeName,
            storeConfigured,
            diagnostics:
              product.diagnostics,
            durationMs,
          })}`
      );

      /*
       * ========================================================
       * 7. WARNINGS
       * ========================================================
       */

      if (!product.name) {
        logger.warn(
          `Woolworths product name could not be extracted: ${url}`
        );
      }

      if (!product.sku) {
        logger.warn(
          `Woolworths SKU could not be extracted: ${url}`
        );
      }

      if (
        product.price ===
        null
      ) {
        logger.warn(
          `Woolworths price could not be extracted: ${url}`
        );
      }

      if (
        product.availability ===
        'unknown'
      ) {
        logger.warn(
          `Woolworths availability could not be determined: ${url}`
        );
      }

      /*
       * ========================================================
       * 8. RETURN
       * ========================================================
       */

      return {
        site:
          'woolworths',

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

        savings:
          product.savings,

        packageSize:
          product.packageSize,

        cupPrice:
          product.cupPrice,

        currency:
          'NZD',

        availability:
          product.availability,

        store:
          this.storeName,

        scrapedAt:
          new Date().toISOString(),
      };
    } catch (error) {
      const durationMs =
        Date.now() -
        startTime;

      logger.error(
        `Woolworths scraping failed after ${durationMs}ms for ${url}:`,
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

export const woolworthsAdapter =
  new WoolworthsAdapter();
