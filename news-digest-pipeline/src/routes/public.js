// Public reader page (theghostbrief.com) API. Every query here is hardcoded
// to status='published' (see getPublishedDigests/getPublishedDigestById in
// db/index.js) — no request input ever widens that filter. GET-only, no
// write helper imported anywhere in this file: this router cannot mutate
// digest or article data.

import { Router } from 'express';
import { getPublishedDigests, getPublishedDigestById, getDb } from '../db/index.js';
import { segmentDigest } from '../services/segmenter.js';
import { attributeSource } from '../services/source-link.js';

const router = Router();

// GET /api/public/digests — dated list for the public homepage.
router.get('/digests', (req, res) => {
  try {
    const digests = getPublishedDigests({ limit: 365 });
    res.json(digests.map((d) => ({ id: d.id, date: d.date })));
  } catch (err) {
    console.error('[public] GET /digests error:', err);
    res.status(500).json({ error: 'Failed to load digests' });
  }
});

// GET /api/public/digests/:id — full digest, parsed into public-safe items.
router.get('/digests/:id', (req, res) => {
  try {
    const digest = getPublishedDigestById(req.params.id);
    if (!digest) {
      return res.status(404).json({ error: 'Digest not found' });
    }

    const { items, ghostsRead } = segmentDigest(digest.content);

    const articleIds = items.map((item) => item.articleId).filter(Boolean);
    let imageByArticleId = {};
    if (articleIds.length > 0) {
      const db = getDb();
      const placeholders = articleIds.map(() => '?').join(',');
      const rows = db
        .prepare(`SELECT id, image_url FROM articles WHERE id IN (${placeholders})`)
        .all(...articleIds);
      imageByArticleId = Object.fromEntries(rows.map((r) => [r.id, r.image_url]));
    }

    res.json({
      id: digest.id,
      date: digest.date,
      ghosts_read: ghostsRead,
      items: items.map((item) => ({
        headline: item.headline,
        commentary: item.commentary,
        source: attributeSource(item.sourceLink),
        image_url: imageByArticleId[item.articleId] || null,
      })),
    });
  } catch (err) {
    console.error('[public] GET /digests/:id error:', err);
    res.status(500).json({ error: 'Failed to load digest' });
  }
});

export default router;
