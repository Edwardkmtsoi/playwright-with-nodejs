import { Request, Response } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { BadRequestError } from '../utils/http-error';
import { getProductScraperAdapter } from '../services/adapters/scraper-adapter.factory';

export const postRepcoProduct = asyncHandler(
  async (req: Request, res: Response) => {
    const { url } = req.body;

    if (!url) {
      throw new BadRequestError('URL is required');
    }

    const adapter = getProductScraperAdapter('repco');

    if (!adapter.canHandle(url)) {
      throw new BadRequestError(
        'URL must be a Repco New Zealand product URL'
      );
    }

    const startTime = Date.now();

    const product = await adapter.scrapeProduct(url);

    return res.json({
      success: true,
      data: product,
      meta: {
        durationMs: Date.now() - startTime,
        targetUrl: product.url,
      },
    });
  }
);
