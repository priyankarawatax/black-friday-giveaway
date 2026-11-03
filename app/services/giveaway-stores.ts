const COMBINED_GIVEAWAY_SHOPS = [
  "benoit-vintage.myshopify.com",
  "unitedvintageuk.myshopify.com",
] as const;

export function giveawayShopPool(shop: string) {
  const normalizedShop = shop.trim().toLowerCase();
  return COMBINED_GIVEAWAY_SHOPS.includes(
    normalizedShop as (typeof COMBINED_GIVEAWAY_SHOPS)[number],
  )
    ? [...COMBINED_GIVEAWAY_SHOPS]
    : [normalizedShop];
}
