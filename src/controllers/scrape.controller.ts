import { Request, Response } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { buildResponse } from '../utils/response';
import { scraperService } from '../services/scraper.service';
import { BadRequestError } from '../utils/http-error';
import {
  scrapeRunRequestSchema,
  scrapeEcommerceQuerySchema,
  scrapeCustomRequestSchema,
} from '../schemas/scrape.schema';
import env from '../config/env';

export const getScrapeTestSites = asyncHandler(
  async (_req: Request, res: Response) => {
    const startTime = Date.now();

    const sites = await scraperService.scrapeTestSites();

    return buildResponse.success(res, sites, 200, {
      count: sites.length,
      durationMs: Date.now() - startTime,
      targetUrl: env.SCRAPER_BASE_URL,
    });
  },
);

export const getScrapeEcommerceProducts = asyncHandler(
  async (req: Request, res: Response) => {
    const parsed = scrapeEcommerceQuerySchema.safeParse(req.query);

    if (!parsed.success) {
      throw new BadRequestError(JSON.stringify(parsed.error.errors));
    }

    const { limit } = parsed.data;
    const startTime = Date.now();

    const products = await scraperService.scrapeEcommerceProducts(limit);

    return buildResponse.success(res, products, 200, {
      count: products.length,
      durationMs: Date.now() - startTime,
      targetUrl: env.SCRAPER_ECOMMERCE_URL,
    });
  },
);

export const postScrapeRun = asyncHandler(
  async (req: Request, res: Response) => {
    const parsed = scrapeRunRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      throw new BadRequestError(JSON.stringify(parsed.error.errors));
    }

    const { target, limit } = parsed.data;

    const result = await scraperService.runScrape(target, limit);

    if (!result.success) {
      return buildResponse.error(
        res,
        result.error || 'Scraping failed',
        500,
        {
          durationMs: result.meta.durationMs,
          targetUrl: result.meta.targetUrl,
        },
      );
    }

    return buildResponse.success(res, result.data, 200, {
      count: Array.isArray(result.data) ? result.data.length : 0,
      durationMs: result.meta.durationMs,
      targetUrl: result.meta.targetUrl,
    });
  },
);

/**
 * Scrape a custom URL using Playwright.
 *
 * Accepts an arbitrary public URL and optional CSS selectors.
 *
 * Example request:
 *
 * {
 *   "url": "https://example.com",
 *   "selectors": {
 *     "title": "h1",
 *     "price": ".price"
 *   },
 *   "timeout": 60000
 * }
 */
export const postScrapeCustom = asyncHandler(
  async (req: Request, res: Response) => {
    const parsed = scrapeCustomRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      throw new BadRequestError(JSON.stringify(parsed.error.errors));
    }

    const { url, selectors, timeout } = parsed.data;

    const startTime = Date.now();

    const result = await scraperService.scrapeCustom({
      url,
      selectors,
      timeout,
    });

    return buildResponse.success(res, result, 200, {
      durationMs: Date.now() - startTime,
      targetUrl: result.url,
    });
  },
);
