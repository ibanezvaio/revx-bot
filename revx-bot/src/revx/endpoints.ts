export const endpointCandidates = {
  tickers: [
    "/api/1.0/tickers",
    "/api/v2/tickers/",
    "/api/v2/tickers",
    "/api/1.0/market-data/ticker",
    "/api/1.0/marketdata/ticker",
    "/api/1.0/ticker"
  ],
  orderBook: [
    "/api/1.0/market-data/orderbook/{symbol}",
    "/api/1.0/marketdata/orderbook/{symbol}"
  ],
  balances: ["/api/1.0/balances", "/api/1.0/balance", "/api/v2/accounts/", "/api/v2/accounts"],
  activeOrders: [
    "/api/1.0/orders/active",
    "/api/1.0/crypto-exchange/orders/active",
    "/api/v2/orders/",
    "/api/v2/orders"
  ],
  placeOrder: ["/api/1.0/orders", "/api/1.0/crypto-exchange/orders", "/api/v2/orders/", "/api/v2/orders"],
  orderById: ["/api/1.0/orders/{id}", "/api/1.0/crypto-exchange/orders/{id}", "/api/v2/orders/{id}/", "/api/v2/orders/{id}"],
  orderFills: [
    "/api/1.0/orders/{id}/fills",
    "/api/1.0/crypto-exchange/orders/{id}/fills",
    "/api/v2/orders/{id}/trades/",
    "/api/v2/orders/{id}/trades"
  ],
  privateTrades: ["/api/1.0/private-trades", "/api/1.0/trades/private", "/api/v2/trades/", "/api/v2/trades"]
};

export function withSymbol(pathTemplate: string, symbol: string): string {
  return pathTemplate.replace("{symbol}", encodeURIComponent(symbol));
}

export function withId(pathTemplate: string, id: string): string {
  return pathTemplate.replace("{id}", encodeURIComponent(id));
}
