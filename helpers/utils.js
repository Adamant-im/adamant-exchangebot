const { SAT, ADM_EPOCH } = require('./const');

/**
 * Converts a number or numeric string to a plain decimal string, expanding scientific notation.
 *
 * @param {number|string} num
 * @returns {string} Plain decimal representation without 'e' or 'E'
 */
function toPlainNumberString(num) {
  const numVal = Number(num);

  if (!Number.isFinite(numVal)) {
    return String(num);
  }

  const str = String(numVal);
  const match = str.match(/^([+-]?\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/);

  if (!match) {
    return str;
  }

  const sign = match[1].startsWith('-') ? '-' : '';
  const intPart = match[1].replace(/^[+-]/, '');
  const fracPart = match[2] || '';
  const exp = parseInt(match[3], 10);

  if (exp === 0) {
    return sign + intPart + (fracPart ? '.' + fracPart : '');
  }

  if (exp > 0) {
    if (exp >= fracPart.length) {
      return sign + intPart + fracPart + '0'.repeat(exp - fracPart.length);
    }

    return sign + intPart + fracPart.slice(0, exp) + '.' + fracPart.slice(exp);
  }

  const absExp = Math.abs(exp);
  const combined = intPart + fracPart;

  if (absExp < intPart.length) {
    const splitIdx = intPart.length - absExp;

    return sign + intPart.slice(0, splitIdx) + '.' + intPart.slice(splitIdx) + fracPart;
  }

  return sign + '0.' + '0'.repeat(absExp - intPart.length) + combined;
}

module.exports = {
  /**
   * Converts an ADAMANT epoch timestamp to a Unix timestamp in milliseconds.
   *
   * @param {number} epochTime ADAMANT epoch timestamp, in seconds
   * @returns {number} Unix timestamp, in milliseconds
   */
  toTimestamp(epochTime) {
    return epochTime * 1000 + ADM_EPOCH;
  },

  /**
   * Converts ADM sats to ADM.
   *
   * @param {number|string} sats Amount in sats
   * @param {number} [decimals=8] Number of decimals to round to
   * @returns {number|undefined} Amount in ADM, or `undefined` when the input is not a number
   */
  satsToADM(sats, decimals = 8) {
    // `Number(null)` and `Number('')` are 0, which would turn a missing balance into
    // a real one. Reject those before converting.
    if (sats === null || sats === undefined || sats === '') {
      return undefined;
    }

    const amount = Number(sats);

    if (!Number.isFinite(amount)) {
      return undefined;
    }

    return Number((amount / SAT).toFixed(decimals));
  },

  /**
   * Converts ADM to ADM sats.
   *
   * @param {number|string} adm Amount in ADM
   * @returns {number|undefined} Amount in sats, or `undefined` when the input is not a number
   */
  admToSats(adm) {
    if (adm === null || adm === undefined || adm === '') {
      return undefined;
    }

    const amount = Number(adm);

    if (!Number.isFinite(amount)) {
      return undefined;
    }

    return Number((amount * SAT).toFixed(0));
  },

  /**
   * Returns the current time in milliseconds since the Unix epoch.
   *
   * @returns {number}
   */
  unix() {
    return Date.now();
  },

  /**
   * Returns a random integer in the `[min, max]` range, both ends inclusive.
   *
   * @param {number} min Lower bound, inclusive
   * @param {number} max Upper bound, inclusive
   * @returns {number}
   */
  getRandomIntInclusive(min, max) {
    const lower = Math.ceil(min);
    const upper = Math.floor(max);

    return Math.floor(Math.random() * (upper - lower + 1) + lower);
  },

  /**
   * Checks that a value is a finite number.
   *
   * @param {*} value Value to validate
   * @returns {boolean}
   */
  isNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  },

  /**
   * Checks that a value is a finite number and not less than 0.
   *
   * @param {*} value Value to validate
   * @returns {boolean}
   */
  isPositiveOrZeroNumber(value) {
    return this.isNumber(value) && value >= 0;
  },

  /**
   * Checks that a value is a finite number greater than 0.
   *
   * @param {*} value Value to validate
   * @returns {boolean}
   */
  isPositiveNumber(value) {
    return this.isNumber(value) && value > 0;
  },

  /**
   * Parses a JSON string without throwing.
   *
   * @param {string} jsonString String to parse
   * @returns {object|false} The parsed object, or `false` when the string is not a JSON object
   */
  tryParseJSON(jsonString) {
    try {
      const parsed = JSON.parse(jsonString);

      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch {
      // Chat messages are untrusted input, so unparsable values are expected here.
    }

    return false;
  },

  /**
   * Formats a Unix timestamp into the string forms used in logs and chat messages.
   *
   * @param {number} timestamp Unix timestamp, in milliseconds
   * @returns {object|false} Formatted parts, or `false` when the timestamp is falsy
   */
  formatDate(timestamp) {
    if (!timestamp) return false;

    const date = new Date(timestamp);
    const pad = (value) => String(value).padStart(2, '0');

    const formatted = {
      year: date.getFullYear(),
      month: pad(date.getMonth() + 1),
      date: pad(date.getDate()),
      hours: pad(date.getHours()),
      minutes: pad(date.getMinutes()),
      seconds: pad(date.getSeconds()),
    };

    formatted.YYYY_MM_DD = `${formatted.year}-${formatted.month}-${formatted.date}`;
    formatted.YYYY_MM_DD_hh_mm = `${formatted.YYYY_MM_DD} ${formatted.hours}:${formatted.minutes}`;
    formatted.hh_mm_ss = `${formatted.hours}:${formatted.minutes}:${formatted.seconds}`;

    return formatted;
  },

  /**
   * Formats a number with thin groups of three digits, as in `3 134 234.778`.
   * Expands scientific exponential notation (e.g. `1e25`) into full decimal representation.
   *
   * @param {number|string} num Number to format
   * @param {boolean} [doBold] Wrap the integer part in Markdown bold
   * @returns {string}
   */
  formatNumber(num, doBold) {
    const plain = toPlainNumberString(num);
    const isNegative = plain.startsWith('-');
    const unsigned = isNegative ? plain.slice(1) : plain;
    const [integerPart, fractionPart] = unsigned.split('.');

    let output = '';
    let position = integerPart.length - 1;

    while (position >= 0) {
      output = integerPart.charAt(position) + output;

      if ((integerPart.length - position) % 3 === 0 && position > 0) {
        output = ' ' + output;
      }

      position -= 1;
    }

    const sign = isNegative ? '-' : '';

    if (fractionPart === undefined) {
      return sign + output;
    }

    return doBold ? `${sign}**${output}**.${fractionPart}` : `${sign}${output}.${fractionPart}`;
  },

  /**
   * Returns a module's file name, used to make log messages traceable.
   *
   * @param {string} id Module identifier, that is `module.id`
   * @returns {string} File name, or an empty string when `id` has no path separator
   */
  getModuleName(id) {
    if (!id) {
      return '';
    }

    const separator = Math.max(id.lastIndexOf('/'), id.lastIndexOf('\\'));

    return separator === -1 ? '' : id.substring(separator + 1);
  },

  /**
   * Compares two arrays by their contents, ignoring order. Does not modify the inputs.
   *
   * @param {Array} array1
   * @param {Array} array2
   * @returns {boolean} `true` when both arrays hold the same values
   */
  isArraysEqual(array1, array2) {
    if (!Array.isArray(array1) || !Array.isArray(array2) || array1.length !== array2.length) {
      return false;
    }

    const sorted1 = [...array1].sort();
    const sorted2 = [...array2].sort();

    return sorted1.every((value, index) => value === sorted2[index]);
  },

  /**
   * Returns the unique values of an array, preserving order and value types.
   *
   * @param {Array} values Input array
   * @returns {Array}
   */
  getUnique(values) {
    return [...new Set(values)];
  },

  /**
   * Compares two strings, case sensitive. Non-string arguments never match.
   *
   * @param {*} string1
   * @param {*} string2
   * @returns {boolean}
   */
  isStringEqual(string1, string2) {
    if (typeof string1 !== 'string' || typeof string2 !== 'string') return false;

    return string1 === string2;
  },

  /**
   * Compares two strings, case insensitive. Non-string arguments never match.
   *
   * @param {*} string1
   * @param {*} string2
   * @returns {boolean}
   */
  isStringEqualCI(string1, string2) {
    if (typeof string1 !== 'string' || typeof string2 !== 'string') return false;

    return string1.toUpperCase() === string2.toUpperCase();
  },

  /**
   * Trims any of the given characters from both ends of a string, case sensitive.
   *
   * For example, `trimAny(str, ' "\'')` trims spaces, quotes and apostrophes.
   *
   * @param {string} str String to trim
   * @param {string} chars Characters to trim
   * @returns {string} The trimmed string, or an empty string when `str` is not a string
   */
  trimAny(str, chars) {
    if (!str || typeof str !== 'string') {
      return '';
    }

    let start = 0;
    let end = str.length;

    while (start < end && chars.indexOf(str[start]) >= 0) {
      start += 1;
    }

    while (end > start && chars.indexOf(str[end - 1]) >= 0) {
      end -= 1;
    }

    return start > 0 || end < str.length ? str.substring(start, end) : str;
  },

  /**
   * Replaces the last occurrence of a substring, case sensitive.
   *
   * @param {string} str String to process
   * @param {string} searchValue Substring to search for
   * @param {string} newValue Replacement
   * @returns {string} The processed string, or an empty string when `str` is not a string
   */
  replaceLastOccurrence(str, searchValue, newValue) {
    if (!str || typeof str !== 'string') {
      return '';
    }

    const position = str.lastIndexOf(searchValue);

    if (position === -1) {
      return str;
    }

    return str.slice(0, position) + str.slice(position).replace(searchValue, newValue);
  },

  /**
   * Checks whether a payment is currently awaiting user clarification.
   *
   * Persisted records in MongoDB store cleared fields as `null`, while in-memory
   * documents use `undefined`. Both represent "no clarification pending".
   *
   * @param {object|null|undefined} payment Stored payment document
   * @returns {boolean}
   */
  isAwaitingClarification(payment) {
    return Boolean(payment && payment.inUpdateState !== undefined && payment.inUpdateState !== null);
  },
};
