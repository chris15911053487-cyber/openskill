'use strict';

const { z } = require('zod');
const { slugify } = require('../utils/slug');
const { badRequest, conflict, notFound } = require('../errors');

const nameSchema = z.string().trim().min(1).max(48);
const slugInputSchema = z
  .string()
  .regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with dashes')
  .min(1)
  .max(48)
  .optional();

const createTagSchema = z.object({
  name: nameSchema,
  slug: slugInputSchema,
});

const patchTagSchema = z.object({
  name: nameSchema.optional(),
  slug: slugInputSchema,
});

function parseOrThrow(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw badRequest(
      'INVALID_INPUT',
      'Invalid input',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

function deriveSlug(name, providedSlug) {
  if (providedSlug) return providedSlug;
  const s = slugify(name);
  if (!s) throw badRequest('INVALID_SLUG', 'Could not derive slug from name');
  return s;
}

async function tagRoutes(fastify) {
  const db = fastify.db;

  // ----- Public list -----
  fastify.get('/tags', async () => {
    const rows = db
      .prepare(
        `SELECT t.id, t.slug, t.name, t.created_at,
                (SELECT COUNT(*) FROM skill_tags st
                                 JOIN skills s ON s.id = st.skill_id
                                 WHERE st.tag_id = t.id AND s.status = 'published') AS skill_count
         FROM tags t
         ORDER BY t.name COLLATE NOCASE`,
      )
      .all();
    return { tags: rows };
  });

  // ----- Admin -----
  fastify.post('/admin/tags', { onRequest: [fastify.requireAdmin] }, async (req, reply) => {
    const body = parseOrThrow(createTagSchema, req.body);
    const slug = deriveSlug(body.name, body.slug);
    const existing = db.prepare('SELECT id FROM tags WHERE slug = ?').get(slug);
    if (existing) throw conflict('TAG_EXISTS', `Tag slug "${slug}" already exists`);
    const result = db.prepare('INSERT INTO tags (slug, name) VALUES (?, ?)').run(slug, body.name);
    const tag = db
      .prepare('SELECT id, slug, name, created_at FROM tags WHERE id = ?')
      .get(result.lastInsertRowid);
    return reply.code(201).send({ tag });
  });

  fastify.patch('/admin/tags/:slug', { onRequest: [fastify.requireAdmin] }, async (req) => {
    const body = parseOrThrow(patchTagSchema, req.body);
    const cur = db.prepare('SELECT * FROM tags WHERE slug = ?').get(req.params.slug);
    if (!cur) throw notFound('TAG_NOT_FOUND', 'Tag not found');

    const newSlug = body.slug ?? (body.name ? deriveSlug(body.name, undefined) : cur.slug);
    if (newSlug !== cur.slug) {
      const dup = db.prepare('SELECT id FROM tags WHERE slug = ?').get(newSlug);
      if (dup) throw conflict('TAG_EXISTS', `Tag slug "${newSlug}" already exists`);
    }
    db.prepare('UPDATE tags SET slug = ?, name = ? WHERE id = ?').run(
      newSlug,
      body.name ?? cur.name,
      cur.id,
    );
    const tag = db
      .prepare('SELECT id, slug, name, created_at FROM tags WHERE id = ?')
      .get(cur.id);
    return { tag };
  });

  fastify.delete(
    '/admin/tags/:slug',
    { onRequest: [fastify.requireAdmin] },
    async (req, reply) => {
      const cur = db.prepare('SELECT id FROM tags WHERE slug = ?').get(req.params.slug);
      if (!cur) throw notFound('TAG_NOT_FOUND', 'Tag not found');
      db.prepare('DELETE FROM tags WHERE id = ?').run(cur.id); // skill_tags rows cascade
      return reply.code(204).send();
    },
  );
}

module.exports = tagRoutes;
