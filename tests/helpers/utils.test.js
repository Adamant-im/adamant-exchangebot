const utils = require('../../helpers/utils');
const { SAT, ADM_EPOCH } = require('../../helpers/const');

describe('utils.toTimestamp', () => {
  test('converts the ADAMANT epoch start to its Unix milliseconds', () => {
    expect(utils.toTimestamp(0)).toBe(ADM_EPOCH);
  });

  test('converts seconds since the epoch to milliseconds', () => {
    expect(utils.toTimestamp(100)).toBe(ADM_EPOCH + 100000);
  });
});

describe('utils.satsToADM', () => {
  test('converts sats to ADM', () => {
    expect(utils.satsToADM(SAT)).toBe(1);
    expect(utils.satsToADM(SAT / 2)).toBe(0.5);
    expect(utils.satsToADM(1)).toBe(0.00000001);
  });

  test('accepts a numeric string', () => {
    expect(utils.satsToADM('250000000')).toBe(2.5);
  });

  test('rounds to the requested number of decimals', () => {
    expect(utils.satsToADM(123456789, 2)).toBe(1.23);
  });

  test('returns zero for zero rather than treating it as missing', () => {
    expect(utils.satsToADM(0)).toBe(0);
  });

  test('returns undefined for a non-numeric input', () => {
    expect(utils.satsToADM('not a number')).toBeUndefined();
    expect(utils.satsToADM(undefined)).toBeUndefined();
    expect(utils.satsToADM(null)).toBeUndefined();
  });
});

describe('utils.admToSats', () => {
  test('converts ADM to sats', () => {
    expect(utils.admToSats(1)).toBe(SAT);
    expect(utils.admToSats(0.00000001)).toBe(1);
  });

  test('round-trips with satsToADM', () => {
    expect(utils.satsToADM(utils.admToSats(12.3456789))).toBe(12.3456789);
  });

  test('returns an integer even for values with floating point error', () => {
    expect(Number.isInteger(utils.admToSats(0.1))).toBe(true);
    expect(utils.admToSats(0.1)).toBe(10000000);
  });

  test('returns undefined for a non-numeric input', () => {
    expect(utils.admToSats('nope')).toBeUndefined();
  });
});

describe('utils.getRandomIntInclusive', () => {
  test('stays within the requested range, both ends inclusive', () => {
    const seen = new Set();

    for (let i = 0; i < 500; i += 1) {
      const value = utils.getRandomIntInclusive(1, 3);

      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(3);
      seen.add(value);
    }

    expect(seen).toEqual(new Set([1, 2, 3]));
  });

  test('returns the bound when both ends are equal', () => {
    expect(utils.getRandomIntInclusive(7, 7)).toBe(7);
  });
});

describe('utils number predicates', () => {
  test.each([
    [0, true],
    [1.5, true],
    [-2, true],
    [NaN, false],
    [Infinity, false],
    ['1', false],
    [null, false],
    [undefined, false],
  ])('isNumber(%p) is %p', (value, expected) => {
    expect(utils.isNumber(value)).toBe(expected);
  });

  test.each([
    [0, true],
    [1.5, true],
    [-0.1, false],
    [NaN, false],
    ['0', false],
  ])('isPositiveOrZeroNumber(%p) is %p', (value, expected) => {
    expect(utils.isPositiveOrZeroNumber(value)).toBe(expected);
  });

  test.each([
    [0, false],
    [0.00000001, true],
    [-1, false],
    [NaN, false],
  ])('isPositiveNumber(%p) is %p', (value, expected) => {
    expect(utils.isPositiveNumber(value)).toBe(expected);
  });
});

describe('utils.tryParseJSON', () => {
  test('parses a JSON object', () => {
    expect(utils.tryParseJSON('{"a":1}')).toEqual({ a: 1 });
  });

  test('parses a rich transfer message', () => {
    const message = '{"type":"eth_transaction","amount":"0.1","hash":"0xabc","comments":"ADM"}';

    expect(utils.tryParseJSON(message)).toEqual({
      type: 'eth_transaction',
      amount: '0.1',
      hash: '0xabc',
      comments: 'ADM',
    });
  });

  test('returns false for anything that is not a JSON object', () => {
    expect(utils.tryParseJSON('not json')).toBe(false);
    expect(utils.tryParseJSON('42')).toBe(false);
    expect(utils.tryParseJSON('null')).toBe(false);
    expect(utils.tryParseJSON('')).toBe(false);
  });
});

describe('utils.formatDate', () => {
  test('returns every format used by logs and chat messages', () => {
    // Built from local parts so the assertion does not depend on the test machine's zone.
    const date = new Date(2026, 8, 12, 4, 5, 6);
    const formatted = utils.formatDate(date.getTime());

    expect(formatted.YYYY_MM_DD).toBe('2026-09-12');
    expect(formatted.hh_mm_ss).toBe('04:05:06');
    expect(formatted.YYYY_MM_DD_hh_mm).toBe('2026-09-12 04:05');
  });

  test('returns false for a falsy timestamp', () => {
    expect(utils.formatDate(0)).toBe(false);
    expect(utils.formatDate(undefined)).toBe(false);
  });
});

describe('utils.formatNumber', () => {
  test('groups the integer part in threes', () => {
    expect(utils.formatNumber(1234567)).toBe('1 234 567');
    expect(utils.formatNumber(100)).toBe('100');
    expect(utils.formatNumber(1000)).toBe('1 000');
  });

  test('keeps the fraction part unchanged', () => {
    expect(utils.formatNumber(1234.5678)).toBe('1 234.5678');
  });

  test('bolds the integer part on request', () => {
    expect(utils.formatNumber(1234.5, true)).toBe('**1 234**.5');
  });

  test('does not bold a number without a fraction part', () => {
    expect(utils.formatNumber(1234, true)).toBe('1 234');
  });
});

describe('utils.getModuleName', () => {
  test('returns the file name of a module id', () => {
    expect(utils.getModuleName('/home/bot/modules/sendBack.js')).toBe('sendBack.js');
    expect(utils.getModuleName('C:\\bot\\modules\\sendBack.js')).toBe('sendBack.js');
  });

  test('returns an empty string when there is no path', () => {
    expect(utils.getModuleName('sendBack.js')).toBe('');
    expect(utils.getModuleName('')).toBe('');
    expect(utils.getModuleName(undefined)).toBe('');
  });
});

describe('utils.isArraysEqual', () => {
  test('ignores order', () => {
    expect(utils.isArraysEqual(['BTC', 'ADM'], ['ADM', 'BTC'])).toBe(true);
  });

  test('does not modify its arguments', () => {
    const first = ['BTC', 'ADM'];
    const second = ['ADM', 'BTC'];

    utils.isArraysEqual(first, second);

    expect(first).toEqual(['BTC', 'ADM']);
    expect(second).toEqual(['ADM', 'BTC']);
  });

  test('rejects arrays of different contents or length', () => {
    expect(utils.isArraysEqual(['BTC'], ['ADM'])).toBe(false);
    expect(utils.isArraysEqual(['BTC'], ['BTC', 'ADM'])).toBe(false);
  });

  test('rejects non-arrays', () => {
    expect(utils.isArraysEqual('BTC', ['BTC'])).toBe(false);
  });
});

describe('utils.getUnique', () => {
  test('removes duplicates and preserves order and types', () => {
    expect(utils.getUnique(['a', 'b', 'a'])).toEqual(['a', 'b']);
    expect(utils.getUnique([2, 1, 2])).toEqual([2, 1]);
  });
});

describe('utils string comparison', () => {
  test('isStringEqual is case sensitive', () => {
    expect(utils.isStringEqual('ADM', 'ADM')).toBe(true);
    expect(utils.isStringEqual('ADM', 'adm')).toBe(false);
  });

  test('isStringEqualCI is case insensitive', () => {
    expect(utils.isStringEqualCI('0xAbC', '0xabc')).toBe(true);
  });

  test('both reject non-strings, so an undefined address never matches', () => {
    expect(utils.isStringEqual(undefined, undefined)).toBe(false);
    expect(utils.isStringEqualCI(undefined, undefined)).toBe(false);
    expect(utils.isStringEqualCI(null, 'null')).toBe(false);
  });
});

describe('utils.trimAny', () => {
  test('trims the given characters from both ends', () => {
    expect(utils.trimAny('  "ADM".  ', ` '",.`)).toBe('ADM');
  });

  test('leaves the inside of the string alone', () => {
    expect(utils.trimAny('a.b', '.')).toBe('a.b');
  });

  test('returns an empty string for a non-string input', () => {
    expect(utils.trimAny(undefined, '.')).toBe('');
    expect(utils.trimAny(123, '.')).toBe('');
  });
});

describe('utils.replaceLastOccurrence', () => {
  test('replaces only the last occurrence', () => {
    expect(utils.replaceLastOccurrence('BTC, ETH, ADM', ', ', ' or ')).toBe('BTC, ETH or ADM');
  });

  test('returns the string unchanged when there is no match', () => {
    expect(utils.replaceLastOccurrence('BTC', ', ', ' or ')).toBe('BTC');
  });

  test('returns an empty string for a non-string input', () => {
    expect(utils.replaceLastOccurrence(undefined, ', ', ' or ')).toBe('');
  });
});
