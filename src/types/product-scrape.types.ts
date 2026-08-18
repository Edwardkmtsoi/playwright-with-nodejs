export type SupportedScrapeSite =
  | 'repco'
  | 'chemistwarehouse';

export type ProductAvailability =
  | 'in_stock'
  | 'out_of_stock'
  | 'check_availability'
  | 'unknown'
  | null;

export interface BaseScrapedProduct {
  site: SupportedScrapeSite;
  url: string;
  name: string | null;
  sku: string | null;
  price: number | null;
  originalPrice: number | null;
  currency: 'NZD';
  availability: ProductAvailability;
  scrapedAt: string;
}

export interface RepcoScrapedProduct extends BaseScrapedProduct {
  site: 'repco';
  memberPrice: number | null;
  store: string;
  postalCode: string;
}

export interface ChemistWarehouseScrapedProduct
  extends BaseScrapedProduct {
  site: 'chemistwarehouse';
  discount: number | null;
}

export type ScrapedProduct =
  | RepcoScrapedProduct
  | ChemistWarehouseScrapedProduct;
