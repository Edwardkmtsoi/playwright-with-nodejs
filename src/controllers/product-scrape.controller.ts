import { Request, Response } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { BadRequestError } from '../utils/http-error';
import {
  getProductScraperAdapter,
  getSupportedScrapeSites,
} from '../services/adapters/scraper-adapter.factory';

export const postProductScrape = asyncHandler(
  async (req: Request, res: Response) => {
    const { site, url } = req.body;

    if (!site) {
      throw new BadRequestError('Site is required');
    }

    if (!url) {
      throw new BadRequestError('URL is required');
    }

    const adapter = getProductScraperAdapter(site);

    if (!adapter.canHandle(url)) {
      throw new BadRequestError(
        `URL does not match the selected site: ${site}`
      );
    }

    const startTime = Date.now();

    const product = await adapter.scrapeProduct(url);

    return res.json({
      success: true,
      data: product,
      meta: {
        durationMs: Date.now() - startTime,
        site: product.site,
        targetUrl: product.url,
      },
    });
  }
);

export const getProductScrapeSites = asyncHandler(
  async (_req: Request, res: Response) => {
    return res.json({
      success: true,
      data: getSupportedScrapeSites(),
    });
  }
);
