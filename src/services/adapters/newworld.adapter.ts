import { Page } from 'playwright';
import logger from '../../config/logger';
import { browserService } from '../browser.service';
import { ProductScraperAdapter } from './scraper-adapter.interface';
import {
  NewWorldScrapedProduct,
  NewWorldMultibuyOffer,
  ProductAvailability,
} from '../../types/product-scrape.types';

interface ExtractionDiagnostics {
  nameSource: string | null;
  skuSource: string | null;
  priceSource: string | null;
  originalPriceSource: string | null;
  unitPriceSource: string | null;
  multibuySource: string | null;
  availabilitySource: string | null;
  currencySource: string | null;
}

interface ExtractedProduct {
  name: string | null;
  sku: string | null;
  price: number | null;
  originalPrice: number | null;
  unitPrice: string | null;
  multibuy: NewWorldMultibuyOffer | null;
  availability: ProductAvailability;
  currency: 'NZD';
  canonicalUrl: string;
  diagnostics: ExtractionDiagnostics;
}

interface StoreConfig {
  name: string;
  searchTerm: string;
  addressMatch: string;
}

const TARGET_STORE: StoreConfig = {
  name: 'New World Birkenhead',
  searchTerm: 'Birkenhead',
  addressMatch: '180 Mokoia Road, Chatswood, Auckland, 0626',
};

export class NewWorldAdapter implements ProductScraperAdapter {
  readonly site = 'newworld' as const;

  private readonly navigationTimeout = 60000;

  private readonly store: StoreConfig = TARGET_STORE;

  /**
   * Determine whether this adapter supports the supplied URL.
   */
  canHandle(url: string): boolean {
    try {
      const parsedUrl = new URL(url);
      const hostname = parsedUrl.hostname.toLowerCase();

      return (
        hostname === 'newworld.co.nz' ||
        hostname.endsWith('.newworld.co.nz')
      );
    } catch {
      return false;
    }
  }

  /**
   * Validate that the loaded page appears to be a New World
   * product page.
   */
  private async validateProductPage(
    page: Page,
    expectedProductUrl: string
  ): Promise<void> {
    const currentUrl = page.url();

    const hasProductName = await page
      .locator('[data-testid="product-title"]')
      .first()
      .count()
      .then((count) => count > 0)
      .catch(() => false);

    const hasProductPrice = await page
      .locator(
        [
          '[itemprop="offers"] [itemprop="price"]',
          '[data-testid="price-dollars"]',
          '[itemprop="price"]',
        ].join(', ')
      )
      .first()
      .count()
      .then((count) => count > 0)
      .catch(() => false);

    const headingText = await page
      .locator('[data-testid="product-title"]')
      .first()
      .textContent({
        timeout: 5000,
      })
      .catch(() => null);

    const cleanedHeading =
      headingText?.replace(/\s+/g, ' ').trim() || null;

    if (!hasProductName && !hasProductPrice && !cleanedHeading) {
      throw new Error(
        `New World extraction aborted because the loaded page ` +
          `does not appear to be a product page. ` +
          `Current URL: ${currentUrl}; ` +
          `expected URL: ${expectedProductUrl}`
      );
    }
  }

  /**
   * Read which fulfilment store is currently selected on the page,
   * if any.
   */
  private async getCurrentStore(
    page: Page
  ): Promise<string | null> {
    const collectLabel = page
      .locator('p:has-text("Collect from")')
      .first();

    const isVisible = await collectLabel
      .isVisible()
      .catch(() => false);

    if (!isVisible) {
      return null;
    }

    const text =
      (await collectLabel.textContent().catch(() => null))?.trim() ||
      '';

    const currentStore = text
      .replace(/^Collect\s*from\s*/i, '')
      .trim();

    return currentStore || null;
  }

  /**
   * Ensure the configured store (New World Birkenhead) is selected
   * before scraping, since price and availability are store-specific.
   * No-ops if it's already set correctly.
   */
  private async ensureStoreSet(page: Page): Promise<void> {
    const currentStore = await this.getCurrentStore(page);

    if (currentStore === this.store.name) {
      logger.debug(
        `New World store already set to "${this.store.name}"`
      );

      return;
    }

    logger.info(
      `New World store is "${currentStore || 'unset'}"; ` +
        `switching to "${this.store.name}"`
    );

    const collectTab = page.locator(
      '[data-testid="collect-tab-button"]'
    );

    if (await collectTab.isVisible().catch(() => false)) {
      const alreadySelected = await collectTab.getAttribute(
        'aria-selected'
      );

      if (alreadySelected !== 'true') {
        await collectTab.click();
      }
    }

    const searchInput = page.locator(
      '[data-testid="search-bar-input"]'
    );

    await searchInput.waitFor({
      state: 'visible',
      timeout: 10000,
    });

    await searchInput.fill(this.store.searchTerm);

    const resultCandidates = page.locator(
      `text=${this.store.name}`
    );

    await resultCandidates
      .first()
      .waitFor({ state: 'visible', timeout: 10000 })
      .catch(() => {
        throw new Error(
          `New World store search returned no results for ` +
            `"${this.store.searchTerm}"`
        );
      });

    const count = await resultCandidates.count();
    let selected = false;

    for (let i = 0; i < count; i++) {
      const candidate = resultCandidates.nth(i).locator('../..');
      const candidateText = await candidate
        .textContent()
        .catch(() => null);

      if (candidateText?.includes(this.store.addressMatch)) {
        await candidate.click();
        selected = true;
        break;
      }
    }

    if (!selected) {
      throw new Error(
        `Could not find "${this.store.name}" at ` +
          `"${this.store.addressMatch}" in store search results`
      );
    }

    await page.waitForTimeout(500);

    const confirmedStore = await this.getCurrentStore(page);

    if (confirmedStore !== this.store.name) {
      throw new Error(
        `Failed to set New World store to "${this.store.name}" — ` +
          `current store: "${confirmedStore || 'unknown'}"`
      );
    }

    logger.info(`New World store set to "${this.store.name}"`);
  }

  /**
   * Extract the product information from the rendered page.
   */
  private async extractProduct(
    page: Page
  ): Promise<ExtractedProduct> {
    return page.evaluate(() => {
      type PageAvailability =
        | 'in_stock'
        | 'out_of_stock'
        | 'check_availability'
        | 'unknown'
        | null;

      interface PageMultibuyOffer {
        quantity: number;
        price: number;
      }

      interface PageExtractionDiagnostics {
        nameSource: string | null;
        skuSource: string | null;
        priceSource: string | null;
        originalPriceSource: string | null;
        unitPriceSource: string | null;
        multibuySource: string | null;
        availabilitySource: string | null;
        currencySource: string | null;
      }

      interface PageExtractedProduct {
        name: string | null;
        sku: string | null;
        price: number | null;
        originalPrice: number | null;
        unitPrice: string | null;
        multibuy: PageMultibuyOffer | null;
        availability: PageAvailability;
        currency: 'NZD';
        canonicalUrl: string;
        diagnostics: PageExtractionDiagnostics;
      }

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

      const combineDollarsCents = (
        dollarsEl: Element | null | undefined,
        centsEl: Element | null | undefined
      ): number | null => {
        const dollarsText = cleanText(dollarsEl?.textContent);
        const centsText = cleanText(centsEl?.textContent);

        if (!dollarsText || !centsText) {
          return null;
        }

        const d = dollarsText.replace(/[^\d]/g, '');
        const c = centsText.replace(/[^\d]/g, '').padStart(2, '0');

        if (!d) {
          return null;
        }

        const parsed = Number(`${d}.${c}`);

        return Number.isFinite(parsed) ? parsed : null;
      };

      const diagnostics: PageExtractionDiagnostics = {
        nameSource: null,
        skuSource: null,
        priceSource: null,
        originalPriceSource: null,
        unitPriceSource: null,
        multibuySource: null,
        availabilitySource: null,
        currencySource: null,
      };

      /*
       * ============================================================
       * PRODUCT NAME
       * ============================================================
       */

      let name: string | null = null;

      const titleText = getText(
        '[data-testid="product-title"]'
      );

      if (titleText) {
        name = titleText;
        diagnostics.nameSource =
          'DOM:[data-testid="product-title"]';
      }

      if (!name) {
        const documentTitle = cleanText(document.title);

        if (documentTitle) {
          name = documentTitle
            .replace(/\s*(?:\||-)\s*New\s*World.*$/i, '')
            .trim();

          diagnostics.nameSource = 'DOCUMENT:title';
        }
      }

      /*
       * ============================================================
       * SKU
       * ============================================================
       */

      let sku: string | null = null;

      const skuMeta = getAttribute(
        'meta[itemprop="sku"], meta[itemprop="productID"]',
        'content'
      );

      if (skuMeta) {
        sku = skuMeta;
        diagnostics.skuSource = 'META:itemprop=sku/productID';
      }

      /*
       * ============================================================
       * REGULAR PRICE (schema.org offer, falls back to DOM digits)
       * This is New World's non-member "was" price when a Club+
       * deal is active, or the selling price otherwise.
       * ============================================================
       */

      let regularPrice: number | null = null;

      const priceMetaContent = getAttribute(
        '[itemprop="offers"] meta[itemprop="price"], meta[itemprop="price"]',
        'content'
      );

      if (priceMetaContent) {
        const parsed = Number(priceMetaContent);

        if (Number.isFinite(parsed)) {
          regularPrice = parsed;
          diagnostics.originalPriceSource =
            'META:itemprop=price';
        }
      }

      if (regularPrice === null) {
        const combined = combineDollarsCents(
          document.querySelector('[data-testid="price-dollars"]'),
          document.querySelector('[data-testid="price-cents"]')
        );

        if (combined !== null) {
          regularPrice = combined;
          diagnostics.originalPriceSource =
            'DOM:[data-testid="price-dollars/cents"]';
        }
      }

      /*
       * ============================================================
       * CLUB+ DEAL PRICE (decal on the product tile/page)
       * ============================================================
       */

      const decal = document.querySelector(
        '[data-testid="decal-price"]'
      );

      const clubPlusPrice = decal
        ? combineDollarsCents(
            decal.querySelector('[data-testid="price-dollars"]'),
            decal.querySelector('[data-testid="price-cents"]')
          )
        : null;

      if (clubPlusPrice !== null) {
        diagnostics.priceSource =
          'DOM:[data-testid="decal-price"]';
      }

      /*
       * ============================================================
       * CURRENT SELLING PRICE vs ORIGINAL PRICE
       * If a Club+ deal is active: price = deal price,
       * originalPrice = regular price. Otherwise price = regular
       * price and originalPrice is null (nothing to compare against).
       * ============================================================
       */

      let price: number | null = null;
      let originalPrice: number | null = null;

      if (clubPlusPrice !== null) {
        price = clubPlusPrice;
        originalPrice = regularPrice;
      } else if (regularPrice !== null) {
        price = regularPrice;

        diagnostics.priceSource =
          diagnostics.priceSource ||
          'DERIVED:regularPrice (no active discount)';
      }

      /*
       * ============================================================
       * UNIT PRICE (e.g. "$0.89/100g")
       * ============================================================
       */

      const unitPriceText = getText(
        '[data-testid="complex-promo-unit-price"]'
      );

      const unitPrice = unitPriceText || null;

      if (unitPrice) {
        diagnostics.unitPriceSource =
          'DOM:[data-testid="complex-promo-unit-price"]';
      }

      /*
       * ============================================================
       * MULTIBUY OFFER
       * ============================================================
       */

      let multibuy: PageMultibuyOffer | null = null;

      const multibuyThresholdText = getText(
        '[data-testid="multibuy-threshold"]'
      );

      if (multibuyThresholdText) {
        const quantityMatch =
          multibuyThresholdText.match(/(\d+)\s*for/i);

        const multibuyPriceEl = document.querySelector(
          '[data-testid="multibuy-price"]'
        );

        const combined = combineDollarsCents(
          multibuyPriceEl?.querySelector(
            '[data-testid="price-dollars"]'
          ),
          multibuyPriceEl?.querySelector(
            '[data-testid="price-cents"]'
          )
        );

        if (quantityMatch && combined !== null) {
          multibuy = {
            quantity: Number(quantityMatch[1]),
            price: combined,
          };

          diagnostics.multibuySource =
            'DOM:[data-testid="multibuy-threshold/price"]';
        }
      }

      /*
       * ============================================================
       * CURRENCY
       * ============================================================
       */

      const currency: 'NZD' = 'NZD';

      const currencyMeta = getAttribute(
        '[itemprop="offers"] meta[itemprop="priceCurrency"], meta[itemprop="priceCurrency"]',
        'content'
      );

      if (currencyMeta?.toUpperCase() === 'NZD') {
        diagnostics.currencySource =
          'META:itemprop=priceCurrency';
      } else {
        diagnostics.currencySource = 'DEFAULT:NZD';
      }

      /*
       * ============================================================
       * AVAILABILITY
       * New World product pages in this markup don't expose an
       * explicit stock-status element, so this is inferred from the
       * presence of a purchasable price and any "unavailable" text.
       * ============================================================
       */

      let availability: PageAvailability = 'unknown';

      const bodyText = cleanText(document.body.textContent) || '';

      if (
        /\bout\s+of\s+stock\b/i.test(bodyText) ||
        /\bsold\s+out\b/i.test(bodyText) ||
        /\bcurrently\s+unavailable\b/i.test(bodyText)
      ) {
        availability = 'out_of_stock';
        diagnostics.availabilitySource = 'TEXT:out-of-stock';
      } else if (price !== null) {
        availability = 'in_stock';
        diagnostics.availabilitySource =
          'FALLBACK:price-present';
      }

      /*
       * ============================================================
       * CANONICAL URL
       * ============================================================
       */

      const canonicalUrl =
        getAttribute('link[rel="canonical"]', 'href') ||
        window.location.href;

      const result: PageExtractedProduct = {
        name,
        sku,
        price,
        originalPrice,
        unitPrice,
        multibuy,
        availability,
        currency,
        canonicalUrl,
        diagnostics,
      };

      return result;
    });
  }

  /**
   * Main New World scraping method.
   */
  async scrapeProduct(
    url: string
  ): Promise<NewWorldScrapedProduct> {
    let page: Page | null = null;

    try {
      await browserService.initialize();

      page = await browserService.createPage();

      logger.info(`Scraping New World product: ${url}`);

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
       * Wait until either the product title or price is attached.
       */
      await page
        .locator(
          [
            '[data-testid="product-title"]',
            '[itemprop="offers"] [itemprop="price"]',
            '[data-testid="price-dollars"]',
          ].join(', ')
        )
        .first()
        .waitFor({
          state: 'attached',
          timeout: 15000,
        })
        .catch(() => {
          logger.debug(
            `New World product markup wait timed out for ${url}; ` +
              `continuing with the rendered page`
          );
        });

      try {
        await page.waitForLoadState('networkidle', {
          timeout: 2000,
        });
      } catch {
        logger.debug(
          `New World networkidle timeout for ${url}; ` +
            `continuing with the rendered page`
        );
      }

      /*
       * Confirm that Playwright loaded a product page.
       */
      await this.validateProductPage(page, productPageUrl);

      /*
       * Ensure the target store (New World Birkenhead) is selected
       * before reading price/availability, since both are
       * store-specific on New World.
       */
      await this.ensureStoreSet(page);

      /*
       * Extract the product information.
       */
      const product = await this.extractProduct(page);

      const savings =
        product.originalPrice !== null && product.price !== null
          ? Math.round(
              (product.originalPrice - product.price) * 100
            ) / 100
          : null;

      logger.info(
        `New World extraction result for ${url}: ` +
          `${JSON.stringify({
            finalPageUrl: page.url(),
            store: this.store.name,
            name: product.name,
            sku: product.sku,
            price: product.price,
            originalPrice: product.originalPrice,
            savings,
            unitPrice: product.unitPrice,
            multibuy: product.multibuy,
            currency: product.currency,
            availability: product.availability,
            diagnostics: product.diagnostics,
          })}`
      );

      /*
       * Log optional field warnings.
       */
      if (!product.name) {
        logger.warn(
          `New World product name could not be extracted for ${url}`
        );
      }

      if (!product.sku) {
        logger.warn(
          `New World SKU could not be extracted for ${url}`
        );
      }

      if (product.price === null) {
        logger.warn(
          `New World price could not be extracted for ${url}`
        );
      }

      if (product.availability === 'unknown') {
        logger.warn(
          `New World availability could not be determined for ${url}`
        );
      }

      /*
       * Product name and current price are required
       * for price monitoring.
       */
      if (!product.name) {
        throw new Error(
          `New World product extraction failed because the ` +
            `product name could not be determined for ${url}`
        );
      }

      if (product.price === null) {
        throw new Error(
          `New World product extraction failed because the ` +
            `current price could not be determined for ${url}`
        );
      }

      /*
       * Return the standardized scraper result.
       */
      const result: NewWorldScrapedProduct = {
        site: 'newworld',
        url: product.canonicalUrl || page.url(),
        name: product.name,
        sku: product.sku,
        price: product.price,
        originalPrice: product.originalPrice,
        savings,
        unitPrice: product.unitPrice,
        multibuy: product.multibuy,
        currency: 'NZD',
        availability: product.availability,
        store: this.store.name,
        scrapedAt: new Date().toISOString(),
      };

      return result;
    } catch (error) {
      logger.error(
        `New World scraping failed for ${url}:`,
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

export const newWorldAdapter = new NewWorldAdapter();
