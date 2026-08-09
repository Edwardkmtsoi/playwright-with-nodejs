import { Router } from 'express';
import { postRepcoProduct } from '../controllers/repco.controller';

const router = Router();

/**
 * @swagger
 * /api/scrape/repco/product:
 *   post:
 *     summary: Scrape a Repco product
 *     description: Scrape product information from a Repco New Zealand product page using Playwright.
 *     tags:
 *       - Repco
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
 *                 example: https://www.repco.co.nz/oils-fluids/engine-oils-fluids/engine-oil/valvoline-synpower-0w-20-engine-oil-6l-1333-06/p/A6231723
 *     responses:
 *       200:
 *         description: Successfully scraped Repco product
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     site:
 *                       type: string
 *                       example: repco
 *                     url:
 *                       type: string
 *                     name:
 *                       type: string
 *                     sku:
 *                       type: string
 *                     price:
 *                       type: number
 *                     originalPrice:
 *                       type: number
 *                       nullable: true
 *                     memberPrice:
 *                       type: number
 *                       nullable: true
 *                     currency:
 *                       type: string
 *                       example: NZD
 *                     availability:
 *                       type: string
 *                       nullable: true
 *                     scrapedAt:
 *                       type: string
 *       400:
 *         description: Invalid request
 *       500:
 *         description: Scraping error
 */
router.post('/product', postRepcoProduct);

export default router;
