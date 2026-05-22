'use strict';

const { z } = require('zod');
const { slugify } = require('../utils/slug');
const { badRequest, conflict, notFound } = require('../errors');

const nameSchema = z.string().trim().min(1, 'name required').max(64, 'name too long');
const descSchema = z.string().max(500, 'description too long').optional();
const slugInputSchema = z
  .string()
  .regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with dashes')
  .min(1)
  .max(64)
  .optional();

const createCategorySchema = z.object({
  name: nameSchema,
  slug: slugInputSchema,
  description: descSchema,
});

const patchCategorySchema = z.object({
  name: nameSchema.optional(),
  slug: slugInputSchema,
  description: descSchema,
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
  if (!s) {
    throw badRequest(
      'INVALID_SLUG',
      'Could not derive slug from name; please provide a slug explicitly',
    );
  }
  return s;
}

async function categoryRoutes(fastify) {
  const db = fastify.db;

  // ----- Public: list & detail -----
  fastify.get('/categories', async () => {
    const rows = db
      .prepare(
        `SELECT id, slug, name, description, created_at,
                (SELECT COUNT(*) FROM skills WHERE skills.category_id = categories.id
                                              AND skills.status = 'published') AS skill_count
         FROM categories
         ORDER BY name COLLATE NOCASE`,
      )
      .all();
    return { categories: rows };
  });

  fastify.get('/categories/:slug', async (req) => {
    const row = db
      .prepare('SELECT id, slug, name, description, created_at FROM categories WHERE slug = ?')
      .get(req.params.slug);
    if (!row) throw notFound('CATEGORY_NOT_FOUND', 'Category not found');
    return { category: row };
  });

  // ----- Admin: create / patch / delete -----
  fastify.post(
    '/admin/categories',
    { onRequest: [fastify.requireAdmin] },
    async (req, reply) => {
      const body = parseOrThrow(createCategorySchema, req.body);
      const slug = deriveSlug(body.name, body.slug);

      const existing = db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug);
      if (existing) throw conflict('CATEGORY_EXISTS', `Category slug "${slug}" already exists`);

      const result = db
        .prepare('INSERT INTO categories (slug, name, description) VALUES (?, ?, ?)')
        .run(slug, body.name, body.description ?? null);

      const category = db
        .prepare('SELECT id, slug, name, description, created_at FROM categories WHERE id = ?')
        .get(result.lastInsertRowid);
      return reply.code(201).send({ category });
    },
  );

  fastify.patch(
    '/admin/categories/:slug',
    { onRequest: [fastify.requireAdmin] },
    async (req) => {
      const body = parseOrThrow(patchCategorySchema, req.body);
      const cur = db.prepare('SELECT * FROM categories WHERE slug = ?').get(req.params.slug);
      if (!cur) throw notFound('CATEGORY_NOT_FOUND', 'Category not found');

      const newSlug = body.slug ?? (body.name ? deriveSlug(body.name, undefined) : cur.slug);
      if (newSlug !== cur.slug) {
        const dup = db.prepare('SELECT id FROM categories WHERE slug = ?').get(newSlug);
        if (dup) throw conflict('CATEGORY_EXISTS', `Category slug "${newSlug}" already exists`);
      }

      db.prepare(
        `UPDATE categories
         SET slug = ?, name = ?, description = ?
         WHERE id = ?`,
      ).run(
        newSlug,
        body.name ?? cur.name,
        body.description ?? cur.description,
        cur.id,
      );

      const updated = db
        .prepare('SELECT id, slug, name, description, created_at FROM categories WHERE id = ?')
        .get(cur.id);
      return { category: updated };
    },
  );

  fastify.delete(
    '/admin/categories/:slug',
    { onRequest: [fastify.requireAdmin] },
    async (req, reply) => {
      const cur = db.prepare('SELECT id FROM categories WHERE slug = ?').get(req.params.slug);
      if (!cur) throw notFound('CATEGORY_NOT_FOUND', 'Category not found');
      // SQL: skills.category_id has ON DELETE SET NULL, so existing skills survive without category
      db.prepare('DELETE FROM categories WHERE id = ?').run(cur.id);
      return reply.code(204).send();
    },
  );
}

module.exports = categoryRoutes;
