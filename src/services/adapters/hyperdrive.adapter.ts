import { Page } from 'playwright';
import logger from '../../config/logger';
import { browserService } from '../browser.service';
import { ProductScraperAdapter } from './scraper-adapter.interface';
import { HyperdriveScrapedProduct } from '../../types/product-scrape.types';

type Availability =
  | 'in_stock'
  | 'out_of_stock'
  | 'check_availability'
  | 'unknown';

type Currency = 'NZD';

interface ExtractionDiagnostics {
  nameSource: string | null;
  skuSource: string | null;
  priceSource: string | null;
  originalPriceSource: string | null;
  availabilitySource: string | null;
  currencySource: string | null;
}

interface ExtractedProduct {
  name: string | null;
  sku: string | null;
  price: number | null;
  originalPrice: number | null;
  availability: Availability;
  currency: Currency;
  canonicalUrl: string;
  diagnostics: ExtractionDiagnostics;
}

export class HyperdriveAdapter implements ProductScraperAdapter {
  readonly site = 'hyperdrive' as const;

  private readonly navigationTimeout = 60000;

  /**
   * Determine whether this adapter can handle the supplied URL.
   */
  canHandle(url: string): boolean {
    try {
      const parsedUrl = new URL(url);
      const hostname = parsedUrl.hostname.toLowerCase();

      return (
        hostname === 'hyperdrive.co.nz' ||
        hostname.endsWith('.hyperdrive.co.nz')
      );
    } catch {
      return false;
    }
  }

  /**
   * Validate that the loaded page appears to be a product page.
   */
  private async validateProductPage(
    page: Page,
    expectedProductUrl: string
  ): Promise<void> {
    const currentUrl = page.url();

    const heading = await page
      .locator('h1')
      .first()
      .textContent({
        timeout: 10000,
      })
      .catch(() => null);

    const productName = await page
      .locator(
        [
          'h1 [itemprop="name"]',
          'h1[itemprop="name"]',
          '[itemprop="name"]',
        ].join(', ')
      )
      .first()
      .textContent({
        timeout: 5000,
      })
      .catch(() => null);

    const priceElementCount = await page
      .locator(
        [
          '[itemprop="offers"] [itemprop="price"]',
          '[itemprop="price"]',
          '.tyrePrice .price',
          '.price-area .price',
        ].join(', ')
      )
      .count()
      .catch(() => 0);

    const cleanedHeading =
      heading?.replace(/\s+/g, ' ').trim() || null;

    const cleanedProductName =
      productName?.replace(/\s+/g, ' ').trim() || null;

    if (
      !cleanedHeading &&
      !cleanedProductName &&
      priceElementCount === 0
    ) {
      throw new Error(
        `Hyperdrive extraction aborted because the loaded page ` +
          `does not appear to be a product page. ` +
          `Current URL: ${currentUrl}; ` +
          `expected URL: ${expectedProductUrl}`
      );
    }
  }

  /**
   * Extract product information from the rendered Hyperdrive page.
   */
  private async extractProduct(
    page: Page
  ): Promise<ExtractedProduct> {
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

      const parsePrice = (
        value: string | null | undefined
      ): number | null => {
        if (!value) {
          return null;
        }

        const cleaned = value
          .replace(/\u00a0/g, ' ')
          .replace(/,/g, '')
          .trim();

        const currencyMatch = cleaned.match(
          /(?:NZD|NZ\$|\$)\s*(\d+(?:\.\d{1,2})?)/
        );

        if (currencyMatch) {
          const parsed = Number(currencyMatch[1]);

          return Number.isFinite(parsed)
            ? parsed
            : null;
        }

        const numericMatch = cleaned.match(
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

      const getText = (
        selector: string
      ): string | null => {
        const element = document.querySelector(
          selector
        );

        return cleanText(element?.textContent);
      };

      const getAttribute = (
        selector: string,
        attribute: string
      ): string | null => {
        const element = document.querySelector(
          selector
        );

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

      const getFirstAttribute = (
        selectors: string[],
        attribute: string
      ): {
        value: string | null;
        selector: string | null;
      } => {
        for (const selector of selectors) {
          const value = getAttribute(
            selector,
            attribute
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

      const diagnostics: ExtractionDiagnostics = {
        nameSource: null,
        skuSource: null,
        priceSource: null,
        originalPriceSource: null,
        availabilitySource: null,
        currencySource: null,
      };

      /*
       * ============================================================
       * PRODUCT NAME
       * ============================================================
       */

      let name: string | null = null;

      const nameResult = getFirstText([
        'h1.page-heading-underline [itemprop="name"]',
        'h1.list-heading [itemprop="name"]',
        'h1 [itemprop="name"]',
        'h1[itemprop="name"]',
        'h1.page-heading-underline',
        'h1.list-heading',
        'h1',
      ]);

      if (nameResult.value) {
        name = nameResult.value;
        diagnostics.nameSource =
          `DOM:${nameResult.selector}`;
      }

      if (!name) {
        const metadataName = getAttribute(
          'meta[itemprop="name"]',
          'content'
        );

        if (metadataName) {
          name = metadataName;
          diagnostics.nameSource =
            'META:itemprop=name';
        }
      }

      if (!name) {
        const title = cleanText(document.title);

        if (title) {
          name = title
            .replace(
              /\s*(?:\||-)\s*Hyper\s*Drive.*$/i,
              ''
            )
            .replace(
              /\s*(?:\||-)\s*Hyperdrive.*$/i,
              ''
            )
            .trim();

          diagnostics.nameSource =
            'document.title';
        }
      }

      /*
       * ============================================================
       * SKU
       * ============================================================
       */

      let sku: string | null = null;

      const skuMetadataResult =
        getFirstAttribute(
          [
            'meta[itemprop="sku"]',
            'meta[itemprop="productID"]',
            '[itemprop="sku"][content]',
            '[itemprop="productID"][content]',
          ],
          'content'
        );

      if (skuMetadataResult.value) {
        sku = skuMetadataResult.value;
        diagnostics.skuSource =
          `META:${skuMetadataResult.selector}`;
      }

      if (!sku) {
        const skuContainers = Array.from(
          document.querySelectorAll(
            [
              'small.pull-right',
              'small',
              '[class*="sku" i]',
              '[class*="product-code" i]',
              '[class*="product-number" i]',
            ].join(', ')
          )
        );

        for (const container of skuContainers) {
          const containerText = cleanText(
            container.textContent
          );

          if (
            !containerText ||
            !/\bSKU\s*#/i.test(containerText)
          ) {
            continue;
          }

          const spanValue = cleanText(
            
