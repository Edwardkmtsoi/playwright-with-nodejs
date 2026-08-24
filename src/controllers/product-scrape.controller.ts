import { Request, Response } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { BadRequestError } from '../utils/http-error';
import {
  getProductScraperAdapter,
  getSupportedScrapeSites,
} from '../services/adapters/scraper-adapter.factory';
import logger from '../config/logger';

export const postProductScrape = asyncHandler(
  async (req: Request, res: Response) => {
    const { site, url } = req.body;

    logger.info(
      `POST /api/scrape/product received: site="${site}", url="${url}"`
    );

    if (!site) {
      throw new BadRequestError('Site is required');
    }

    if (!url) {
      throw new BadRequestError('URL is required');
    }

    logger.info(
      `Getting scraper adapter for site="${site}"`
    );

    const adapter =
      getProductScraperAdapter(site);

    logger.info(
      `Selected adapter: site="${adapter.site}"`
    );

    logger.info(
      `Checking whether adapter can handle URL`
    );

    const canHandle =
      adapter.canHandle(url);

    logger.info(
      `Adapter canHandle result: ${canHandle}`
    );

    if (!canHandle) {
      throw new BadRequestError(
        `URL does not match the selected site: ${site}`
      );
    }

    const startTime =
      Date.now();

    logger.info(
      `Starting ${adapter.site} scrape`
    );

    const product =
      await adapter.scrapeProduct(url);

    logger.info(
      `Scrape completed successfully in ${
        Date.now() - startTime
      }ms`
    );

    return res.json({
      success: true,
      data: product,
      meta: {
        durationMs:
          Date.now() - startTime,
        site: product.site,
        targetUrl: product.url,
      },
    });
  }
);

export const getProductScrapeSites =
  asyncHandler(
    async (
      _req: Request,
      res: Response
    ) => {
      return res.json({
        success: true,
        data:
          getSupportedScrapeSites(),
      });
    }
  );
