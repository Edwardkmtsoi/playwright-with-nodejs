import { Page } from 'playwright';
import logger from '../../config/logger';
import { browserService } from '../browser.service';
import { ProductScraperAdapter } from './scraper-adapter.interface';
import { SupercheapAutoScrapedProduct } from '../../types/product-scrape.types';

export class SupercheapAutoAdapter implements ProductScraperAdapter {
  readonly site = 'supercheapauto' as const;

  private readonly storeName = 'SCA Wairau Park';
  private readonly postalCode = '0627';

  canHandle(url: string): boolean {
    try {
      const parsedUrl = new URL(url);
      const hostname = parsedUrl.hostname.toLowerCase();

      return hostname.endsWith('supercheapauto.co.nz');
    } catch {
      return false;
    }
  }

  private async ensureStoreSelected(page: Page): Promise<void> {
    try {
      const existingStoreName = await page
        .locator(
          [
            '.my-store-link',
            '.header-session .my-store-link',
            'a[href*="/stores/details/sca-wairau-park"]',
            `text=${this.storeName}`,
          ].join(', ')
        )
        .first()
        .textContent({ timeout: 4000 })
        .catch(() => null);

      if (
        existingStoreName &&
        existingStoreName.trim().toLowerCase().includes(
          this.storeName.toLowerCase()
        )
      ) {
        logger.debug(
          `Supercheap Auto store already set to ${this.storeName}; skipping store selection`
        );
        return;
      }

      logger.info(
        `Supercheap Auto store not set, selecting ${this.storeName} (${this.postalCode})`
      );

      const openStoreFinder = page
        .locator(
          [
            '.find-store',
            '.my-store',
            '.my-store-link',
            'a[href*="store-locator"]',
            'button:has-text("Find a Store")',
            'a:has-text("Find a Store")',
            'button:has-text("My Store")',
            'a:has-text("My Store")',
            'button:has-text("Stores")',
            'a:has-text("Stores")',
          ].join(', ')
        )
        .first();

      await openStoreFinder.click({
        timeout: 10000,
      });

      const searchInput = page
        .locator(
          [
            'input[placeholder*="postcode" i]',
            'input[placeholder*="suburb" i]',
            'input[placeholder*="store" i]',
            'input[name*="postcode" i]',
            'input[name*="postal" i]',
            'input[name*="zip" i]',
            'input[type="search"]',
          ].join(', ')
        )
        .first();

      await searchInput.waitFor({
        timeout: 10000,
        state: 'visible',
      });

      await searchInput.fill(this.postalCode);
      await searchInput.press('Enter');

      const storeResult = page
        .locator(
          [
            `text=${this.storeName}`,
            `.store-name:has-text("${this.storeName}")`,
            `.store-list-item:has-text("${this.storeName}")`,
            `.store-result:has-text("${this.storeName}")`,
            `[href*="sca-wairau-park"]`,
          ].join(', ')
        )
        .first();

      await storeResult.waitFor({
        timeout: 15000,
        state: 'visible',
      });

      let selectButton = storeResult
        .locator('a, button')
        .filter({
          hasText:
            /set as my store|set preferred store|confirm preferred store|select store|confirm/i,
        })
        .first();

      if (!(await selectButton.count().catch(() => 0))) {
        selectButton = page
          .locator('a, button')
          .filter({
            hasText:
              /set as my store|set preferred store|confirm preferred store|select store|confirm/i,
          })
          .first();
      }

      await selectButton.click({
        timeout: 10000,
      });

      try {
        await page.waitForLoadState('domcontentloaded', {
          timeout: 10000,
        });
      } catch {
        // AJAX update is also valid.
      }

      await page.waitForTimeout(2000);

      const confirmedStore = await page
        .locator(
          [
            `.my-store-link:has-text("${this.storeName}")`,
            `a[href*="sca-wairau-park"]:has-text("${this.storeName}")`,
            `text=${this.storeName}`,
          ].join(', ')
        )
        .first()
        .textContent({ timeout: 8000 })
        .catch(() => null);

      if (confirmedStore) {
        logger.info(
          `Supercheap Auto store selection completed: ${this.storeName}`
        );
      } else {
        logger.info(
          `Supercheap Auto store selection clicked for ${this.storeName}; confirmation element was not detected`
        );
      }
    } catch (error) {
      logger.warn(
        `Supercheap Auto store selection failed. Store availability may be incomplete: ${
          error instanceof Error ? error.message : String(error)
        }`
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

      await this.ensureStoreSelected(page);

      try {
        await page.waitForLoadState('networkidle', {
          timeout: 5000,
        });
      } catch {
        logger.debug(
          `Supercheap Auto networkidle timeout for ${url}; continuing with rendered page`
        );
      }

      await page.waitForTimeout(2000);

      const product = await page.evaluate(() => {
        type ExtractedProduct = {
          name: string | null;
          sku: string | null;
          price: number | null;
          originalPrice: number | null;
          saleEndDate: string | null;
          availability:
            | 'in_stock'
            | 'out_of_stock'
            | 'check_availability'
            | 'unknown'
            | null;
          storeAvailability:
            | 'in_stock'
            | 'out_of_stock'
            | 'check_availability'
            | 'unknown'
            | null;
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

          const text = value
            .replace(/\u00a0/g, ' ')
            .replace(/,/g, '')
            .trim();

          const match = text.match(
            /(?:NZD|NZ|\$)?\s*(\d+(?:\.\d{1,2})?)/
          );

          if (!match) return null;

          const parsed = Number(match[1]);

          return Number.isFinite(parsed) ? parsed : null;
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

        const scripts = Array.from(
          document.querySelectorAll('script')
        );

        let pageContextTitle: string | null = null;

        for (const script of scripts) {
          const text = script.textContent || '';

          const match = text.match(
            /pageContext\s*=\s*({[\s\S]*?});/
          );

          if (!match) continue;

          try {
            const parsed = JSON.parse(match[1]);

            if (parsed?.title) {
              pageContextTitle = cleanText(String(parsed.title));
              break;
            }
          } catch {
            // Ignore malformed pageContext.
          }
        }

        let name: string | null = null;

        if (pageContextTitle) {
          name = pageContextTitle;
          diagnostics.nameSource = 'JS:pageContext.title';
        }

        if (!name) {
          name =
            getText('h1') ||
            getText('[itemprop="name"]') ||
            getText('[class*="product-name" i]') ||
            getText('[class*="product-title" i]');

          if (name) {
            diagnostics.nameSource = 'DOM:name-selector';
          }
        }

        if (!name) {
          const title = cleanText(document.title);

          if (title) {
            name = title
              .replace(/\s*\|\s*Supercheap Auto New Zealand\s*$/i, '')
              .trim();

            diagnostics.nameSource = 'document.title';
          }
        }

        let sku: string | null = null;

        const productIdMeta = getAttribute(
          'meta[itemprop="productID"]',
          'content'
        );

        if (productIdMeta) {
          sku = productIdMeta;
          diagnostics.skuSource = 'META:itemprop=productID';
        }

        if (!sku) {
          const masterIdElement = document.querySelector('[data-masterid]');

          const dataMasterId = cleanText(
            masterIdElement?.getAttribute('data-masterid')
          );

          if (dataMasterId) {
            sku = dataMasterId;
            diagnostics.skuSource = 'DOM:data-masterid';
          }
        }

        if (!sku) {
          const productNumberText =
            getText('.product-number') ||
            getText('[class*="product-number" i]');

          const match = productNumberText?.match(
            /Item\s*No\.?\s*([A-Z0-9._-]+)/i
          );

          if (match) {
            sku = match[1];
            diagnostics.skuSource = 'TEXT:Item No';
          }
        }

        let price: number | null = null;

        const priceSelectors = [
          '.price-sales .promo-price',
          '.promo-price',
          '.price-sales',
          '[class*="promo-price" i]',
          '[class*="price-sales" i]',
          '[itemprop="price"]',
        ];

        for (const selector of priceSelectors) {
          const candidate = parsePrice(getText(selector));

          if (candidate !== null) {
            price = candidate;
            diagnostics.priceSource = `DOM:${selector}`;
            break;
          }
        }

        let originalPrice: number | null = null;

        const originalPriceSelectors = [
          '.price-standard .stroke-content',
          '.price-standard',
          '.was-label',
          '[class*="price-standard" i]',
          '[class*="stroke-content" i]',
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
          const bodyText = cleanText(document.body?.innerText) || '';

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

        let saleEndDate: string | null = null;

        const saleEndText =
          getText('.saleprice-end-date') ||
          getText('[class*="saleprice-end-date" i]');

        if (saleEndText) {
          const dateMatch = saleEndText.match(
            /(\d{1,2}\/\d{1,2}\/\d{2,4})/
          );

          saleEndDate = dateMatch ? dateMatch[1] : saleEndText;
          diagnostics.saleEndDateSource = 'DOM:.saleprice-end-date';
        }

        let store: string | null = null;

        const storeSelectors = [
          '.my-store-link',
          '.header-session .my-store-link',
          'a[href*="/stores/details/"]',
          '[class*="my-store-link" i]',
        ];

        for (const selector of storeSelectors) {
          const value = getText(selector);

          if (value) {
            store = value;
            diagnostics.storeSource = `DOM:${selector}`;
            break;
          }
        }

        let availability:
          | 'in_stock'
          | 'out_of_stock'
          | 'check_availability'
          | 'unknown'
          | null = 'unknown';

        let storeAvailability:
          | 'in_stock'
          | 'out_of_stock'
          | 'check_availability'
          | 'unknown'
          | null = 'unknown';

        const bodyText = cleanText(document.body?.innerText) || '';

        if (
          /\bcurrently\s+unavailable\b/i.test(bodyText) ||
          /\bnot\s+available\b/i.test(bodyText) ||
          /\bnot\s+stocked\b/i.test(bodyText)
        ) {
          availability = 'out_of_stock';
          diagnostics.availabilitySource = 'TEXT:not-available';
        } else if (
          /\bin\s+stock\b/i.test(bodyText) ||
          /\badd\s+to\s+cart\b/i.test(bodyText) ||
          /\bpick\s+up\s+today\b/i.test(bodyText)
        ) {
          availability = 'in_stock';
          diagnostics.availabilitySource = 'TEXT:in-stock/add-to-cart';
        }

        const storeSpecificPatterns = [
          /SCA\s+Wairau\s+Park[\s\S]{0,200}?\b-\s*in\s+stock\b/i,
          /SCA\s+Wairau\s+Park[\s\S]{0,200}?\bin\s+stock\b/i,
          /SCA\s+Wairau\s+Park[\s\S]{0,200}?\bpick\s+up\s+today\b/i,
        ];

        const storeNoStockPatterns = [
          /SCA\s+Wairau\s+Park[\s\S]{0,200}?\b-\s*no\s+stock\b/i,
          /SCA\s+Wairau\s+Park[\s\S]{0,200}?\bno\s+stock\b/i,
          /SCA\s+Wairau\s+Park[\s\S]{0,200}?\bcurrently\s+unavailable\b/i,
          /SCA\s+Wairau\s+Park[\s\S]{0,200}?\bunavailable\b/i,
        ];

        if (storeSpecificPatterns.some((pattern) => pattern.test(bodyText))) {
          storeAvailability = 'in_stock';
          diagnostics.storeAvailabilitySource =
            'TEXT:SCA Wairau Park in stock';
        } else if (
          storeNoStockPatterns.some((pattern) => pattern.test(bodyText))
        ) {
          storeAvailability = 'out_of_stock';
          diagnostics.storeAvailabilitySource =
            'TEXT:SCA Wairau Park no stock';
        } else if (
          store &&
          /SCA\s+Wairau\s+Park/i.test(store) &&
          availability !== 'unknown'
        ) {
          storeAvailability = availability;
          diagnostics.storeAvailabilitySource =
            'FALLBACK:selected-store-product-availability';
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
      });

      logger.info(
        `Supercheap Auto extraction result for ${url}: ${JSON.stringify({
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

      if (
        product.store &&
        !product.store
          .toLowerCase()
          .includes(this.storeName.toLowerCase())
      ) {
        logger.warn(
          `Supercheap Auto returned store "${product.store}" instead of "${this.storeName}"`
        );
      }

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
