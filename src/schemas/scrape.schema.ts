import { z } from 'zod';

export const scrapeRunRequestSchema = z.object({
  target: z.enum(['test-sites', 'ecommerce']),
  limit: z.number().int().min(1).max(50).optional().default(10),
  headless: z.boolean().optional().default(true),
});

export const scrapeEcommerceQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional().default(10),
  headless: z.enum(['true', 'false']).optional().transform((v) => v === 'true').default('true'),
});

/**
 * Request schema for scraping an arbitrary URL.
 *
 * Example:
 * {
 *   "url": "https://example.com",
 *   "selectors": {
 *     "title": "h1",
 *     "price": ".price"
 *   },
 *   "timeout": 60000
 * }
 */
export const scrapeCustomRequestSchema = z.object({
  url: z.string().url('A valid URL is required'),

  selectors: z
    .record(z.string().min(1))
    .optional()
    .default({}),

  timeout: z
    .number()
    .int()
    .min(1000)
    .max(120000)
    .optional()
    .default(60000),
});

export type ScrapeRunRequest = z.infer<typeof scrapeRunRequestSchema>;
export type ScrapeEcommerceQuery = z.infer<typeof scrapeEcommerceQuerySchema>;
export type ScrapeCustomRequest = z.infer<typeof scrapeCustomRequestSchema>;
