import { describe, it, expect } from 'vitest';
import { jaccardSimilarity, findDuplicateGroups } from './similarity.js';

const DEFAULT_THRESHOLD = 0.4;

describe('jaccardSimilarity', () => {
  it('returns 1 for identical text', () => {
    const text = 'Russian forces struck a residential building in Kharkiv overnight, killing three civilians.';
    expect(jaccardSimilarity(text, text)).toBe(1);
  });

  it('returns 0 for completely unrelated text', () => {
    const a = 'The central bank raised interest rates by a quarter point on Wednesday.';
    const b = 'A new species of deep-sea fish was discovered off the coast of Japan.';
    expect(jaccardSimilarity(a, b)).toBeLessThan(0.1);
  });

  it('returns 0 when either text is too short to shingle meaningfully', () => {
    expect(jaccardSimilarity('short', 'also short')).toBe(0);
    expect(jaccardSimilarity('', 'some real amount of text here to compare against')).toBe(0);
  });
});

describe('findDuplicateGroups — near-identical stories (should flag)', () => {
  it('groups two wire-syndicated near-identical rewrites of the same story', () => {
    const articles = [
      {
        id: 'a',
        title: 'Russian strike kills three in Kharkiv',
        content:
          'Russian forces launched a missile strike on a residential building in Kharkiv early Tuesday morning, killing at least three civilians and injuring a dozen more, local officials said. Emergency crews worked through the night to clear rubble from the site. Ukrainian President Volodymyr Zelensky condemned the attack as a deliberate strike on civilians.',
      },
      {
        id: 'b',
        title: 'Missile hits residential building in Kharkiv, killing three',
        content:
          'Russian forces launched a missile strike on a residential building in Kharkiv early Tuesday, killing at least three civilians and injuring a dozen others, officials said. Emergency crews worked overnight to clear rubble from the site. President Volodymyr Zelensky condemned the attack as a deliberate strike on civilians.',
      },
    ];

    const sim = jaccardSimilarity(
      `${articles[0].title} ${articles[0].content}`,
      `${articles[1].title} ${articles[1].content}`
    );
    expect(sim).toBeGreaterThanOrEqual(DEFAULT_THRESHOLD);

    const groups = findDuplicateGroups(articles, DEFAULT_THRESHOLD);
    expect(groups).toHaveLength(1);
    expect(groups[0].map((a) => a.id).sort()).toEqual(['a', 'b']);
  });
});

describe('findDuplicateGroups — distinct same-topic stories (should NOT flag)', () => {
  it('does not group two independently-written articles about the same broad topic', () => {
    const articles = [
      {
        id: 'a',
        title: 'Russian strike kills three in Kharkiv',
        content:
          'Russian forces launched a missile strike on a residential building in Kharkiv early Tuesday morning, killing at least three civilians and injuring a dozen more, local officials said. Emergency crews worked through the night to clear rubble from the site.',
      },
      {
        id: 'c',
        title: 'Drone debris sparks fire in Odesa warehouse',
        content:
          'Ukrainian air defense intercepted a wave of Shahed drones over Odesa overnight, though falling debris damaged a warehouse and sparked a fire, regional authorities reported Wednesday. No casualties were reported in the incident, and firefighters brought the blaze under control within an hour.',
      },
    ];

    const sim = jaccardSimilarity(
      `${articles[0].title} ${articles[0].content}`,
      `${articles[1].title} ${articles[1].content}`
    );
    expect(sim).toBeLessThan(DEFAULT_THRESHOLD);

    const groups = findDuplicateGroups(articles, DEFAULT_THRESHOLD);
    expect(groups).toHaveLength(0);
  });

  it('never returns a group of size 1 or flags an article against itself alone', () => {
    const articles = [{ id: 'solo', title: 'x', content: 'a b c d e f g h i j k l m n o p'.repeat(3) }];
    expect(findDuplicateGroups(articles, 0.1)).toHaveLength(0);
  });
});
