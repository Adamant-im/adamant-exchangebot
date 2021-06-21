const { SAT, EPOCH } = require('./const');

module.exports = {

  /**
   * Converts provided `time` to ADAMANT's epoch timestamp
   * @param {number=} time timestamp to convert
   * @returns {number}
   */
  epochTime(time) {
    if (!time) {
      time = Date.now()
    }
    return Math.floor((time - EPOCH) / 1000)
  },

  /**
   * Converts ADAMANT's epoch timestamp to a Unix timestamp
   * @param {number} epochTime timestamp to convert
   * @returns {number}
   */
  toTimestamp(epochTime) {
    return epochTime * 1000 + EPOCH
  },

  satsToADM(sats, decimals = 8) {
    try {

      adm = (+sats / SAT).toFixed(decimals);
      adm = +adm;
      return adm

    } catch (e) { }
  },

  unix() {
    return new Date().getTime();
  },

  formatDate(timestamp) {
    if (!timestamp) return false;
    let formattedDate = { };
    let dateObject = new Date(timestamp);
    formattedDate.year = dateObject.getFullYear();
    formattedDate.month = ("0" + (dateObject.getMonth() + 1)).slice(-2);
    formattedDate.date = ("0" + dateObject.getDate()).slice(-2);
    formattedDate.hours = ("0" + dateObject.getHours()).slice(-2);
    formattedDate.minutes = ("0" + dateObject.getMinutes()).slice(-2);
    formattedDate.seconds = ("0" + dateObject.getSeconds()).slice(-2);
    formattedDate.YYYY_MM_DD = formattedDate.year + "-" + formattedDate.month + "-" + formattedDate.date;
    formattedDate.YYYY_MM_DD_hh_mm = formattedDate.year + "-" + formattedDate.month + "-" + formattedDate.date + " " + formattedDate.hours + ":" + formattedDate.minutes;
    formattedDate.hh_mm_ss = formattedDate.hours + ":" + formattedDate.minutes + ":" + formattedDate.seconds;
    return formattedDate
  },

  thousandSeparator(num, doBold) {
    var parts = (num + '').split('.'),
      main = parts[0],
      len = main.length,
      output = '',
      i = len - 1;

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

  getPrecision(decimals) {
    return +(Math.pow(10, -decimals).toFixed(decimals))
  },

  getModuleName(id) {
    if (!id)
      return '';
    let n = id.lastIndexOf("\\");
    if (n === -1)
      n = id.lastIndexOf("/");
    if (n === -1)
      return ''
    else
      return id.substring(n + 1);
  },

  isArraysEqual(array1, array2) {
		return array1.length === array2.length && array1.sort().every(function(value, index) { return value === array2.sort()[index]});
	}

};
