import { Router } from 'express';
import {
  getProductScrapeSites,
  postProductScrape,
} from '../controllers/product-scrape.controller';

const router = Router();

/**
 * @swagger
 * /api/scrape/product:
 *   post:
 *     summary: Scrape a product from a supported retailer
 *     description: Scrape product information from Repco or Chemist Warehouse using Playwright.
 *     tags:
 *       - Product Scraper
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - site
 *               - url
 *             properties:
 *               site:
 *                 type: string
 *                 enum:
 *                   - repco
 *                   - chemistwarehouse 
 *                   - supercheapauto 
 *                   - woolworths 
 *                 example: chemistwarehouse
 *               url:
 *                 type: string
 *                 format: uri
 *                 example: https://www.chemistwarehouse.co.nz/buy/107974/balance-100-whey-vanilla-2kg
 *     responses:
 *       200:
 *         description: Product scraped successfully
 *       400:
 *         description: Invalid request
 *       500:
 *         description: Scraping error
 */
router.post('/product', postProductScrape);

/**
 * @swagger
 * /api/scrape/product/sites:
 *   get:
 *     summary: List supported product scrape sites
 *     tags:
 *       - Product Scraper
 *     responses:
 *       200:
 *         description: Supported sites returned successfully
 */
router.get('/product/sites', getProductScrapeSites);

export default router;
