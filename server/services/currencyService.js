const CURRENCY_API_URL =
  "https://api.currencyapi.com/v3/latest";

export async function getExchangeRate(
  fromCurrency,
  toCurrency = "USD"
) {
  const from = String(fromCurrency).toUpperCase();
  const to = String(toCurrency).toUpperCase();

  if (from === to) {
    return {
      rate: 1,
      fromCurrency: from,
      toCurrency: to,
      rateTimestamp: new Date().toISOString(),
    };
  }

  if (!process.env.CURRENCY_API_KEY) {
    throw new Error("CURRENCY_API_KEY is not configured");
  }

  const url = new URL(CURRENCY_API_URL);
  url.searchParams.set("base_currency", from);
  url.searchParams.set("currencies", to);

  const response = await fetch(url, {
    headers: {
      apikey: process.env.CURRENCY_API_KEY,
      Accept: "application/json",
    },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `CurrencyAPI request failed: ${response.status} ${JSON.stringify(data)}`
    );
  }

  const rate = Number(data?.data?.[to]?.value);

  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(
      `Invalid ${from}/${to} exchange rate returned by CurrencyAPI`
    );
  }

  return {
    rate,
    fromCurrency: from,
    toCurrency: to,
    rateTimestamp:
      data?.meta?.last_updated_at ?? new Date().toISOString(),
  };
}

export async function convertCurrency(
  amount,
  fromCurrency,
  toCurrency = "USD"
) {
  const numericAmount = Number(amount);

  if (!Number.isFinite(numericAmount) || numericAmount < 0) {
    throw new Error("Invalid currency amount");
  }

  const exchange = await getExchangeRate(
    fromCurrency,
    toCurrency
  );

  return {
    ...exchange,
    originalAmount: numericAmount,
    convertedAmount: Number(
      (numericAmount * exchange.rate).toFixed(2)
    ),
  };
}