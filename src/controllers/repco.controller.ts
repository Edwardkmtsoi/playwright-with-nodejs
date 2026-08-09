import { Request, Response } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { BadRequestError } from '../utils/http-error';
import { repcoAdapter } from '../services/adapters/repco.adapter';

export const postRepcoProduct = asyncHandler(
  async (req: Request, res: Response) => {
    const { url } = req.body;

    if (!url) {
      throw new BadRequestError('URL is required');
    }

    if (!url.includes('repco.co.nz')) {
      throw new BadRequestError(
        'URL must be a Repco New Zealand product URL'
      );
    }

    const startTime = Date.now();

    const product = await repcoAdapter.scrapeProduct(url);

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
