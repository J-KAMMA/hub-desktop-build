export const HUB_SEARCH_LANGUAGES = Object.freeze(['ja', 'en', 'ko', 'zh-CN', 'es', 'fr', 'de', 'pt', 'ar', 'hi', 'other']);
export const HUB_SEARCH_TYPES = Object.freeze(['boards', 'profiles', 'threads', 'posts', 'images', 'hubpedia', 'communities', 'videos', 'lists', 'tokens', 'work', 'listings']);
const keys = ['from', 'to', 'maxPrice', 'currency', 'language', 'region', 'category', 'type'];
const fail = reason => { throw new TypeError(`検索条件が正しくありません (${reason})。`); };
export function normalizeHubSearchFilters(input = {}) {
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail('型');
  if (Reflect.ownKeys(input).some(key => !keys.includes(key))) fail('キー');
  const values = Object.fromEntries(keys.map(key => {
    const raw = input[key];
    if (raw !== undefined && typeof raw !== 'string') fail(key);
    return [key, key === 'region' || key === 'category' ? raw ?? '' : (raw ?? '').trim()];
  }));
  const isDate = value => {
    if (!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  if ([values.from, values.to].some(value => value && !isDate(value))) fail('date');
  if (values.from && values.to && values.from > values.to) fail('date_order');
  const currency = values.currency.toUpperCase() || 'JPY';
  if (!['JPY', 'USD', 'EUR'].includes(currency)) fail('currency');
  let maxPrice = '';
  if (values.maxPrice) {
    if (values.maxPrice.length > 32 || !/^\d+(?:\.\d+)?$/.test(values.maxPrice)) fail('price');
    const [whole, fraction = ''] = values.maxPrice.split('.'), digits = currency === 'JPY' ? 0 : 2;
    if (fraction.length > digits || BigInt(whole) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, '0') || '0') > BigInt(Number.MAX_SAFE_INTEGER)) fail('price');
    const suffix = fraction.replace(/0+$/, '');
    maxPrice = `${BigInt(whole)}${suffix ? `.${suffix}` : ''}`;
  }
  const languageInput = values.language.toLowerCase(), typeInput = values.type.toLowerCase();
  const language = languageInput === 'zh' ? 'zh-CN' : HUB_SEARCH_LANGUAGES.find(value => value.toLowerCase() === languageInput);
  const type = HUB_SEARCH_TYPES.find(value => value === typeInput);
  if (languageInput && !['any', 'all'].includes(languageInput) && !language) fail('language');
  if (typeInput && !['any', 'all'].includes(typeInput) && !type) fail('type');
  for (const key of ['region', 'category']) {
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(values[key])) fail(key);
    values[key] = values[key].normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('ja');
    if (values[key].length > 80) fail(key);
  }
  return {from: values.from, to: values.to, maxPrice, currency: maxPrice ? currency : 'JPY',
    ...(language ? {language} : {}), ...(values.region ? {region: values.region} : {}),
    ...(values.category ? {category: values.category} : {}), ...(type ? {type} : {})};
}
export function hasHubSearchFilters(filters) {
  return Boolean(filters.from || filters.to || filters.maxPrice || filters.language || filters.region || filters.category || filters.type);
}
