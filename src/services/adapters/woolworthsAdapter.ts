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

  private readonly storeName = 'Woolworths Birkenhead';
  private readonly regionName = 'Auckland (North)';
  private readonly regionValue = '600';

  private readonly navigationTimeout = 60000;

  /**
   * Determine whether this adapter can handle the supplied URL.
   */
  canHandle(url: string): boolean {
    try {
      const parsedUrl = new URL(url);
      const hostname = parsedUrl.hostname.toLowerCase();

      return (
        hostname === 'woolworths.co.nz' ||
        hostname.endsWith('.woolworths.co.nz')
      );
    } catch {
      return false;
    }
  }

  /**
   * PERFORMANCE / FAST PATH:
   *
   * Woolworths shows the currently-selected store directly on the
   * product page via the "how/where/when" banner:
   *
   *   You're seeing information for the <strong>Birkenhead store</strong>.
   *
   * If this already says Birkenhead, the store selection from a
   * previous scrape (persisted via storageState) is still active,
   * and we can skip the entire click-through flow.
   */
  private async isStoreAlreadyConfigured(
    page: Page
  ): Promise<boolean> {
    const banner = page
      .locator('global-nav-how-where-when-bar .information-message')
      .first();

    const text = await banner
      .textContent({ timeout: 5000 })
      .catch(() => null);

    const cleaned = text?.replace(/\s+/g, ' ').trim() || '';

    const isConfigured = new RegExp(
      `${this.escapeRegExp(this.storeShortName())}\\s+store`,
      'i'
    ).test(cleaned);

    logger.debug(
      `Woolworths fast-path store check: ` +
        `${isConfigured ? 'already configured' : 'not configured'} ` +
        `(banner text: "${cleaned}")`
    );

    return isConfigured;
  }

  private storeShortName(): string {
    // "Woolworths Birkenhead" -> "Birkenhead"
    return this.storeName.replace(/^Woolworths\s+/i, '').trim();
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Click the "Change location" link on the product page to open
   * the store/fulfilment selector.
   */
  private async openChangeLocation(page: Page): Promise<void> {
    const changeLocationLink = page
      .locator(
        [
          'a.actionButtonLink[aria-label="Change location"]',
          'a:has-text("Change location")',
        ].join(', ')
      )
      .first();

    await changeLocationLink.waitFor({
      state: 'visible',
      timeout: 15000,
    });

    logger.debug('Clicking Woolworths "Change location" link');

    await changeLocationLink.click({ timeout: 10000 });
  }

  /**
   * Select the "Pick up" fulfilment method tile.
   */
  private async selectPickup(page: Page): Promise<void> {
    const pickupTile = page
      .locator(
        [
          'form-selection-tile[data-cy="selectionTilePickup"]',
          'label[for="method-pickup"]',
          'input#method-pickup',
        ].join(', ')
      )
      .first();

    await pickupTile.waitFor({
      state: 'visible',
      timeout: 15000,
    });

    logger.debug('Selecting Woolworths "Pick up" method');

    await pickupTile.click({ timeout: 10000 });
  }

  /**
   * Click the "Change store" link to open the store list/region
   * picker.
   */
  private async openChangeStore(page: Page): Promise<void> {
    const changeStoreButton = page
      .locator(
        'button[data-cy="link"]:has-text("Change store")'
      )
      .first();

    await changeStoreButton.waitFor({
      state: 'visible',
      timeout: 15000,
    });

    logger.debug('Clicking Woolworths "Change store" button');

    await changeStoreButton.click({ timeout: 10000 });
  }

  /**
   * Select the configured region ("Auckland (North)") from the
   * region dropdown.
   */
  private async selectRegion(page: Page): Promise<void> {
    const regionSelect = page
      .locator(
        'select#area-dropdown-1, select[name="area-dropdown-1"]'
      )
      .first();

    await regionSelect.waitFor({
      state: 'visible',
      timeout: 15000,
    });

    logger.debug(
      `Selecting Woolworths region "${this.regionName}"`
    );

    try {
      await regionSelect.selectOption({
        value: this.regionValue,
      });
    } catch {
      /*
       * Fall back to matching by visible label text in case the
       * option value ever changes.
       */
      await regionSelect.selectOption({
        label: this.regionName,
      });
    }
  }

  /**
   * Within the resulting store list, select "Woolworths Birkenhead"
   * — or, if it's already selected (aria-disabled="true" with a
   * tick icon), skip clicking it.
   */
  private async selectStore(page: Page): Promise<void> {
    const storeList = page.locator(
      'fulfilment-address-selector .addressList'
    );

    await storeList.waitFor({
      state: 'visible',
      timeout: 20000,
    });

    const storeButton = page
      .locator('fulfilment-address-selector .addressList-item')
      .filter({
        has: page.locator(
          `.addressList-title:text-is("${this.storeName}")`
        ),
      })
      .locator('button.addressList-button')
      .first();

    await storeButton.waitFor({
      state: 'visible',
      timeout: 15000,
    });

    const ariaDisabled = await storeButton.getAttribute(
      'aria-disabled'
    );

    if (ariaDisabled === 'true') {
      logger.debug(
        `Woolworths store "${this.storeName}" already selected ` +
          `(aria-disabled=true); skipping click`
      );
      return;
    }

    logger.debug(`Clicking Woolworths store "${this.storeName}"`);

    await storeButton.scrollIntoViewIfNeeded();
    await storeButton.click({ timeout: 10000 });
  }

  /**
   * Click "Keep shopping" to confirm the selection and return to
   * the product page.
   */
  private async confirmKeepShopping(page: Page): Promise<void> {
    const keepShoppingButton = page
      .locator(
        [
          'button.actionBar-keepShoppingButton',
          'button:has-text("Keep shopping")',
        ].join(', ')
      )
      .first();

    const visible = await keepShoppingButton
      .isVisible({ timeout: 10000 })
      .catch(() => false);

    if (!visible) {
      logger.debug(
        'No visible "Keep shopping" button found; ' +
          'assuming selector closed automatically'
      );
      return;
    }

    logger.debug('Clicking Woolworths "Keep shopping" button');

    await keepShoppingButton.click({ timeout: 10000 });
  }

  /**
   * Run the full store-selection flow: Change location -> Pick up
   * -> Change store -> region -> store -> Keep shopping.
   */
  private async ensureStoreSelected(page: Page): Promise<void> {
    try {
      logger.info(
        `Selecting Woolworths store ${this.storeName} ` +
          `in region ${this.regionName}`
      );

      await this.openChangeLocation(page);
      await this.selectPickup(page);
      await this.openChangeStore(page);
      await this.selectRegion(page);
      await this.selectStore(page);
      await this.confirmKeepShopping(page);

      /*
       * Allow the page to refresh product/price data for the new
       * store.
       */
      await page.waitForTimeout(1500);

      /*
       * PERSISTENCE: Save this context's cookies/localStorage now
       * that Birkenhead is confirmed. Future Woolworths scrapes
       * (any product URL) will restore this state and can skip
       * this entire flow via the fast-path check.
       */
      await browserService.persistStorageState('woolworths');

      logger.info(
        `Woolworths store selection completed for ${this.storeName}`
      );
    } catch (error) {
      logger.warn(
        `Woolworths store selection failed for ${this.storeName}. ` +
          `Product extraction will continue, but price/availability ` +
          `may reflect the wrong store: ` +
          `${
            error instanceof Error
              ? error.message
              : String(error)
          }`
      );
    }
  }

  /**
   * Extract product information from the current page.
   */
  private async extractProduct(page: Page): Promise<ExtractedProduct> {
    return page.evaluate((): ExtractedProduct => {
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

      const parseMoney = (
        value: string | null | undefined
      ): number | null => {
        if (!value) {
          return null;
        }

        const match = value
          .replace(/\u00a0/g, ' ')
          .replace(/,/g, '')
          .match(/(\d+(?:\.\d{1,2})?)/);

        if (!match) {
          return null;
        }

        const parsed = Number(match[1]);

        return Number.isFinite(parsed) ? parsed : null;
      };

      const diagnostics: ExtractionDiagnostics = {
        nameSource: null,
        skuSource: null,
        priceSource: null,
        originalPriceSource: null,
        savingsSource: null,
        packageSizeSource: null,
        cupPriceSource: null,
        availabilitySource: null,
      };

      /*
       * ==============================================================
       * PRODUCT NAME
       * ==============================================================
       */

      let name: string | null = null;

      const nameEl = document.querySelector('h1.product-title');

      if (nameEl) {
        name = cleanText(nameEl.textContent);
        diagnostics.nameSource = 'DOM:h1.product-title';
      }

      if (!name) {
        const title = cleanText(document.title);

        if (title) {
          name = title
            .replace(/\s*\|\s*Woolworths\s*$/i, '')
            .trim();

          diagnostics.nameSource = 'document.title';
        }
      }

      /*
       * ==============================================================
       * SKU
       * ==============================================================
       *
       * Derived from element ids following the pattern:
       *
       *   product-724632-top-price
       *
       * which embeds the numeric product id.
       */

      let sku: string | null = null;

      const idCarrier = document.querySelector(
        '[id^="product-"][id$="-top-price"]'
      );

      if (idCarrier) {
        const idMatch = idCarrier.id.match(
          /^product-(\d+)-top-price$/
        );

        if (idMatch) {
          sku = idMatch[1];
          diagnostics.skuSource = 'DOM:id=product-{id}-top-price';
        }
      }

      /*
       * ==============================================================
       * CURRENT PRICE
       * ==============================================================
       *
       * Prefer the aria-label ("$26.89 each.") since it's a single
       * clean decimal value; the visible markup splits the price
       * across <em> (dollars) and a trailing span (cents).
       */

      let price: number | null = null;

      const priceEl = document.querySelector(
        '.presentPrice, [id$="-top-price"]'
      );

      if (priceEl) {
        const ariaPrice = priceEl.getAttribute('aria-label');

        const fromAria = parseMoney(ariaPrice);

        if (fromAria !== null) {
          price = fromAria;
          diagnostics.priceSource = 'ATTR:.presentPrice[aria-label]';
        } else {
          const fromText = parseMoney(priceEl.textContent);

          if (fromText !== null) {
            price = fromText;
            diagnostics.priceSource = 'DOM:.presentPrice text';
          }
        }
      }

      /*
       * ==============================================================
       * ORIGINAL ("WAS") PRICE
       * ==============================================================
       */

      let originalPrice: number | null = null;

      const wasEl = document.querySelector(
        '.price--was, [aria-label^="Was" i]'
      );

      if (wasEl) {
        /*
         * Prefer the visible text ("Was 46.00") over the aria-label,
         * since the aria-label in the supplied markup is oddly
         * formatted ("Was 46$") while the text content is a clean
         * decimal.
         */
        const fromText = parseMoney(wasEl.textContent);

        if (fromText !== null) {
          originalPrice = fromText;
          diagnostics.originalPriceSource = 'DOM:.price--was text';
        } else {
          const fromAria = parseMoney(
            wasEl.getAttribute('aria-label')
          );

          if (fromAria !== null) {
            originalPrice = fromAria;
            diagnostics.originalPriceSource =
              'ATTR:.price--was[aria-label]';
          }
        }
      }

      /*
       * ==============================================================
       * SAVINGS
       * ==============================================================
       */

      let savings: number | null = null;

      const saveEl = document.querySelector(
        '.price--save, [aria-label^="Save" i]'
      );

      if (saveEl) {
        const fromText = parseMoney(saveEl.textContent);

        if (fromText !== null) {
          savings = fromText;
          diagnostics.savingsSource = 'DOM:.price--save text';
        } else {
          const fromAria = parseMoney(
            saveEl.getAttribute('aria-label')
          );

          if (fromAria !== null) {
            savings = fromAria;
            diagnostics.savingsSource =
              'ATTR:.price--save[aria-label]';
          }
        }
      }

      /*
       * ==============================================================
       * PACKAGE SIZE / CUP PRICE (extra fields)
       * ==============================================================
       */

      let packageSize: string | null = null;

      const sizeEl = document.querySelector(
        'product-price-meta .size'
      );

      if (sizeEl) {
        packageSize = cleanText(sizeEl.textContent);
        diagnostics.packageSizeSource = 'DOM:product-price-meta .size';
      }

      let cupPrice: string | null = null;

      const cupPriceEl = document.querySelector(
        'product-price-meta .cupPrice'
      );

      if (cupPriceEl) {
        cupPrice = cleanText(cupPriceEl.textContent);
        diagnostics.cupPriceSource =
          'DOM:product-price-meta .cupPrice';
      }

      /*
       * ==============================================================
       * AVAILABILITY
       * ==============================================================
       *
       * No explicit stock badge was present in the supplied markup.
       * Best-effort: look for an "Add to trolley" control and infer
       * from its presence/disabled state, with a text-based fallback
       * for common out-of-stock phrasing.
       */

      let availability: Availability = 'unknown';

      const bodyText =
        cleanText(document.body?.innerText) || '';

      if (
        /\bout of stock\b/i.test(bodyText) ||
        /\bcurrently unavailable\b/i.test(bodyText) ||
        /\btemporarily unavailable\b/i.test(bodyText)
      ) {
        availability = 'out_of_stock';
        diagnostics.availabilitySource = 'TEXT:out-of-stock phrase';
      } else {
        const addToTrolleyButton = document.querySelector(
          '[data-cy="addToTrolleyBtn"]'
        );

        if (addToTrolleyButton) {
          const ariaDisabled = addToTrolleyButton.getAttribute(
            'aria-disabled'
          );

          if (ariaDisabled === 'true') {
            availability = 'out_of_stock';
            diagnostics.availabilitySource =
              'DOM:addToTrolleyBtn[aria-disabled=true]';
          } else {
            availability = 'in_stock';
            diagnostics.availabilitySource =
              'DOM:addToTrolleyBtn present';
          }
        }
      }

      /*
       * ==============================================================
       * CANONICAL URL
       * ==============================================================
       */

      const canonicalEl = document.querySelector(
        'link[rel="canonical"]'
      );

      const canonicalUrl =
        cleanText(canonicalEl?.getAttribute('href')) ||
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
    });
  }

  /**
   * Confirm the store banner reflects Birkenhead. Used after
   * extraction to flag (not throw) if something is off, since price
   * data may still be usable even if the banner check is uncertain.
   */
  private async validateConfiguredStore(page: Page): Promise<void> {
    const banner = page
      .locator('global-nav-how-where-when-bar .information-message')
      .first();

    const text = await banner
      .textContent({ timeout: 5000 })
      .catch(() => null);

    const cleaned = text?.replace(/\s+/g, ' ').trim() || null;

    if (
      cleaned &&
      !new RegExp(
        `${this.escapeRegExp(this.storeShortName())}\\s+store`,
        'i'
      ).test(cleaned)
    ) {
      logger.warn(
        `Woolworths banner does not confirm ${this.storeName}: ` +
          `"${cleaned}"`
      );
    }
  }

  /**
   * Main scraping method.
   */
  async scrapeProduct(
    url: string
  ): Promise<WoolworthsScrapedProduct> {
    let page: Page | null = null;

    try {
      await browserService.initialize();

      page = await browserService.createPage('woolworths');

      logger.info(
        `Scraping Woolworths product: ${url} using store ${this.storeName}`
      );

      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: this.navigationTimeout,
      });

      await page.waitForTimeout(1000);

      /*
       * ------------------------------------------------------------
       * SELECT STORE (fast path if already configured)
       * ------------------------------------------------------------
       */

      const alreadyConfigured = await this.isStoreAlreadyConfigured(
        page
      );

      if (alreadyConfigured) {
        logger.info(
          `Woolworths store ${this.storeName} already configured ` +
            `for this session; skipping store selector UI`
        );
      } else {
        await this.ensureStoreSelected(page);
      }

      try {
        await page.waitForLoadState('networkidle', {
          timeout: 3000,
        });
      } catch {
        logger.debug(
          `Woolworths networkidle timeout for ${url}; ` +
            `continuing with rendered page`
        );
      }

      await this.validateConfiguredStore(page);

      /*
       * ------------------------------------------------------------
       * EXTRACT
       * ------------------------------------------------------------
       */

      let product = await this.extractProduct(page);

      /*
       * SAFETY NET: if the fast path assumed the store was already
       * configured but the banner doesn't actually confirm
       * Birkenhead, fall back to the full explicit selection flow
       * and re-extract.
       */
      if (alreadyConfigured) {
        const banner = page
          .locator(
            'global-nav-how-where-when-bar .information-message'
          )
          .first();

        const bannerText = await banner
          .textContent({ timeout: 5000 })
          .catch(() => null);

        const cleanedBanner =
          bannerText?.replace(/\s+/g, ' ').trim() || '';

        const confirmed = new RegExp(
          `${this.escapeRegExp(this.storeShortName())}\\s+store`,
          'i'
        ).test(cleanedBanner);

        if (!confirmed) {
          logger.warn(
            `Woolworths fast-path assumption did not hold for ${url}; ` +
              `falling back to explicit store selection`
          );

          await this.ensureStoreSelected(page);

          await page.waitForTimeout(1000);

          product = await this.extractProduct(page);
        }
      }

      logger.info(
        `Woolworths extraction result for ${url}: ` +
          `${JSON.stringify({
            finalPageUrl: page.url(),
            name: product.name,
            sku: product.sku,
            price: product.price,
            originalPrice: product.originalPrice,
            savings: product.savings,
            availability: product.availability,
            diagnostics: product.diagnostics,
          })}`
      );

      /*
       * ------------------------------------------------------------
       * WARNINGS
       * ------------------------------------------------------------
       */

      if (!product.name) {
        logger.warn(
          `Woolworths product name could not be extracted for ${url}`
        );
      }

      if (!product.sku) {
        logger.warn(
          `Woolworths SKU could not be extracted for ${url}`
        );
      }

      if (product.price === null) {
        logger.warn(
          `Woolworths price could not be extracted for ${url}`
        );
      }

      if (product.availability === 'unknown') {
        logger.warn(
          `Woolworths availability could not be determined for ${url}`
        );
      }

      /*
       * ------------------------------------------------------------
       * RETURN
       * ------------------------------------------------------------
       */

      return {
        site: 'woolworths',
        url: product.canonicalUrl || page.url(),
        name: product.name,
        sku: product.sku,
        price: product.price,
        originalPrice: product.originalPrice,
        savings: product.savings,
        packageSize: product.packageSize,
        cupPrice: product.cupPrice,
        currency: 'NZD',
        availability: product.availability,
        store: this.storeName,
        scrapedAt: new Date().toISOString(),
      };
    } catch (error) {
      logger.error(
        `Woolworths scraping failed for ${url}:`,
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

export const woolworthsAdapter = new WoolworthsAdapter();
