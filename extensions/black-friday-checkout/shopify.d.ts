import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/Checkout.jsx' {
  const shopify: import('@shopify/ui-extensions/purchase.checkout.block.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/ThankYou.jsx' {
  const shopify: import('@shopify/ui-extensions/purchase.thank-you.block.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/campaign.js' {
  const shopify:
    | import('@shopify/ui-extensions/purchase.checkout.block.render').Api
    | import('@shopify/ui-extensions/purchase.thank-you.block.render').Api;
  const globalThis: { shopify: typeof shopify };
}
