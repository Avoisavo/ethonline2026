// price-checker — returns the USD price of a token from CoinGecko.
export async function getPrice(symbol) {
  const r = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${symbol}&vs_currencies=usd`
  );
  const data = await r.json();
  return data[symbol]?.usd ?? null;
}
