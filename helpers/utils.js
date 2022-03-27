const { SAT, EPOCH } = require('./const');

module.exports = {

  /**
   * Converts provided `time` to ADAMANT's epoch timestamp
   * @param {number} time Timestamp to convert
   * @return {number}
   */
  epochTime(time) {
    if (!time) {
      time = Date.now();
    }
    return Math.floor((time - EPOCH) / 1000);
  },

  /**
   * Converts ADAMANT's epoch timestamp to a Unix timestamp
   * @param {number} epochTime Timestamp to convert
   * @return {number}
   */
  toTimestamp(epochTime) {
    return epochTime * 1000 + EPOCH;
  },

  /**
   * Converts ADAMANT's sats to ADM value
   * @param {number|string} sats Sats to convert
   * @param {number} decimals Round up to
   * @return {number} Value in ADM
   */
  satsToADM(sats, decimals = 8) {
    try {

      let adm = (+sats / SAT).toFixed(decimals);
      adm = +adm;
      return adm;

    } catch (e) { }
  },

  /**
   * Converts ADM value to sats
   * @param {number|string} adm ADM to convert
   * @return {number} Value in sats
   */
  AdmToSats(adm) {
    try {

      let sats = (+adm * SAT).toFixed(0);
      sats = +sats;
      return sats;

    } catch (e) { }
  },

  /**
   * Returns current time in milliseconds since Unix Epoch
   * @return {number}
   */
  unix() {
    return new Date().getTime();
  },

  /**
   * Returns random of (min-max)
   * @param {number} min Minimum is inclusive
   * @param {number} max Maximum is inclusive
   * @return {number} Integer random of (min-max)
   */
  getRandomIntInclusive(min, max) {
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min + 1) + min);
  },

  /**
   * Checks if string contains correct number
   * @param {string} str String value to check
   * @return {boolean}
   */
  isNumeric(str) {
    if (typeof str !== 'string') return false;
    return !isNaN(str) && !isNaN(parseFloat(str));
  },

  /**
   * Checks if number is integer
   * @param {number} value Number to validate
   * @return {boolean}
   */
  isInteger(value) {
    if (typeof (value) !== 'number' || isNaN(value) || !Number.isSafeInteger(value)) {
      return false;
    } else {
      return true;
    }
  },

  /**
   * Checks if number is integer and not less, than 0
   * @param {number} value Number to validate
   * @return {boolean}
   */
  isPositiveOrZeroInteger(value) {
    if (!this.isInteger(value) || value < 0) {
      return false;
    } else {
      return true;
    }
  },

  /**
   * Checks if number is finite
   * @param {number} value Number to validate
   * @return {boolean}
   */
  isNumber(value) {
    if (typeof (value) !== 'number' || isNaN(value) || !Number.isFinite(value)) {
      return false;
    } else {
      return true;
    }
  },

  /**
   * Checks if number is finite and not less, than 0
   * @param {number} value Number to validate
   * @return {boolean}
   */
  isPositiveOrZeroNumber(value) {
    if (!this.isNumber(value) || value < 0) {
      return false;
    } else {
      return true;
    }
  },

  /**
   * Checks if number is finite and greater, than 0
   * @param {number} value Number to validate
   * @return {boolean}
   */
  isPositiveNumber(value) {
    if (!this.isNumber(value) || value <= 0) {
      return false;
    } else {
      return true;
    }
  },

  /**
   * Parses string value to JSON
   * @param {string} jsonString String to parse
   * @return {object} JSON object or false, if unable to parse
   */
  tryParseJSON(jsonString) {
    try {
      const o = JSON.parse(jsonString);
      if (o && typeof o === 'object') {
        return o;
      }
    } catch (e) { }
    return false;
  },

  /**
   * Formats unix timestamp to string
   * @param {number} timestamp Timestamp to format
   * @return {object} Contains different formatted strings
   */
  formatDate(timestamp) {
    if (!timestamp) return false;
    const formattedDate = {};
    const dateObject = new Date(timestamp);
    formattedDate.year = dateObject.getFullYear();
    formattedDate.month = ('0' + (dateObject.getMonth() + 1)).slice(-2);
    formattedDate.date = ('0' + dateObject.getDate()).slice(-2);
    formattedDate.hours = ('0' + dateObject.getHours()).slice(-2);
    formattedDate.minutes = ('0' + dateObject.getMinutes()).slice(-2);
    formattedDate.seconds = ('0' + dateObject.getSeconds()).slice(-2);
    formattedDate.YYYY_MM_DD = formattedDate.year + '-' + formattedDate.month + '-' + formattedDate.date;
    formattedDate.YYYY_MM_DD_hh_mm = formattedDate.year + '-' + formattedDate.month + '-' + formattedDate.date + ' ' + formattedDate.hours + ':' + formattedDate.minutes;
    formattedDate.hh_mm_ss = formattedDate.hours + ':' + formattedDate.minutes + ':' + formattedDate.seconds;
    return formattedDate;
  },

  /**
   * Formats number to a pretty string
   * @param {number} num Number to format
   * @param {boolean} doBold If to add **bold** markdown for integer part
   * @return {string} Formatted number, like 3 134 234.778
   */
  formatNumber(num, doBold) {
    const parts = (+num + '').split('.');
    const main = parts[0];
    const len = main.length;
    let output = '';
    let i = len - 1;

    while (i >= 0) {
      output = main.charAt(i) + output;
      if ((len - i) % 3 === 0 && i > 0) {
        output = ' ' + output;
      }
      --i;
    }
    if (parts.length > 1) {
      if (doBold) {
        output = `**${output}**.${parts[1]}`;
      } else {
        output = `${output}.${parts[1]}`;
      }
    }
    return output;
  },

  /**
   * Returns precision for number of decimals. getPrecision(3) = 0.001
   * @param {number} decimals Number of decimals
   * @return {number} Precision
   */
  getPrecision(decimals) {
    return +(Math.pow(10, -decimals).toFixed(decimals));
  },

  /**
   * Returns module name from its ID
   * @param {string} id Module name, module.id
   * @return {string}
   */
  getModuleName(id) {
    if (!id) {
      return '';
    }
    let n = id.lastIndexOf('\\');
    if (n === -1) {
      n = id.lastIndexOf('/');
    }
    if (n === -1) {
      return '';
    } else {
      return id.substring(n + 1);
    }
  },

  /**
   * Compares two arrays
   * @param {array} array1
   * @param {array} array2
   * @return {boolean} True, if arrays are equal
   */
  isArraysEqual(array1, array2) {
    return array1.length === array2.length && array1.sort().every(function(value, index) {
      return value === array2.sort()[index];
    });
  },

  /**
   * Returns array with unique values
   * @param {array} values Input array
   * @return {array}
   */
  getUnique(values) {
    const map = values.reduce((m, v) => {
      m[v] = 1;
      return m;
    }, { });
    return Object.keys(map);
  },

  /**
   * Compares two strings, case sensitive
   * @param {string} string1
   * @param {string} string2
   * @return {boolean} True, if strings are equal
   */
  isStringEqual(string1, string2) {
    if (typeof string1 !== 'string' || typeof string2 !== 'string') return false;
    return string1 === string2;
  },

  /**
   * Compares two strings, case insensitive
   * @param {string} string1
   * @param {string} string2
   * @return {boolean} True, if strings are equal, case insensitive
   */
  isStringEqualCI(string1, string2) {
    if (typeof string1 !== 'string' || typeof string2 !== 'string') return false;
    return string1.toUpperCase() === string2.toUpperCase();
  },

  /**
   * Trims any chars from beginning and from end of string, case sensitive
   * Example: trimAny(str, ' "\') trims quotes, spaces and slashes
   * @param {string} str String to trim
   * @param {string} chars Chars to trim from 'str'.
   * @return {string} Trimmed string; or empty string, if 'str' is not a string.
   */
  trimAny(str, chars) {
    if (!str || typeof str !== 'string') {
      return '';
    }
    let start = 0;
    let end = str.length;
    while (start < end && chars.indexOf(str[start]) >= 0) {
      ++start;
    }
    while (end > start && chars.indexOf(str[end - 1]) >= 0) {
      --end;
    }
    return (start > 0 || end < str.length) ? str.substring(start, end) : str;
  },

  /**
   * Replaces last occurrence of substring in a string, case sensitive
   * @param {string} str String to process
   * @param {string} searchValue Substring to search
   * @param {string} newValue Substring to replace
   * @return {string} Processed string; or empty string, if 'str' is not a string.
   */
  replaceLastOccurrence(str, searchValue, newValue) {
    if (!str || typeof str !== 'string') {
      return '';
    }
    const n = str.lastIndexOf(searchValue);
    return str.slice(0, n) + str.slice(n).replace(searchValue, newValue);
  },

  /**
   * Converts a bytes array to the respective string representation
   * @param {Array<number>|Uint8Array} bytes bytes array
   * @return {string}
   */
  bytesToHex(bytes = []) {
    const hex = [];

    bytes.forEach((b) => hex.push(
        (b >>> 4).toString(16),
        (b & 0xF).toString(16),
    ));

    return hex.join('');
  },

};
