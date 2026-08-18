import { BadRequestError } from '../../utils/http-error';
import { SupportedScrapeSite } from '../../types/product-scrape.types';
import { ProductScraperAdapter } from './scraper-adapter.interface';
import { repcoAdapter } from './repco.adapter';
import { chemistWarehouseAdapter } from './chemistwarehouse.adapter';

const adapters: Record<
  SupportedScrapeSite,
  ProductScraperAdapter
> = {
  repco: repcoAdapter,
  chemistwarehouse: chemistWarehouseAdapter,
};

export function getProductScraperAdapter(
  site: string
): ProductScraperAdapter {
  const normalizedSite = site
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '') as SupportedScrapeSite;

  const adapter = adapters[normalizedSite];

  if (!adapter) {
    throw new BadRequestError(
      `Unsupported scrape site: ${site}`
    );
  }

  return adapter;
}

export function getSupportedScrapeSites(): SupportedScrapeSite[] {
  return Object.keys(adapters) as SupportedScrapeSite[];
}
