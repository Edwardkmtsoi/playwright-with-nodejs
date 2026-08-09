import {
  Router,
} from 'express';

import {
  getScrapeTestSites,
  getScrapeEcommerceProducts,
  postScrapeRun,
  postScrapeCustom,
} from '../controllers/scrape.controller';

const router = Router();

/**
 * @swagger
 * /api/scrape/sites:
 *   get:
 *     summary: Scrape webscraper.io test sites
 *     tags:
 *       - Scraper
 *     responses:
 *       200:
 *         description: Successfully scraped test sites
 */
router.get('/sites', getScrapeTestSites);

/**
 * @swagger
 * /api/scrape/ecommerce/products:
 *   get:
 *     summary: Scrape e-commerce products
 *     tags:
 *       - Scraper
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *           minimum: 1
 *           maximum: 50
 *         description: Maximum number of products to scrape
 *       - in: query
 *         name: headless
 *         schema:
 *           type: string
 *           enum: ['true', 'false']
 *           default: 'true'
 *         description: Run browser in headless mode
 *     responses:
 *       200:
 *         description: Successfully scraped products
 */
router.get('/ecommerce/products', getScrapeEcommerceProducts);

/**
 * @swagger
 * /api/scrape/run:
 *   post:
 *     summary: Run a scraping task
 *     tags:
 *       - Scraper
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - target
 *             properties:
 *               target:
 *                 type: string
 *                 enum: ['test-sites', 'ecommerce']
 *               limit:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 50
 *                 default: 10
 *               headless:
 *                 type: boolean
 *                 default: true
 *     responses:
 *       200:
 *         description: Scraping task completed
 */
router.post('/run', postScrapeRun);

/**
 * @swagger
 * /api/scrape/custom:
 *   post:
 *     summary: Scrape a custom URL using Playwright
 *     description: |
 *       Opens a public URL with Playwright and extracts the page title,
 *       visible text, and optional CSS selector fields.
 *     tags:
 *       - Scraper
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - url
 *             properties:
 *               url:
 *                 type: string
 *                 format: uri
 *                 example: https://example.com
 *               selectors:
 *                 type: object
 *                 additionalProperties:
 *                   type: string
 *                 example:
 *                   title: h1
 *                   price: .price
 *               timeout:
 *                 type: integer
 *                 minimum: 1000
 *                 maximum: 120000
 *                 default: 60000
 *     responses:
 *       200:
 *         description: Successfully scraped the URL
 *       400:
 *         description: Invalid request
 *       500:
 *         description: Scraping error
 */
router.post('/custom', postScrapeCustom);

export default router;
