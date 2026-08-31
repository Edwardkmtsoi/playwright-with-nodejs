import { z } from 'zod';
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  CORS_ORIGIN: z.string().default('*'),
  SCRAPER_BASE_URL: z.string().url().default('https://webscraper.io/test-sites'),
  SCRAPER_ECOMMERCE_URL: z.string().url().default('https://webscraper.io/test-sites/e-commerce/allinone'),
  PLAYWRIGHT_TIMEOUT_MS: z.coerce.number().default(30000),
  SCRAPER_MAX_LIMIT: z.coerce.number().default(50),
  PLAYWRIGHT_HEADLESS: z
    .string()
    .transform((v) => v === 'true' || v === '1')
    .default('true'),
  PLAYWRIGHT_CHANNEL: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v : undefined)),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  RATE_LIMIT_MAX: z.coerce.number().default(60),
});
export type Env = z.infer<typeof envSchema>;
let env: Env;
try {
  env = envSchema.parse(process.env);
} catch (error) {
  if (error instanceof z.ZodError) {
    console.error('Environment validation failed:', error.errors);
    process.exit(1);
  }
  throw error;
}
export default env;
