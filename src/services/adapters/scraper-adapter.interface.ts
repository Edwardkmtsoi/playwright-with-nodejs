import {
  ScrapedProduct,
  SupportedScrapeSite,
} from '../../types/product-scrape.types';

export interface ProductScraperAdapter {
  readonly site: SupportedScrapeSite;

  canHandle(url: string): boolean;

  scrapeProduct(url: string): Promise<ScrapedProduct>;
}
