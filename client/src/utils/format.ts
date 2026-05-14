export function formatNumber(value: number, decimals = 2): string {
  if (Math.abs(value) >= 1e12) return (value / 1e12).toFixed(decimals) + 'T';
  if (Math.abs(value) >= 1e9) return (value / 1e9).toFixed(decimals) + 'B';
  if (Math.abs(value) >= 1e6) return (value / 1e6).toFixed(decimals) + 'M';
  if (Math.abs(value) >= 1e3) return (value / 1e3).toFixed(decimals) + 'K';
  return value.toFixed(decimals);
}

export function formatCurrency(value: number, currency = 'USD'): string {
  if (currency === 'USD') return '$' + formatNumber(value);
  if (currency === 'KRW') return formatNumber(value) + '원';
  return formatNumber(value) + ' ' + currency;
}

export function formatPercent(value: number | null): string {
  if (value === null || value === undefined) return 'N/A';
  const sign = value >= 0 ? '+' : '';
  return sign + value.toFixed(2) + '%';
}

export function formatPrice(value: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
