const { PHRASE_COLLECTIONS } = require('../../helpers/phrases');

/**
 * Words that must never appear in a reply the bot sends.
 *
 * The bot custodies funds, so price predictions read as investment advice, and the
 * repository's language policy forbids anything but English.
 */
const FORBIDDEN_PATTERNS = [
  { name: 'Cyrillic characters', pattern: /[Ѐ-ӿ]/ },
  { name: 'price predictions', pattern: /\b(pump|pumping|moon|mooning|to the moon)\b/i },
  { name: 'scam accusations', pattern: /\bscam\b/i },
  { name: 'darknet references', pattern: /\b(darknet|onion)\b/i },
];

describe('unknown-message phrases', () => {
  test('there is one collection per escalation step', () => {
    expect(PHRASE_COLLECTIONS).toHaveLength(6);
  });

  test('every collection has enough phrases to stay varied', () => {
    for (const collection of PHRASE_COLLECTIONS) {
      expect(collection.length).toBeGreaterThanOrEqual(8);
    }
  });

  test('every phrase is a non-empty, trimmed string', () => {
    for (const collection of PHRASE_COLLECTIONS) {
      for (const phrase of collection) {
        expect(typeof phrase).toBe('string');
        expect(phrase.trim()).toBe(phrase);
        expect(phrase.length).toBeGreaterThan(0);
      }
    }
  });

  test('no phrase contains a plain emoji with no words', () => {
    for (const collection of PHRASE_COLLECTIONS) {
      for (const phrase of collection) {
        expect(phrase).toMatch(/[A-Za-z]/);
      }
    }
  });

  test.each(FORBIDDEN_PATTERNS)('no phrase contains $name', ({ pattern }) => {
    for (const [index, collection] of PHRASE_COLLECTIONS.entries()) {
      for (const phrase of collection) {
        expect(`collection ${index}: ${phrase}`).not.toMatch(pattern);
      }
    }
  });

  test('phrases are unique within a collection', () => {
    for (const collection of PHRASE_COLLECTIONS) {
      expect(new Set(collection).size).toBe(collection.length);
    }
  });

  test('the collections are frozen, so a runtime bug cannot rewrite what the bot says', () => {
    expect(Object.isFrozen(PHRASE_COLLECTIONS)).toBe(true);

    for (const collection of PHRASE_COLLECTIONS) {
      expect(Object.isFrozen(collection)).toBe(true);
    }
  });
});
