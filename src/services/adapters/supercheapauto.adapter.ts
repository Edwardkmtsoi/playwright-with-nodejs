import { Page } from 'playwright';
import logger from '../../config/logger';
import { browserService } from '../browser.service';
import { ProductScraperAdapter } from './scraper-adapter.interface';
import { SupercheapAutoScrapedProduct } from '../../types/product-scrape.types';

export class SupercheapAutoAdapter implements ProductScraperAdapter {
  readonly site = 'supercheapauto' as const;

  private readonly storeName = 'SCA Wairau Park';
  private readonly storeId = '7030';
  private readonly postalCode = '0627';

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

  private async restoreProductPage(
    page: Page,
    productUrl: string
  ): Promise<void> {
    if (!this.isSearchResultsUrl(page.url())) {
      return;
    }

    logger.warn(
      `Supercheap Auto unexpectedly navigated to ${page.url()}. Restoring product page ${productUrl}`
    );

    await page.goto(productUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    await page.waitForTimeout(2000);
  }

  private async ensureStoreSelected(
    page: Page,
    productUrl: string
  ): Promise<void> {
    try {
      logger.info(
        `Selecting Supercheap Auto store ${this.storeName} (${this.postalCode}), store ID ${this.storeId}`
      );

      /*
       * This is the first "Change store" control shown on the product page.
       * It opens the product fulfilment store panel.
       */
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

      const changeStoreButtonVisible = await changeStoreButton
        .isVisible({ timeout: 10000 })
        .catch(() => false);

      if (changeStoreButtonVisible) {
        logger.debug(
          'Clicking Supercheap Auto product-page Change store control'
        );

        await changeStoreButton.click({
          timeout: 10000,
        });
      } else {
        logger.debug(
          'Product-page Change store control was not visible. Checking for the fulfilment Change control directly'
        );
      }

      /*
       * The product fulfilment panel contains a second Change link:
       *
       * <a
       *   id="change-preferred-store-button"
       *   class="change-location-button"
       * >
       *   <span>Change</span>
       * </a>
       */
      const changePreferredStoreButton = page.locator(
        '#change-preferred-store-button'
      );

      const changePreferredStoreButtonVisible =
        await changePreferredStoreButton
          .isVisible({ timeout: 10000 })
          .catch(() => false);

      if (changePreferredStoreButtonVisible) {
        logger.debug(
          'Clicking #change-preferred-store-button'
        );

        await changePreferredStoreButton.click({
          timeout: 10000,
        });
      }

      /*
       * Only use selectors associated with the store-selection interface.
       *
       * Do not use:
       *   input[type="search"]
       *
       * That selector can match the website's global product-search field.
       * Pressing Enter in that field caused the navigation to:
       *   /search?q=0627&lang=en_NZ
       */
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
       * Defensive check against accidentally selecting the global search
       * input.
       */
      if (
        inputDetails.name?.toLowerCase() === 'q' ||
        /search products|what are you looking for/i.test(
          inputDetails.placeholder || ''
        )
      ) {
        throw new Error(
          `The selected postcode input appears to be the global product-search input: ${JSON.stringify(
            inputDetails
          )}`
        );
      }

      await postcodeInput.fill('');
      await postcodeInput.fill(this.postalCode);

      /*
       * Do not press Enter. The store results may refresh automatically.
       * If the store selector has a dedicated search button, use it.
       */
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

      const storeSearchButtonVisible = await storeSearchButton
        .isVisible({ timeout: 3000 })
        .catch(() => false);

      if (storeSearchButtonVisible) {
        logger.debug(
          'Clicking the dedicated store-search button'
        );

        await storeSearchButton.click({
          timeout: 10000,
        });
      } else {
        logger.debug(
          'No dedicated store-search button was found. Waiting for automatic store-result refresh'
        );
      }

      /*
       * Wait for the exact Wairau Park result.
       *
       * Expected HTML:
       *
       * <div
       *   class="fulfilment-store-item store-item"
       *   data-id="7030"
       *   data-preferred-id="7030"
       *   data-name="SCA Wairau Park"
       * >
       */
      const wairauParkStore = page
        .locator(
          [
            `.fulfilment-store-item[data-id="${this.storeId}"]`,
            `.fulfilment-store-item[data-preferred-id="${this.storeId}"]`,
            `.fulfilment-store-item[data-name="${this.storeName}"]`,
            `.fulfilment-store-item:has(.store-name:text-is("${this.storeName}"))`,
          ].join(', ')
        )
        .first();

      await wairauParkStore.waitFor({
        state: 'visible',
        timeout: 20000,
      });

      const selectedStoreDetails = await wairauParkStore.evaluate(
        (element) => {
          const storeName =
            element.getAttribute('data-name') ||
            element
              .querySelector('.store-name')
              ?.textContent?.replace(/\s+/g, ' ')
              .trim() ||
            null;

          const storeAddress =
            element
              .querySelector('.store-address')
              ?.textContent?.replace(/\s+/g, ' ')
              .trim() || null;

          const storeDistance =
            element
              .querySelector('.store-distance')
              ?.textContent?.replace(/\s+/g, ' ')
              .trim() || null;

          const stockStatus =
            element
              .querySelector('.stock-status')
              ?.textContent?.replace(/\s+/g, ' ')
              .trim() || null;

          return {
            storeName,
            storeAddress,
            storeDistance,
            stockStatus,
            dataId: element.getAttribute('data-id'),
            dataPreferredId:
              element.getAttribute('data-preferred-id'),
            className: element.className,
          };
        }
      );

      logger.info(
        `Supercheap Auto Wairau Park result found: ${JSON.stringify(
          selectedStoreDetails
        )}`
      );

      if (
        selectedStoreDetails.dataId !== this.storeId &&
        selectedStoreDetails.dataPreferredId !== this.storeId &&
        selectedStoreDetails.storeName !== this.storeName
      ) {
        throw new Error(
          `Unexpected store result selected: ${JSON.stringify(
            selectedStoreDetails
          )}`
        );
      }

      /*
       * The entire .fulfilment-store-item is the selectable element.
       */
      await wairauParkStore.scrollIntoViewIfNeeded();

      await wairauParkStore.click({
        timeout: 10000,
      });

      /*
       * Wait until the selected result has the "checked" class.
       */
      const checkedWairauParkStore = page
        .locator(
          [
            `.fulfilment-store-item.checked[data-id="${this.storeId}"]`,
            `.fulfilment-store-item.checked[data-preferred-id="${this.storeId}"]`,
            `.fulfilment-store-item.checked[data-name="${this.storeName}"]`,
          ].join(', ')
        )
        .first();

      await checkedWairauParkStore.waitFor({
        state: 'visible',
        timeout: 10000,
      });

      logger.debug(
        `${this.storeName} is marked as selected in the store result list`
      );

      /*
       * Expected confirmation control:
       *
       * <button
       *   class="button fulfilment-cta"
       *   data-preferred-id="7030"
       *   data-selected-id="7030"
       * >
       *   Confirm
       * </button>
       */
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

      const confirmButtonDetails = await confirmButton.evaluate(
        (element) => ({
          text:
            element.textContent?.replace(/\s+/g, ' ').trim() ||
            null,
          selectedId: element.getAttribute('data-selected-id'),
          preferredId: element.getAttribute(
            'data-preferred-id'
          ),
        })
      );

      logger.debug(
        `Supercheap Auto confirmation button: ${JSON.stringify(
          confirmButtonDetails
        )}`
      );

      await confirmButton.click({
        timeout: 10000,
      });

      /*
       * Product fulfilment normally refreshes through AJAX.
       */
      await page.waitForTimeout(2500);

      await page
        .waitForLoadState('domcontentloaded', {
          timeout: 10000,
        })
        .catch(() => {
          // An AJAX-only update is valid.
        });

      /*
       * Restore the product page if any store-selection interaction
       * accidentally submitted the global site search.
       */
      await this.restoreProductPage(page, productUrl);

      logger.info(
        `Supercheap Auto store selection completed for ${this.storeName}`
      );
    } catch (error) {
      logger.warn(
        `Supercheap Auto store selection failed for ${this.storeName}. Store availability may be incomplete: ${
          error instanceof Error ? error.message : String(error)
        }`
      );

      /*
       * Even when store selection fails, do not allow extraction to continue
       * against a search-results page.
       */
      await this.restoreProductPage(page, productUrl);
    }
  }

  private async validateProductPage(
    page: Page,
    expectedProductUrl: string
  ): Promise<void> {
    const currentUrl = page.url();

    if (this.isSearchResultsUrl(currentUrl)) {
      throw new Error(
        `Supercheap Auto extraction aborted because the browser is on a search-results page instead of the product page. Current URL: ${currentUrl}; expected product URL: ${expectedProductUrl}`
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
        `Supercheap Auto extraction aborted because the page heading is "${cleanedHeading}" instead of a product name`
      );
    }
  }

  async scrapeProduct(
    url: string
  ): Promise<SupercheapAutoScrapedProduct> {
    let page: Page | null = null;

    try {
      await browserService.initialize();
      page = await browserService.createPage();

      logger.info(
        `Scraping Supercheap Auto product: ${url} using store ${this.storeName} (${this.postalCode})`
      );

      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });

      /*
       * Store the product URL after the initial navigation. This may reflect
       * any legitimate redirect to the canonical product URL.
       */
      const productPageUrl = page.url();

      if (this.isSearchResultsUrl(productPageUrl)) {
        throw new Error(
          `The supplied Supercheap Auto URL resolved to a search-results page instead of a product page: ${productPageUrl}`
        );
      }

      await page.waitForTimeout(1500);

      await this.ensureStoreSelected(page, productPageUrl);

      try {
        await page.waitForLoadState('networkidle', {
          timeout: 5000,
        });
      } catch {
        logger.debug(
          `Supercheap Auto networkidle timeout for ${url}; continuing with the rendered product page`
        );
      }

      await page.waitForTimeout(2000);

      await this.validateProductPage(page, productPageUrl);

      const product = await page.evaluate(
        ({
          expectedStoreName,
          expectedStoreId,
        }: {
          expectedStoreName: string;
          expectedStoreId: string;
        }) => {
          type Availability =
            | 'in_stock'
            | 'out_of_stock'
            | 'check_availability'
            | 'unknown';

          type ExtractedProduct = {
            name: string | null;
            sku: string | null;
            price: number | null;
            originalPrice: number | null;
            saleEndDate: string | null;
            availability: Availability;
            storeAvailability: Availability;
            store: string | null;
            canonicalUrl: string;
            diagnostics: {
              nameSource: string | null;
              skuSource: string | null;
              priceSource: string | null;
              originalPriceSource: string | null;
              saleEndDateSource: string | null;
              storeSource: string | null;
              availabilitySource: string | null;
              storeAvailabilitySource: string | null;
            };
          };

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

            const match = text.match(
              /(?:NZD|NZ|\$)?\s*(\d+(?:\.\d{1,2})?)/
            );

            if (!match) {
              return null;
            }

            const parsed = Number(match[1]);

            return Number.isFinite(parsed) ? parsed : null;
          };

          const getText = (
            selector: string
          ): string | null => {
            const element = document.querySelector(selector);

            return cleanText(element?.textContent);
          };

          const getAttribute = (
            selector: string,
            attribute: string
          ): string | null => {
            const element = document.querySelector(selector);

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

          const diagnostics = {
            nameSource: null as string | null,
            skuSource: null as string | null,
            priceSource: null as string | null,
            originalPriceSource: null as string | null,
            saleEndDateSource: null as string | null,
            storeSource: null as string | null,
            availabilitySource: null as string | null,
            storeAvailabilitySource: null as string | null,
          };

          /*
           * Product name
           */
          let name: string | null = null;
          let pageContextTitle: string | null = null;

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
                pageContextTitle = cleanText(
                  String(parsed.title)
                );

                break;
              }
            } catch {
              // Ignore malformed pageContext objects.
            }
          }

          if (pageContextTitle) {
            name = pageContextTitle;
            diagnostics.nameSource =
              'JS:pageContext.title';
          }

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
              diagnostics.nameSource = `DOM:${nameResult.selector}`;
            }
          }

          if (!name) {
            const title = cleanText(document.title);

            if (title) {
              name = title
                .replace(
                  /\s*\|\s*Supercheap Auto New Zealand\s*$/i,
                  ''
                )
                .trim();

              diagnostics.nameSource = 'document.title';
            }
          }

          if (
            name &&
            /product search results/i.test(name)
          ) {
            name = null;
            diagnostics.nameSource = null;
          }

          /*
           * SKU / item number
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
            const productNumberResult = getFirstText([
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
              diagnostics.skuSource = `TEXT:${productNumberResult.selector}`;
            }
            
            /*
             * Current price
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
              const element = document.querySelector(selector);
            
              if (!element) {
                continue;
              }
            
              const attributePrice = element.getAttribute('content');
            
              const candidate = parsePrice(
                attributePrice || element.textContent
              );
            
              if (candidate !== null) {
                price = candidate;
                diagnostics.priceSource = `DOM:${selector}`;
                break;
              }
            }
            
            /*
             * Original or "was" price
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
              const candidate = parsePrice(getText(selector));
            
              if (
                candidate !== null &&
                (price === null || candidate > price)
              ) {
                originalPrice = candidate;
                diagnostics.originalPriceSource = `DOM:${selector}`;
                break;
              }
            }
            
            if (originalPrice === null) {
              const bodyText =
                cleanText(document.body?.innerText) || '';
            
              const wasMatch = bodyText.match(
                /\bWas\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i
              );
            
              if (wasMatch) {
                const candidate = parsePrice(wasMatch[1]);
            
                if (
                  candidate !== null &&
                  (price === null || candidate > price)
                ) {
                  originalPrice = candidate;
                  diagnostics.originalPriceSource = 'TEXT:Was';
                }
              }
            }
            
            /*
             * Sale end date
             */
            let saleEndDate: string | null = null;
            
            const saleEndResult = getFirstText([
              '.saleprice-end-date',
              '[class*="saleprice-end-date" i]',
              '[class*="sale-end-date" i]',
              '[class*="promotion-end" i]',
              '[class*="promo-end" i]',
            ]);
            
            if (saleEndResult.value) {
              const dateMatch = saleEndResult.value.match(
                /(\d{1,2}\/\d{1,2}\/\d{2,4})/
              );
            
              saleEndDate = dateMatch
                ? dateMatch[1]
                : saleEndResult.value;
            
              diagnostics.saleEndDateSource =
                `DOM:${saleEndResult.selector}`;
            }
            
            /*
             * General product availability.
             */
            let availability: Availability = 'unknown';
            
            const productArea =
              document.querySelector('[class*="product-detail" i]') ||
              document.querySelector('[class*="product-info" i]') ||
              document.querySelector('main');
            
            const productAreaText =
              cleanText(productArea?.textContent) || '';
            
            const addToCartElement = Array.from(
              document.querySelectorAll('button, a')
            ).find((element) => {
              const text = cleanText(element.textContent) || '';
            
              return /\badd\s+to\s+cart\b/i.test(text);
            });
            
            if (
              /\bcurrently\s+unavailable\b/i.test(productAreaText) ||
              /\bout\s+of\s+stock\b/i.test(productAreaText) ||
              /\bnot\s+available\b/i.test(productAreaText) ||
              /\bnot\s+stocked\b/i.test(productAreaText)
            ) {
              availability = 'out_of_stock';
              diagnostics.availabilitySource =
                'TEXT:product-area-unavailable';
            } else if (addToCartElement) {
              availability = 'in_stock';
              diagnostics.availabilitySource = 'DOM:Add-to-Cart';
            } else if (
              /\bin\s+stock\b/i.test(productAreaText) ||
              /\bpick\s+up\s+today\b/i.test(productAreaText)
            ) {
              availability = 'in_stock';
              diagnostics.availabilitySource =
                'TEXT:product-area-in-stock';
            } else if (
              /\bcheck\s+availability\b/i.test(productAreaText)
            ) {
              availability = 'check_availability';
              diagnostics.availabilitySource =
                'TEXT:check-availability';
            }
            
            /*
             * Store-specific availability.
             */
            let store: string | null = null;
            let storeAvailability: Availability = 'unknown';
            
            const storeItems = Array.from(
              document.querySelectorAll('.fulfilment-store-item')
            );
            
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
              document.querySelector(
                `.fulfilment-store-item[data-id="${expectedStoreId}"]`
              ) ||
              document.querySelector(
                `.fulfilment-store-item[data-preferred-id="${expectedStoreId}"]`
              ) ||
              document.querySelector(
                `.fulfilment-store-item[data-name="${expectedStoreName}"]`
              ) ||
              storeItems.find((element) => {
                const itemStoreName = cleanText(
                  element.getAttribute('data-name') ||
                    element.querySelector('.store-name')?.textContent
                );
            
                return (
                  itemStoreName?.toLowerCase() ===
                  expectedStoreName.toLowerCase()
                );
              }) ||
              null;
            
            if (selectedStoreElement) {
              const selectedStoreName = cleanText(
                selectedStoreElement.getAttribute('data-name') ||
                  selectedStoreElement.querySelector('.store-name')
                    ?.textContent
              );
            
              if (selectedStoreName) {
                store = selectedStoreName;
                diagnostics.storeSource =
                  'DOM:.fulfilment-store-item';
              }
            
              const stockStatusElement =
                selectedStoreElement.querySelector('.stock-status');
            
              const stockStatusText = cleanText(
                stockStatusElement?.textContent
              );
            
              if (
                stockStatusElement?.classList.contains('available') ||
                /\bin\s+stock\b/i.test(stockStatusText || '')
              ) {
                storeAvailability = 'in_stock';
                diagnostics.storeAvailabilitySource =
                  'DOM:.fulfilment-store-item .stock-status.available';
              } else if (
                stockStatusElement?.classList.contains(
                  'unavailable'
                ) ||
                stockStatusElement?.classList.contains(
                  'not-available'
                ) ||
                /\bno\s+stock\b/i.test(stockStatusText || '') ||
                /\bout\s+of\s+stock\b/i.test(stockStatusText || '') ||
                /\bunavailable\b/i.test(stockStatusText || '') ||
                /\bnot\s+available\b/i.test(stockStatusText || '')
              ) {
                storeAvailability = 'out_of_stock';
                diagnostics.storeAvailabilitySource =
                  'DOM:.fulfilment-store-item .stock-status.unavailable';
              } else if (stockStatusText) {
                storeAvailability = 'check_availability';
                diagnostics.storeAvailabilitySource =
                  'DOM:.fulfilment-store-item unrecognised stock status';
              }
            }
            
            /*
             * After confirmation, the store selection list may be hidden or removed.
             * Look for a smaller product fulfilment section that contains the expected
             * store name.
             */
            if (!store || storeAvailability === 'unknown') {
              const fulfilmentElements = Array.from(
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
                fulfilmentElements.filter((element) => {
                  const text = cleanText(element.textContent) || '';
            
                  return text
                    .toLowerCase()
                    .includes(expectedStoreName.toLowerCase());
                });
            
              /*
               * Prefer the smallest matching container to avoid evaluating a large
               * parent element containing multiple stores.
               */
              matchingFulfilmentElements.sort(
                (first, second) => {
                  const firstLength =
                    cleanText(first.textContent)?.length ??
                    Number.MAX_SAFE_INTEGER;
            
                  const secondLength =
                    cleanText(second.textContent)?.length ??
                    Number.MAX_SAFE_INTEGER;
            
                  return firstLength - secondLength;
                }
              );
            
              const fulfilmentElement =
                matchingFulfilmentElements[0] || null;
            
              const fulfilmentText = cleanText(
                fulfilmentElement?.textContent
              );
            
              if (fulfilmentText) {
                store = expectedStoreName;
                diagnostics.storeSource =
                  'DOM:selected-product-fulfilment-section';
            
                if (
                  (
                    /\bin\s+stock\b/i.test(fulfilmentText) ||
                    /\bpick\s+up\s+today\b/i.test(fulfilmentText) ||
                    /\bavailable\b/i.test(fulfilmentText)
                  ) &&
                  !(
                    /\bunavailable\b/i.test(fulfilmentText) ||
                    /\bnot\s+available\b/i.test(fulfilmentText) ||
                    /\bout\s+of\s+stock\b/i.test(fulfilmentText) ||
                    /\bno\s+stock\b/i.test(fulfilmentText)
                  )
                ) {
                  storeAvailability = 'in_stock';
                  diagnostics.storeAvailabilitySource =
                    'TEXT:selected-fulfilment-section-in-stock';
                } else if (
                  /\bunavailable\b/i.test(fulfilmentText) ||
                  /\bnot\s+available\b/i.test(fulfilmentText) ||
                  /\bout\s+of\s+stock\b/i.test(fulfilmentText) ||
                  /\bno\s+stock\b/i.test(fulfilmentText)
                ) {
                  storeAvailability = 'out_of_stock';
                  diagnostics.storeAvailabilitySource =
                    'TEXT:selected-fulfilment-section-unavailable';
                } else {
                  storeAvailability = 'check_availability';
                  diagnostics.storeAvailabilitySource =
                    'TEXT:selected-fulfilment-section';
                }
              }
            }
            
            /*
             * Only consider header store selectors if they explicitly contain the
             * expected store name. This prevents an unrelated store such as
             * SCA Invercargill from being returned.
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
                    .includes(expectedStoreName.toLowerCase())
                ) {
                  store = expectedStoreName;
                  diagnostics.storeSource = `DOM:${selector}`;
                  break;
                }
              }
            }
            
            /*
             * Only use general product availability as a fallback when Wairau Park
             * has been explicitly confirmed on the page.
             */
            if (
              store === expectedStoreName &&
              storeAvailability === 'unknown' &&
              availability !== 'unknown'
            ) {
              storeAvailability = availability;
              diagnostics.storeAvailabilitySource =
                'FALLBACK:confirmed-store-plus-product-availability';
            }
            
            const canonicalUrl =
              getAttribute('link[rel="canonical"]', 'href') ||
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
            } satisfies ExtractedProduct;
            },
            {
              expectedStoreName: this.storeName,
              expectedStoreId: this.storeId,
            }
            );
            
            logger.info(
              `Supercheap Auto extraction result for ${url}: ${JSON.stringify({
                finalPageUrl: page.url(),
                name: product.name,
                sku: product.sku,
                price: product.price,
                originalPrice: product.originalPrice,
                saleEndDate: product.saleEndDate,
                availability: product.availability,
                storeAvailability: product.storeAvailability,
                store: product.store,
                diagnostics: product.diagnostics,
              })}`
            );
            
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
                `Supercheap Auto could not confirm the selected store for ${url}`
              );
            } else if (
              product.store.toLowerCase() !==
              this.storeName.toLowerCase()
            ) {
              logger.warn(
                `Supercheap Auto returned store "${product.store}" instead of "${this.storeName}"`
              );
            }
            
            if (product.storeAvailability === 'unknown') {
              logger.warn(
                `Supercheap Auto store availability for ${this.storeName} could not be determined for ${url}`
              );
            }
            
            await this.validateProductPage(page, productPageUrl);
            
            return {
              site: 'supercheapauto',
              url: product.canonicalUrl || page.url(),
              name: product.name,
              sku: product.sku,
              price: product.price,
              originalPrice: product.originalPrice,
              saleEndDate: product.saleEndDate,
              currency: 'NZD',
              availability: product.availability,
              storeAvailability: product.storeAvailability,
              store: product.store || this.storeName,
              postalCode: this.postalCode,
              scrapedAt: new Date().toISOString(),
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
