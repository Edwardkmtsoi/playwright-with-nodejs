import { Page } from 'playwright';
import logger from '../../config/logger';
import { browserService } from '../browser.service';
import { ProductScraperAdapter } from './scraper-adapter.interface';
import { RepcoScrapedProduct } from '../../types/product-scrape.types';

export class RepcoAdapter implements ProductScraperAdapter {
  readonly site = 'repco' as const;

  private readonly storeName = 'North Shore';
  private readonly postalCode = '0626';

  canHandle(url: string): boolean {
    try {
      const parsedUrl = new URL(url);

      return parsedUrl.hostname.toLowerCase().endsWith('repco.co.nz');
    } catch {
      return false;
    }
  }

  private async ensureStoreSelected(page: Page): Promise<void> {
    try {
      const existingStoreName = await page
        .locator(
          '.product-eligibility .store-name, .tab-store-change .store-name'
        )
        .first()
        .textContent({ timeout: 3000 })
        .catch(() => null);

      if (
        existingStoreName &&
        existingStoreName.trim().toLowerCase() ===
          this.storeName.toLowerCase()
      ) {
        logger.debug(
          `Repco store already set to ${this.storeName}; skipping store selection`
        );
        return;
      }

      logger.info(
        `Repco store not set, selecting ${this.storeName} directly on product page`
      );

      const openStoreFinder = page
        .locator(
          [
            '.js-store-finder-button',
            '.js-repco-store-finder',
            'a:has-text("Set my store")',
            'button:has-text("Set my store")',
            'a:has-text("Tap here to set your store")',
            'button:has-text("Tap here to set your store")',
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
            'input[name*="postcode" i]',
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
            `.store-name:has-text("${this.storeName}")`,
            `.store-list-item:has-text("${this.storeName}")`,
            `.store-result:has-text("${this.storeName}")`,
            `text=${this.storeName}`,
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
          hasText: /select store|set as my store/i,
        })
        .first();

      if (!(await selectButton.count().catch(() => 0))) {
        selectButton = page
          .locator('a, button')
          .filter({
            hasText: /select store|set as my store/i,
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

      await page.waitForTimeout(1500);

      try {
        await page
          .locator(
            `.product-eligibility .store-name:has-text("${this.storeName}"), ` +
              `.tab-store-change .store-name:has-text("${this.storeName}")`
          )
          .first()
          .waitFor({
            timeout: 10000,
            state: 'visible',
          });

        logger.info(`Repco store selection completed: ${this.storeName}`);
      } catch {
        logger.info(
          `Repco store selection clicked for ${this.storeName}; ` +
            `store confirmation element was not detected`
        );
      }
    } catch (error) {
      logger.warn(
        `Repco store selection failed. Availability/store data may be incomplete: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  async scrapeProduct(url: string): Promise<RepcoScrapedProduct> {
    let page: Page | null = null;

    try {
      await browserService.initialize();
      page = await browserService.createPage();

      logger.info(
        `Scraping Repco product: ${url} using store ${this.storeName} (${this.postalCode})`
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
          `Repco networkidle timeout for ${url}; continuing with rendered page`
        );
      }

      await page.waitForTimeout(2500);

      try {
        await page.waitForSelector('h1', {
          timeout: 10000,
          state: 'attached',
        });
      } catch {
        logger.debug(`Repco h1 not found quickly for ${url}`);
      }

      const product = await page.evaluate(() => {
        type ExtractedProduct = {
          name: string | null;
          sku: string | null;
          price: number | null;
          originalPrice: number | null;
          memberPrice: number | null;
          availability:
            | 'in_stock'
            | 'out_of_stock'
            | 'check_availability'
            | null;
          store: string | null;
          diagnostics: {
            priceSources: string[];
            memberPriceSources: string[];
            originalPriceSources: string[];
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
            /(?:NZD|NZ|\$)\s*(\d+(?:\.\d{1,2})?)/i
          );

          if (match) {
            const parsed = Number(match[1]);
            return Number.isFinite(parsed) ? parsed : null;
          }

          const numericMatch = text.match(/\b(\d+(?:\.\d{1,2})?)\b/);

          if (numericMatch) {
            const parsed = Number(numericMatch[1]);
            return Number.isFinite(parsed) ? parsed : null;
          }

          return null;
        };

        const parseAllPrices = (
          value: string | null | undefined
        ): number[] => {
          if (!value) return [];

          const text = value
            .replace(/\u00a0/g, ' ')
            .replace(/,/g, '');

          const matches = text.match(
            /(?:NZD|NZ|\$)\s*\d+(?:\.\d{1,2})?/gi
          );

          if (!matches) return [];

          return matches
            .map((match) => parsePrice(match))
            .filter(
              (price): price is number =>
                price !== null && Number.isFinite(price)
            );
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

        const addDiagnostic = (
          array: string[],
          source: string
        ): void => {
          if (!array.includes(source)) {
            array.push(source);
          }
        };

        const findProductRoot = (): Element | null => {
          const title =
            document.querySelector('.pdp-product-title') ||
            document.querySelector('[data-testid*="product-title" i]') ||
            document.querySelector('h1');

          if (!title) {
            return (
              document.querySelector('.product-details') ||
              document.querySelector('main')
            );
          }

          let current: Element | null = title;

          for (let i = 0; i < 8 && current; i++) {
            const textLength = current.textContent?.length || 0;

            if (
              current.querySelector(
                '.price__container, .price, [class*="price" i]'
              ) &&
              textLength < 50000
            ) {
              return current;
            }

            current = current.parentElement;
          }

          return (
            document.querySelector('.product-details') ||
            document.querySelector('main') ||
            title.parentElement
          );
        };

        const productRoot = findProductRoot();

        const priceSources: string[] = [];
        const memberPriceSources: string[] = [];
        const originalPriceSources: string[] = [];

        const name =
          getText('.pdp-product-title') ||
          getText('[data-testid="product-title"]') ||
          getText('[data-testid*="product-title" i]') ||
          getText('h1');

        let sku: string | null = null;

        const skuSelectors = [
          '.product-sku',
          '[data-testid="product-sku"]',
          '[data-testid*="sku" i]',
          '[class*="sku" i]',
        ];

        for (const selector of skuSelectors) {
          const element = document.querySelector(selector);

          if (!element) continue;

          const text = cleanText(element.textContent);

          if (!text) continue;

          const match = text.match(
            /(?:SKU|Product\s*(?:Code|Number)|Part\s*Number)\s*[:#-]?\s*([A-Z0-9][A-Z0-9._-]*)/i
          );

          if (match) {
            sku = match[1].trim();
            break;
          }

          if (
            /sku/i.test(selector) &&
            /^[A-Z0-9][A-Z0-9._-]{2,}$/i.test(text)
          ) {
            sku = text;
            break;
          }
        }

        if (!sku && productRoot) {
          const rootText = cleanText(productRoot.textContent) || '';

          const match = rootText.match(
            /(?:SKU|Product\s*(?:Code|Number)|Part\s*Number)\s*[:#-]?\s*([A-Z0-9][A-Z0-9._-]*)/i
          );

          if (match) {
            sku = match[1].trim();
          }
        }

        let structuredPrice: number | null = null;
        let structuredSku: string | null = null;
        let structuredAvailability:
          | 'in_stock'
          | 'out_of_stock'
          | 'check_availability'
          | null = null;

        const jsonLdScripts = Array.from(
          document.querySelectorAll('script[type="application/ld+json"]')
        );

        const findProductObjects = (value: unknown): any[] => {
          const results: any[] = [];

          const visit = (item: any): void => {
            if (!item || typeof item !== 'object') {
              return;
            }

            if (Array.isArray(item)) {
              for (const child of item) {
                visit(child);
              }

              return;
            }

            if (
              item['@type'] === 'Product' ||
              (Array.isArray(item['@type']) &&
                item['@type'].includes('Product'))
            ) {
              results.push(item);
            }

            if (item['@graph']) {
              visit(item['@graph']);
            }
          };

          visit(value);

          return results;
        };

        for (const script of jsonLdScripts) {
          try {
            const raw = script.textContent;

            if (!raw) continue;

            const parsed = JSON.parse(raw);
            const products = findProductObjects(parsed);

            for (const product of products) {
              if (!structuredSku && product.sku) {
                structuredSku = String(product.sku).trim();
              }

              const offers = Array.isArray(product.offers)
                ? product.offers
                : product.offers
                  ? [product.offers]
                  : [];

              for (const offer of offers) {
                if (
                  structuredPrice === null &&
                  offer?.price !== undefined
                ) {
                  const parsedPrice = parsePrice(String(offer.price));

                  if (parsedPrice !== null) {
                    structuredPrice = parsedPrice;
                  }
                }

                const availabilityText = String(offer?.availability || '');

                if (
                  structuredAvailability === null &&
                  /outofstock/i.test(availabilityText)
                ) {
                  structuredAvailability = 'out_of_stock';
                } else if (
                  structuredAvailability === null &&
                  /instock/i.test(availabilityText)
                ) {
                  structuredAvailability = 'in_stock';
                }
              }
            }
          } catch {
            // Ignore malformed JSON-LD.
          }
        }

        let price: number | null = null;
        let originalPrice: number | null = null;

        if (productRoot) {
          const priceContainers = Array.from(
            productRoot.querySelectorAll(
              '.price__container, .product-price, .price'
            )
          );

          for (const container of priceContainers) {
            const containerText = cleanText(container.textContent) || '';

            if (!containerText) continue;

            const currentSelectors = [
              '.price__dollars.has-promo',
              '.price__dollars',
              '.sale-price',
              '.current-price',
              '.selling-price',
              '[class*="sale-price" i]',
              '[class*="current-price" i]',
              '[class*="selling-price" i]',
              '[class*="price__dollars" i]',
            ];

            for (const selector of currentSelectors) {
              const elements = Array.from(container.querySelectorAll(selector));

              for (const element of elements) {
                const candidate = parsePrice(element.textContent);

                if (candidate !== null) {
                  price = candidate;
                  addDiagnostic(priceSources, `DOM:${selector}`);
                  break;
                }
              }

              if (price !== null) break;
            }

            if (price === null) {
              const candidates = Array.from(
                container.querySelectorAll(
                  '[class*="price" i], [class*="amount" i], span, strong, b'
                )
              );

              for (const element of candidates) {
                const text = cleanText(element.textContent);

                if (!text) continue;

                const candidate = parsePrice(text);

                if (candidate === null) continue;

                if (/saving|save|was|rrp|original|member/i.test(text)) {
                  continue;
                }

                price = candidate;
                addDiagnostic(priceSources, 'DOM:price-container-fallback');
                break;
              }
            }

            const originalSelectors = [
              '.savings',
              '.was-price',
              '.original-price',
              '.rrp',
              '[class*="was-price" i]',
              '[class*="original-price" i]',
              '[class*="rrp" i]',
              '[class*="saving" i]',
            ];

            for (const selector of originalSelectors) {
              const elements = Array.from(container.querySelectorAll(selector));

              for (const element of elements) {
                const candidate = parsePrice(element.textContent);

                if (candidate !== null && candidate !== price) {
                  originalPrice = candidate;
                  addDiagnostic(originalPriceSources, `DOM:${selector}`);
                  break;
                }
              }

              if (originalPrice !== null) break;
            }

            if (price !== null) break;
          }
        }

        if (price === null && productRoot) {
          const priceElements = Array.from(
            productRoot.querySelectorAll('[class*="price" i]')
          );

          for (const element of priceElements) {
            const text = cleanText(element.textContent);

            if (!text) continue;
            if (text.length > 300) continue;
            if (/member|saving|save|was|rrp|original/i.test(text)) continue;

            const candidate = parsePrice(text);

            if (candidate !== null) {
              price = candidate;
              addDiagnostic(priceSources, 'DOM:product-root-price');
              break;
            }
          }
        }

        if (price === null) {
          const metaPriceSelectors = [
            'meta[property="og:price:amount"]',
            'meta[property="product:price:amount"]',
            'meta[itemprop="price"]',
            'meta[name="price"]',
          ];

          for (const selector of metaPriceSelectors) {
            const value = getAttribute(selector, 'content');
            const candidate = parsePrice(value);

            if (candidate !== null) {
              price = candidate;
              addDiagnostic(priceSources, `META:${selector}`);
              break;
            }
          }
        }

        if (price === null && structuredPrice !== null) {
          price = structuredPrice;
          addDiagnostic(priceSources, 'JSON-LD:offers.price');
        }

        if (originalPrice === null && productRoot) {
          const rootText = cleanText(productRoot.textContent) || '';

          const originalPatterns = [
            /\bwas\s*(?:NZD|NZ|\$)?\s*([\d,]+(?:\.\d{1,2})?)/i,
            /\brrp\s*(?:NZD|NZ|\$)?\s*([\d,]+(?:\.\d{1,2})?)/i,
            /\boriginal(?:ly)?\s*(?:price\s*)?(?:NZD|NZ|\$)?\s*([\d,]+(?:\.\d{1,2})?)/i,
          ];

          for (const pattern of originalPatterns) {
            const match = rootText.match(pattern);

            if (match) {
              const candidate = parsePrice(match[1]);

              if (candidate !== null && candidate !== price) {
                originalPrice = candidate;
                addDiagnostic(originalPriceSources, 'TEXT:original-price');
                break;
              }
            }
          }
        }

        if (
          originalPrice === null &&
          productRoot &&
          price !== null
        ) {
          const priceContainers = Array.from(
            productRoot.querySelectorAll(
              '.price__container, .product-price, .price'
            )
          );

          for (const container of priceContainers) {
            const prices = parseAllPrices(container.textContent);

            const higherPrices = prices.filter(
              (candidate) => candidate > price!
            );

            if (higherPrices.length > 0) {
              originalPrice = Math.max(...higherPrices);
              addDiagnostic(
                originalPriceSources,
                'DOM:price-container-higher-price'
              );
              break;
            }
          }
        }

        let memberPrice: number | null = null;

        if (productRoot) {
          const root = productRoot;

          const promotionContainers = Array.from(
            root.querySelectorAll(
              '.price__container .promotion-price, .promotion-price'
            )
          );

          for (const container of promotionContainers) {
            const label =
              cleanText(
                container.querySelector('.promotion-label')?.textContent
              ) || '';

            if (
              !/member\s*price/i.test(label) &&
              !/member\s*deal/i.test(label) &&
              !/rewards\s*member/i.test(label)
            ) {
              continue;
            }

            const promotionPriceElements = Array.from(
              container.querySelectorAll('.price')
            );

            for (const element of promotionPriceElements) {
              const candidate = parsePrice(element.textContent);

              if (
                candidate !== null &&
                (price === null || candidate < price)
              ) {
                memberPrice = candidate;
                addDiagnostic(
                  memberPriceSources,
                  'DOM:.promotion-price.member-price'
                );
                break;
              }
            }

            if (memberPrice !== null) break;

            const promotionText = cleanText(container.textContent) || '';

            const promotionPrices = parseAllPrices(promotionText).filter(
              (candidate) => price === null || candidate < price
            );

            if (promotionPrices.length > 0) {
              memberPrice = promotionPrices[0];
              addDiagnostic(
                memberPriceSources,
                'DOM:.promotion-price.member-price-fallback'
              );
              break;
            }
          }

          if (memberPrice === null) {
            const attributeSelectors = [
              '[data-member-price]',
              '[data-memberprice]',
              '[data-rewards-price]',
            ];

            for (const selector of attributeSelectors) {
              const elements = Array.from(root.querySelectorAll(selector));

              for (const element of elements) {
                const value =
                  element.getAttribute('data-member-price') ??
                  element.getAttribute('data-memberprice') ??
                  element.getAttribute('data-rewards-price');

                const candidate = parsePrice(value);

                if (
                  candidate !== null &&
                  (price === null || candidate < price)
                ) {
                  memberPrice = candidate;
                  addDiagnostic(memberPriceSources, `DOM:${selector}`);
                  break;
                }
              }

              if (memberPrice !== null) break;
            }
          }

          if (memberPrice === null) {
            const memberSelectors = [
              '.member-price',
              '.price--member',
              '[data-testid*="member-price" i]',
              '[class*="member-price" i]',
              '[class*="member_price" i]',
            ];

            for (const selector of memberSelectors) {
              const elements = Array.from(root.querySelectorAll(selector));

              for (const element of elements) {
                const text = cleanText(element.textContent) || '';

                if (
                  !/member\s*price|member\s*deal|rewards\s*member/i.test(text)
                ) {
                  continue;
                }

                const prices = parseAllPrices(text).filter(
                  (candidate) => price === null || candidate < price
                );

                if (prices.length > 0) {
                  memberPrice = prices[0];
                  addDiagnostic(memberPriceSources, `DOM:${selector}`);
                  break;
                }
              }

              if (memberPrice !== null) break;
            }
          }
        }

        let availability:
          | 'in_stock'
          | 'out_of_stock'
          | 'check_availability'
          | null = null;

        const eligibilitySelectors = [
          '.product-eligibility',
          '[data-testid*="eligibility" i]',
          '[class*="product-eligibility" i]',
          '[class*="availability" i]',
          '[class*="stock-status" i]',
        ];

        let eligibility: Element | null = null;

        for (const selector of eligibilitySelectors) {
          const element = document.querySelector(selector);

          if (element) {
            eligibility = element;
            break;
          }
        }

        if (eligibility) {
          const stockStatus = cleanText(eligibility.textContent) || '';

          if (
            /\bout\s*of\s*stock\b/i.test(stockStatus) ||
            /\bunavailable\b/i.test(stockStatus)
          ) {
            availability = 'out_of_stock';
          } else if (
            /\bin\s*stock\b/i.test(stockStatus) ||
            /\bavailable\b/i.test(stockStatus)
          ) {
            availability = 'in_stock';
          } else if (/check\s*availability/i.test(stockStatus)) {
            availability = 'check_availability';
          }
        }

        if (
          availability === null &&
          structuredAvailability !== null
        ) {
          availability = structuredAvailability;
        }

        if (availability === null && productRoot) {
          const productText = cleanText(productRoot.textContent) || '';

          if (
            /\bout\s*of\s*stock\b/i.test(productText) ||
            /\bunavailable\b/i.test(productText)
          ) {
            availability = 'out_of_stock';
          } else if (/\bin\s*stock\b/i.test(productText)) {
            availability = 'in_stock';
          } else if (/check\s*availability/i.test(productText)) {
            availability = 'check_availability';
          }
        }

        let store: string | null = null;

        const storeSelectors = [
          '.product-eligibility .store-name',
          '.store-name',
          '[data-testid*="store-name" i]',
          '[class*="store-name" i]',
        ];

        for (const selector of storeSelectors) {
          const value = getText(selector);

          if (value) {
            store = value;
            break;
          }
        }

        if (!store && eligibility) {
          const eligibilityText = cleanText(eligibility.textContent) || '';

          const storeMatch = eligibilityText.match(
            /(?:store|pickup|pick\s*up)[\s:|-]+([A-Za-z][A-Za-z0-9 '&.-]{2,50})/i
          );

          if (storeMatch) {
            store = cleanText(storeMatch[1]);
          }
        }

        if (
          originalPrice !== null &&
          price !== null &&
          originalPrice === price
        ) {
          originalPrice = null;
        }

        if (
          memberPrice !== null &&
          price !== null &&
          memberPrice === price
        ) {
          memberPrice = null;
        }

        if (
          memberPrice !== null &&
          price !== null &&
          memberPrice > price
        ) {
          memberPrice = null;
        }

        if (
          originalPrice !== null &&
          price !== null &&
          originalPrice < price
        ) {
          originalPrice = null;
        }

        return {
          name,
          sku: sku || structuredSku,
          price,
          originalPrice,
          memberPrice,
          availability,
          store,
          diagnostics: {
            priceSources,
            memberPriceSources,
            originalPriceSources,
          },
        } satisfies ExtractedProduct;
      });

      logger.info(
        `Repco extraction result for ${url}: ${JSON.stringify({
          name: product.name,
          sku: product.sku,
          price: product.price,
          originalPrice: product.originalPrice,
          memberPrice: product.memberPrice,
          availability: product.availability,
          store: product.store,
          priceSources: product.diagnostics.priceSources,
          memberPriceSources: product.diagnostics.memberPriceSources,
          originalPriceSources: product.diagnostics.originalPriceSources,
        })}`
      );

      if (product.price === null) {
        logger.warn(`Repco price could not be extracted for ${url}`);
      }

      if (!product.name) {
        logger.warn(`Repco product name could not be extracted for ${url}`);
      }

      if (!product.sku) {
        logger.warn(`Repco SKU could not be extracted for ${url}`);
      }

      if (
        product.store &&
        product.store.toLowerCase() !== this.storeName.toLowerCase()
      ) {
        logger.warn(
          `Repco returned store "${product.store}" instead of "${this.storeName}"`
        );
      }

      return {
        site: 'repco',
        url: page.url(),
        name: product.name,
        sku: product.sku,
        price: product.price,
        originalPrice: product.originalPrice,
        memberPrice: product.memberPrice,
        currency: 'NZD',
        availability: product.availability,
        store: product.store || this.storeName,
        postalCode: this.postalCode,
        scrapedAt: new Date().toISOString(),
      };
    } catch (error) {
      logger.error(`Repco scraping failed for ${url}:`, error);

      throw error;
    } finally {
      if (page) {
        await browserService.closePage(page);
      }
    }
  }
}

export const repcoAdapter = new RepcoAdapter();
