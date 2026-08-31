import { Page } from 'playwright';
import logger from '../../config/logger';
import { browserService, ProxyConfig } from '../browser.service';
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

/**
 * New World currently borrows the Woolworths proxy credentials
 * rather than having its own PROXY_SERVER_NEWWORLD env vars. If a
 * dedicated New World proxy is provisioned later, delete this
 * function and pass `undefined` to createPage() instead — that
 * restores the default behavior of resolving PROXY_SERVER_NEWWORLD
 * (falling back to the global PROXY_SERVER) via
 * browserService's own site-based resolution.
 */
function getBorrowedWoolworthsProxy(): ProxyConfig | null {
  const server = process.env.PROXY_SERVER_WOOLWORTHS;

  if (!server) {
    return null;
  }

  const username = process.env.PROXY_USERNAME_WOOLWORTHS;
  const password = process.env.PROXY_PASSWORD_WOOLWORTHS;

  return {
    server,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  };
}

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
   * Detect whether the current page is a Cloudflare (or similar)
   * bot-challenge interstitial rather than real site content.
   */
  private async isBotChallenge(page: Page): Promise<boolean> {
    const url = page.url();

    if (/[?&]__cf_chl_rt_tk=/.test(url)) {
      return true;
    }

    const title = await page.title().catch(() => '');

    if (
      /just a moment/i.test(title) ||
      /attention required/i.test(title)
    ) {
      return true;
    }

    const hasChallengeMarkup = await page
      .locator(
        '#challenge-form, #cf-challenge-running, [id^="cf-chl"]'
      )
      .first()
      .count()
      .then((count) => count > 0)
      .catch(() => false);

    return hasChallengeMarkup;
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
   * if any. New World renders separate desktop/mobile instances of
   * some elements with identical markup, so this is scoped to the
   * first one Playwright considers visible.
   */
  private async getCurrentStore(
    page: Page
  ): Promise<string | null> {
    const collectLabel = page
      .locator('p:has-text("Collect from"):visible')
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
   * Open the store-selection modal by clicking the "Collect from
   * <store>" label on the product page, which reveals a store
   * search input (aria-label="Choose a store",
   * placeholder="Search by store name, city or town/suburb").
   * Falls back to a couple of other common trigger patterns in
   * case the label text or layout varies on some pages.
   */
  private async openStorePicker(page: Page): Promise<void> {
    const storeSearchInput = page.getByPlaceholder(
      'Search by store name, city or town/suburb'
    );

    const alreadyOpen = await storeSearchInput
      .isVisible()
      .catch(() => false);

    if (alreadyOpen) {
      logger.debug('New World store picker already open');
      return;
    }

    const triggerCandidates: Array<{
      description: string;
      locator: () => ReturnType<Page['locator']>;
    }> = [
      {
        description: '"Collect from <store>" label',
        locator: () =>
          page.locator('p:has-text("Collect from"):visible').first(),
      },
      {
        description: '"Change store" link/button',
        locator: () =>
          page
            .getByRole('button', { name: /change store/i })
            .or(page.getByRole('link', { name: /change store/i }))
            .first(),
      },
      {
        description: '"Find a store" link/button',
        locator: () =>
          page
            .getByRole('button', { name: /find a store/i })
            .or(page.getByRole('link', { name: /find a store/i }))
            .first(),
      },
    ];

    for (const candidate of triggerCandidates) {
      const element = candidate.locator();

      const isVisible = await element.isVisible().catch(() => false);

      if (!isVisible) {
        continue;
      }

      logger.debug(
        `Attempting to open New World store picker via: ${candidate.description}`
      );

      await element.click().catch(() => null);

      const opened = await storeSearchInput
        .isVisible({ timeout: 3000 })
        .catch(() => false);

      if (opened) {
        logger.info(
          `New World store picker opened via: ${candidate.description}`
        );
        return;
      }
    }

    throw new Error(
      'Could not open the New World store picker — none of the ' +
        'known trigger patterns ("Collect from" label, Change ' +
        'store, Find a store) revealed the store search input.'
    );
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

    await this.openStorePicker(page);

    /*
     * The store search input's aria-label ("Choose a store") is a
     * more precise handle than data-testid, since data-testid is
     * shared with the site-wide search box. getByPlaceholder also
     * works, kept here for redundancy in case the label ever changes.
     */
    const searchInput = page
      .getByLabel('Choose a store')
      .or(
        page.getByPlaceholder(
          'Search by store name, city or town/suburb'
        )
      )
      .first();

    await searchInput.waitFor({
      state: 'visible',
      timeout: 10000,
    });

    await searchInput.fill(this.store.searchTerm);

    /*
     * The results dropdown closes on blur, so everything from here
     * needs to happen without an intervening action that could
     * steal focus.
     */
    const resultAddress = page
      .locator(`text=${this.store.addressMatch}`)
      .first();

    await resultAddress
      .waitFor({ state: 'visible', timeout: 10000 })
      .catch(() => {
        throw new Error(
          `New World store search returned no results for ` +
            `"${this.store.searchTerm}"`
        );
      });

    /*
     * Click "Select" on the matching result. Searching a specific
     * suburb term like "Birkenhead" reliably returns a single
     * store, so there should only be one "Select" button rendered
     * in the dropdown at this point.
     */
    const selectButton = page
      .getByRole('button', { name: 'Select', exact: false })
      .first();

    await selectButton.waitFor({
      state: 'visible',
      timeout: 10000,
    });

    await selectButton.click();

    /*
     * After selecting, New World shows a confirmation card plus a
     * "Continue shopping" link to dismiss the picker and return to
     * the underlying page.
     */
    const continueShopping = page
      .getByRole('link', { name: 'Continue shopping' })
      .first();

    await continueShopping
      .waitFor({ state: 'visible', timeout: 10000 })
      .catch(() => {
        logger.debug(
          `"Continue shopping" link did not appear after selecting ` +
            `"${this.store.name}"; the picker may have closed on its own`
        );
      });

    if (await continueShopping.isVisible().catch(() => false)) {
      await continueShopping.click();
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

      /*
       * New World currently borrows Woolworths' proxy credentials
       * (see getBorrowedWoolworthsProxy above). The context itself
       * stays keyed to "newworld", so cookies/storage state remain
       * fully isolated from the actual Woolworths adapter — only
       * the proxy connection is shared.
       */
      const proxy = getBorrowedWoolworthsProxy();

      logger.info(
        `Resolved proxy for New World: ${
          proxy
            ? `server=${proxy.server}, hasUsername=${!!proxy.username}, hasPassword=${!!proxy.password}`
            : 'none'
        }`
      );

      page = await browserService.createPage('newworld', proxy);

      logger.info(
        `Scraping New World product: ${url}` +
          `${
            proxy
              ? ` (using borrowed Woolworths proxy: ${proxy.server})`
              : ' (no proxy configured)'
          }`
      );

      /*
       * Navigate to the product page.
       */
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: this.navigationTimeout,
      });

      /*
       * Cloudflare (or similar) bot-management challenges can
       * intercept the navigation before the real page loads.
       * Give it a short window to auto-resolve, since real browsers
       * typically clear it in a few seconds.
       */
      if (await this.isBotChallenge(page)) {
        logger.warn(
          `New World served a bot-management challenge for ${url}; ` +
            `waiting to see if it clears`
        );

        try {
          await page.waitForURL(
            (candidateUrl) =>
              !/[?&]__cf_chl_rt_tk=/.test(candidateUrl.toString()),
            { timeout: 10000 }
          );
        } catch {
          // Still on the challenge page — fall through to the check
          // below, which will throw a clear, distinguishable error.
        }

        // Give any post-redirect content a moment to render.
        await page.waitForTimeout(1000);
      }

      if (await this.isBotChallenge(page)) {
        throw new Error(
          `New World blocked this request with a bot-management ` +
            `challenge for ${url}. This is not a selector/parsing ` +
            `issue — the site did not serve product content.`
        );
      }

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

      /*
       * Persist cookies (including any cf_clearance token earned by
       * passing a challenge) so the next scrape can reuse this
       * session and potentially skip the challenge entirely.
       */
      await browserService.persistStorageState('newworld');

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
