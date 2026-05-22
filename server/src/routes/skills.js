'use strict';

const { z } = require('zod');
const fs = require('fs');
const path = require('path');
const { slugify } = require('../utils/slug');
const { validateSkillZip } = require('../skill-validator');
const { saveSkillZip, deleteSkillZip, skillZipPath } = require('../storage');
const { badRequest, conflict, notFound, forbidden } = require('../errors');

const slugSchema = z
  .string()
  .regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with dashes')
  .min(1)
  .max(64);

/**
 * Read all parts of a multipart request and return a flat object:
 *   {
 *     fields: { categorySlug, tagSlugs, slug?, name? },
 *     file: { filename, buffer, mimeType }
 *   }
 *
 * Returns null `file` if no `file` field arrived. Field values are strings.
 * tagSlugs is a JSON-encoded array if present, parsed to string[].
 */
async function readUpload(req, maxBytes) {
  const fields = {};
  let file = null;

  const parts = req.parts();
  for await (const part of parts) {
    if (part.type === 'file') {
      if (part.fieldname !== 'file') {
        // Drain unknown file parts to avoid hanging the stream
        await part.toBuffer().catch(() => null);
        continue;
      }
      const buf = await part.toBuffer();
      if (buf.length > maxBytes) {
        throw badRequest('UPLOAD_TOO_LARGE', `Upload exceeds limit (${maxBytes} bytes)`);
      }
      file = { filename: part.filename, buffer: buf, mimeType: part.mimetype };
    } else {
      fields[part.fieldname] = part.value;
    }
  }
  return { fields, file };
}

function deriveSlugForSkill(frontmatter, providedSlug) {
  if (providedSlug) return providedSlug;
  // Prefer explicit `slug` from frontmatter if present and valid
  if (frontmatter.slug && typeof frontmatter.slug === 'string') {
    const parsed = slugSchema.safeParse(frontmatter.slug);
    if (parsed.success) return parsed.data;
  }
  const s = slugify(frontmatter.name);
  if (!s) {
    throw badRequest(
      'INVALID_SLUG',
      'Could not derive slug from skill name; please provide a slug explicitly',
    );
  }
  return s;
}

function resolveCategory(db, slug) {
  if (!slug) return null;
  const row = db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug);
  if (!row) throw badRequest('CATEGORY_NOT_FOUND', `Unknown category "${slug}"`);
  return row.id;
}

function resolveTags(db, slugs) {
  if (!slugs || slugs.length === 0) return [];
  const out = [];
  for (const tagSlug of slugs) {
    const row = db.prepare('SELECT id FROM tags WHERE slug = ?').get(tagSlug);
    if (!row) throw badRequest('TAG_NOT_FOUND', `Unknown tag "${tagSlug}"`);
    out.push(row.id);
  }
  return out;
}

function parseTagSlugsField(value) {
  if (!value) return [];
  // Accept either JSON array or comma-separated string
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')) return parsed;
  } catch {
    /* ignore */
  }
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function skillsRoutes(fastify) {
  const db = fastify.db;
  const { skillsDir, maxUploadMb } = fastify.config;
  const maxBytes = maxUploadMb * 1024 * 1024;

  // ---------------------------------------------------------------------------
  // GET /skills — public list with search / filter / sort / pagination.
  //
  // Query params:
  //   q            — case-insensitive substring of name OR description
  //   category     — category slug
  //   tag          — tag slug (only one for now)
  //   sort         — newest | popular | downloads | name  (default: newest)
  //   page         — 1-based page number (default 1)
  //   limit        — items per page, 1..50 (default 20)
  //   status       — admin only; defaults to 'published' for everyone else
  //
  // Returns: { items: Skill[], total, page, limit, pages }
  // ---------------------------------------------------------------------------
  fastify.get('/skills', async (req) => {
    const q = (req.query.q || '').trim();
    const categorySlug = (req.query.category || '').trim() || null;
    const tagSlug = (req.query.tag || '').trim() || null;
    const sort = req.query.sort || 'newest';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;

    // Determine status filter. Anonymous + non-admin: published only.
    let isAdmin = false;
    try {
      await req.jwtVerify();
      isAdmin = req.user?.role === 'admin';
    } catch {
      /* anonymous is fine */
    }
    const requestedStatus = req.query.status;
    const statusFilter = isAdmin && requestedStatus ? requestedStatus : 'published';

    const where = ['s.status = ?'];
    const params = [statusFilter];

    if (q) {
      where.push("(s.name LIKE ? ESCAPE '\\' OR s.description LIKE ? ESCAPE '\\')");
      const like = `%${q.replace(/[%_\\]/g, (ch) => '\\' + ch)}%`;
      params.push(like, like);
    }
    if (categorySlug) {
      where.push('c.slug = ?');
      params.push(categorySlug);
    }
    if (tagSlug) {
      where.push(
        `EXISTS (
           SELECT 1 FROM skill_tags st
           JOIN tags t ON t.id = st.tag_id
           WHERE st.skill_id = s.id AND t.slug = ?
         )`,
      );
      params.push(tagSlug);
    }

    const orderClause = (() => {
      switch (sort) {
        case 'popular':
          return 'ORDER BY s.subscriber_count DESC, s.created_at DESC';
        case 'downloads':
          return 'ORDER BY s.download_count DESC, s.created_at DESC';
        case 'name':
          return 'ORDER BY s.name COLLATE NOCASE ASC';
        case 'newest':
        default:
          return 'ORDER BY COALESCE(s.published_at, s.created_at) DESC, s.id DESC';
      }
    })();

    const baseFrom = `
      FROM skills s
      LEFT JOIN categories c ON c.id = s.category_id
      LEFT JOIN users u ON u.id = s.author_user_id
      WHERE ${where.join(' AND ')}
    `;

    const total = db
      .prepare(`SELECT COUNT(*) AS n ${baseFrom}`)
      .get(...params).n;

    // For each skill we also pull its tags (separate query -> small N)
    const rows = db
      .prepare(
        `SELECT s.id, s.slug, s.name, s.description, s.readme_excerpt,
                s.status, s.version,
                s.subscriber_count, s.download_count,
                s.created_at, s.updated_at, s.published_at,
                c.slug AS category_slug, c.name AS category_name,
                u.id AS author_id, u.username AS author_username
         ${baseFrom}
         ${orderClause}
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);

    const tagStmt = db.prepare(
      `SELECT t.slug, t.name FROM skill_tags st
       JOIN tags t ON t.id = st.tag_id
       WHERE st.skill_id = ? ORDER BY t.name COLLATE NOCASE`,
    );
    for (const r of rows) {
      r.tags = tagStmt.all(r.id);
    }

    return {
      items: rows,
      total,
      page,
      limit,
      pages: Math.max(1, Math.ceil(total / limit)),
    };
  });

  // ---------------------------------------------------------------------------
  // GET /skills/:slug — single skill detail.
  //
  // Pending/rejected skills are visible only to their author or an admin.
  // ---------------------------------------------------------------------------
  fastify.get('/skills/:slug', async (req) => {
    const row = db
      .prepare(
        `SELECT s.id, s.slug, s.name, s.description, s.readme_excerpt,
                s.status, s.rejection_reason, s.version,
                s.file_size, s.sha256,
                s.subscriber_count, s.download_count,
                s.created_at, s.updated_at, s.published_at,
                c.slug AS category_slug, c.name AS category_name,
                u.id AS author_id, u.username AS author_username
         FROM skills s
         LEFT JOIN categories c ON c.id = s.category_id
         LEFT JOIN users u ON u.id = s.author_user_id
         WHERE s.slug = ?`,
      )
      .get(req.params.slug);

    if (!row) throw notFound('SKILL_NOT_FOUND', 'Skill not found');

    if (row.status !== 'published') {
      // Only author or admin can see non-published skills
      let user = null;
      try {
        await req.jwtVerify();
        user = req.user;
      } catch {
        /* anonymous */
      }
      if (!user) throw notFound('SKILL_NOT_FOUND', 'Skill not found');
      if (user.role !== 'admin' && user.id !== row.author_id) {
        throw notFound('SKILL_NOT_FOUND', 'Skill not found');
      }
    }

    row.tags = db
      .prepare(
        `SELECT t.slug, t.name FROM skill_tags st
         JOIN tags t ON t.id = st.tag_id
         WHERE st.skill_id = ? ORDER BY t.name COLLATE NOCASE`,
      )
      .all(row.id);

    return { skill: row };
  });

  // ---------------------------------------------------------------------------
  // GET /skills/:slug/preview — full SKILL.md content + file tree + manifest.
  //
  // All preview data is read from cached columns (skill_md_content,
  // file_tree_json, manifest_json) populated at upload time, so we never need
  // to re-read the ZIP from disk for browsing.
  // ---------------------------------------------------------------------------
  fastify.get('/skills/:slug/preview', async (req) => {
    const row = db
      .prepare(
        `SELECT id, slug, status, author_user_id,
                skill_md_content, file_tree_json, manifest_json
         FROM skills WHERE slug = ?`,
      )
      .get(req.params.slug);
    if (!row) throw notFound('SKILL_NOT_FOUND', 'Skill not found');

    if (row.status !== 'published') {
      let user = null;
      try {
        await req.jwtVerify();
        user = req.user;
      } catch {
        /* anonymous */
      }
      if (!user) throw notFound('SKILL_NOT_FOUND', 'Skill not found');
      if (user.role !== 'admin' && user.id !== row.author_user_id) {
        throw notFound('SKILL_NOT_FOUND', 'Skill not found');
      }
    }

    const manifest = row.manifest_json ? JSON.parse(row.manifest_json) : null;
    const fileTree = row.file_tree_json ? JSON.parse(row.file_tree_json) : [];
    return {
      slug: row.slug,
      skill_md: row.skill_md_content,
      frontmatter: manifest?.frontmatter || null,
      manifest: manifest?.manifest || null,
      file_tree: fileTree,
    };
  });

  // ---------------------------------------------------------------------------
  // GET /skills/:slug/download — stream the ZIP, count the download.
  //
  // Requires auth so we can attribute downloads. Anonymous users get 401.
  // Non-published skills are visible only to author and admin.
  // ---------------------------------------------------------------------------
  fastify.get(
    '/skills/:slug/download',
    { onRequest: [fastify.authenticate] },
    async (req, reply) => {
      const row = db
        .prepare(
          `SELECT id, slug, status, author_user_id, file_path, file_size
           FROM skills WHERE slug = ?`,
        )
        .get(req.params.slug);
      if (!row) throw notFound('SKILL_NOT_FOUND', 'Skill not found');

      if (row.status !== 'published') {
        if (req.user.role !== 'admin' && req.user.id !== row.author_user_id) {
          throw forbidden('FORBIDDEN', 'This skill is not published');
        }
      }

      const filePath = path.resolve(skillsDir, row.file_path);
      // Security: filePath must remain inside skillsDir (defense in depth)
      const skillsDirAbs = path.resolve(skillsDir);
      if (!filePath.startsWith(skillsDirAbs + path.sep) && filePath !== skillsDirAbs) {
        throw badRequest('INVALID_PATH', 'Refused to serve a path outside skills storage');
      }
      if (!fs.existsSync(filePath)) {
        throw notFound('SKILL_FILE_MISSING', 'Skill file is missing on disk');
      }

      // Increment download_count + log in a transaction
      const trx = db.transaction(() => {
        db.prepare(
          'UPDATE skills SET download_count = download_count + 1 WHERE id = ?',
        ).run(row.id);
        db.prepare(
          `INSERT INTO download_logs (user_id, skill_id, ip, user_agent)
           VALUES (?, ?, ?, ?)`,
        ).run(req.user.id, row.id, req.ip || null, req.headers['user-agent'] || null);
      });
      trx();

      const stream = fs.createReadStream(filePath);
      reply
        .header('Content-Type', 'application/zip')
        .header(
          'Content-Disposition',
          `attachment; filename="${row.slug}.zip"`,
        )
        .header('Content-Length', String(row.file_size));
      return reply.send(stream);
    },
  );

  // ---------------------------------------------------------------------------
  // POST /skills/:slug/subscribe — add to current user's subscriptions.
  // DELETE /skills/:slug/subscribe — remove.
  //
  // Anonymous: 401. Already subscribed -> 409 on POST.
  // Counter (skills.subscriber_count) is kept in sync via the same transaction.
  // ---------------------------------------------------------------------------
  fastify.post(
    '/skills/:slug/subscribe',
    { onRequest: [fastify.authenticate] },
    async (req, reply) => {
      const row = db
        .prepare('SELECT id, status FROM skills WHERE slug = ?')
        .get(req.params.slug);
      if (!row) throw notFound('SKILL_NOT_FOUND', 'Skill not found');
      if (row.status !== 'published') {
        throw badRequest('SKILL_NOT_PUBLISHED', 'You can only subscribe to published skills');
      }
      const existing = db
        .prepare('SELECT id FROM subscriptions WHERE user_id = ? AND skill_id = ?')
        .get(req.user.id, row.id);
      if (existing) {
        throw conflict('ALREADY_SUBSCRIBED', 'Already subscribed');
      }
      const trx = db.transaction(() => {
        db.prepare(
          'INSERT INTO subscriptions (user_id, skill_id) VALUES (?, ?)',
        ).run(req.user.id, row.id);
        db.prepare(
          'UPDATE skills SET subscriber_count = subscriber_count + 1 WHERE id = ?',
        ).run(row.id);
      });
      trx();
      return reply.code(201).send({ subscribed: true });
    },
  );

  fastify.delete(
    '/skills/:slug/subscribe',
    { onRequest: [fastify.authenticate] },
    async (req, reply) => {
      const row = db
        .prepare('SELECT id FROM skills WHERE slug = ?')
        .get(req.params.slug);
      if (!row) throw notFound('SKILL_NOT_FOUND', 'Skill not found');
      const sub = db
        .prepare('SELECT id FROM subscriptions WHERE user_id = ? AND skill_id = ?')
        .get(req.user.id, row.id);
      if (!sub) {
        throw notFound('NOT_SUBSCRIBED', 'You are not subscribed to this skill');
      }
      const trx = db.transaction(() => {
        db.prepare('DELETE FROM subscriptions WHERE id = ?').run(sub.id);
        db.prepare(
          'UPDATE skills SET subscriber_count = MAX(0, subscriber_count - 1) WHERE id = ?',
        ).run(row.id);
      });
      trx();
      return reply.code(204).send();
    },
  );

  // ---------------------------------------------------------------------------
  // GET /me/subscriptions — current user's subscribed skills (latest first).
  // ---------------------------------------------------------------------------
  fastify.get(
    '/me/subscriptions',
    { onRequest: [fastify.authenticate] },
    async (req) => {
      const rows = db
        .prepare(
          `SELECT s.id, s.slug, s.name, s.description, s.readme_excerpt,
                  s.status, s.version,
                  s.subscriber_count, s.download_count,
                  s.created_at, s.updated_at, s.published_at,
                  c.slug AS category_slug, c.name AS category_name,
                  u.id AS author_id, u.username AS author_username,
                  sub.created_at AS subscribed_at
           FROM subscriptions sub
           JOIN skills s ON s.id = sub.skill_id
           LEFT JOIN categories c ON c.id = s.category_id
           LEFT JOIN users u ON u.id = s.author_user_id
           WHERE sub.user_id = ?
           ORDER BY sub.created_at DESC`,
        )
        .all(req.user.id);
      const tagStmt = db.prepare(
        `SELECT t.slug, t.name FROM skill_tags st
         JOIN tags t ON t.id = st.tag_id
         WHERE st.skill_id = ? ORDER BY t.name COLLATE NOCASE`,
      );
      for (const r of rows) r.tags = tagStmt.all(r.id);
      return { items: rows };
    },
  );

  // ---------------------------------------------------------------------------
  // GET /skills/:slug/subscription — { subscribed: bool }
  // (lightweight check used by the detail view)
  // ---------------------------------------------------------------------------
  fastify.get(
    '/skills/:slug/subscription',
    { onRequest: [fastify.authenticate] },
    async (req) => {
      const row = db.prepare('SELECT id FROM skills WHERE slug = ?').get(req.params.slug);
      if (!row) throw notFound('SKILL_NOT_FOUND', 'Skill not found');
      const sub = db
        .prepare('SELECT 1 FROM subscriptions WHERE user_id = ? AND skill_id = ?')
        .get(req.user.id, row.id);
      return { subscribed: !!sub };
    },
  );

  // ---------------------------------------------------------------------------
  // POST /admin/skills/:slug/approve — admin moves a pending skill to published.
  // POST /admin/skills/:slug/reject  — admin rejects a pending skill, with reason.
  //
  // Both write to audit_logs. Idempotency: approving an already-published or
  // already-rejected skill returns 409 STATE_CONFLICT to avoid mistakes.
  // ---------------------------------------------------------------------------
  fastify.post(
    '/admin/skills/:slug/approve',
    { onRequest: [fastify.requireAdmin] },
    async (req) => {
      const row = db
        .prepare('SELECT id, status FROM skills WHERE slug = ?')
        .get(req.params.slug);
      if (!row) throw notFound('SKILL_NOT_FOUND', 'Skill not found');
      if (row.status === 'published') {
        throw conflict('STATE_CONFLICT', 'Skill is already published');
      }
      const trx = db.transaction(() => {
        db.prepare(
          `UPDATE skills SET status='published', published_at=datetime('now'),
                              rejection_reason=NULL,
                              updated_at=datetime('now')
           WHERE id = ?`,
        ).run(row.id);
        db.prepare(
          `INSERT INTO audit_logs (actor_user_id, action, target_skill_id, note)
           VALUES (?, 'approve_skill', ?, ?)`,
        ).run(req.user.id, row.id, null);
      });
      trx();
      const skill = db
        .prepare(
          `SELECT id, slug, name, status, published_at FROM skills WHERE id = ?`,
        )
        .get(row.id);
      return { skill };
    },
  );

  fastify.post(
    '/admin/skills/:slug/reject',
    { onRequest: [fastify.requireAdmin] },
    async (req) => {
      const reasonSchema = z.object({
        reason: z.string().trim().min(1, 'reason is required').max(1000),
      });
      const parse = reasonSchema.safeParse(req.body);
      if (!parse.success) {
        throw badRequest(
          'INVALID_INPUT',
          'Invalid input',
          parse.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        );
      }
      const { reason } = parse.data;

      const row = db
        .prepare('SELECT id, status FROM skills WHERE slug = ?')
        .get(req.params.slug);
      if (!row) throw notFound('SKILL_NOT_FOUND', 'Skill not found');
      if (row.status === 'rejected') {
        throw conflict('STATE_CONFLICT', 'Skill is already rejected');
      }

      const trx = db.transaction(() => {
        db.prepare(
          `UPDATE skills SET status='rejected', rejection_reason=?,
                              updated_at=datetime('now')
           WHERE id = ?`,
        ).run(reason, row.id);
        db.prepare(
          `INSERT INTO audit_logs (actor_user_id, action, target_skill_id, note)
           VALUES (?, 'reject_skill', ?, ?)`,
        ).run(req.user.id, row.id, reason);
      });
      trx();
      const skill = db
        .prepare(
          `SELECT id, slug, name, status, rejection_reason FROM skills WHERE id = ?`,
        )
        .get(row.id);
      return { skill };
    },
  );

  // ---------------------------------------------------------------------------
  // GET /me/uploads — current user's skills (all statuses).
  // ---------------------------------------------------------------------------
  fastify.get(
    '/me/uploads',
    { onRequest: [fastify.authenticate] },
    async (req) => {
      const rows = db
        .prepare(
          `SELECT s.id, s.slug, s.name, s.description,
                  s.status, s.rejection_reason, s.version,
                  s.subscriber_count, s.download_count,
                  s.created_at, s.updated_at, s.published_at,
                  c.slug AS category_slug, c.name AS category_name
           FROM skills s
           LEFT JOIN categories c ON c.id = s.category_id
           WHERE s.author_user_id = ?
           ORDER BY s.updated_at DESC`,
        )
        .all(req.user.id);
      const tagStmt = db.prepare(
        `SELECT t.slug, t.name FROM skill_tags st
         JOIN tags t ON t.id = st.tag_id
         WHERE st.skill_id = ? ORDER BY t.name COLLATE NOCASE`,
      );
      for (const r of rows) r.tags = tagStmt.all(r.id);
      return { items: rows };
    },
  );

  // ---------------------------------------------------------------------------
  // PUT /skills/:slug — replace the ZIP for an existing skill.
  //
  // Only the original author or an admin may re-upload. The slug is fixed by
  // the URL; the new SKILL.md must declare a `name` whose derived slug matches
  // (otherwise the user should create a new skill instead).
  //
  // After re-upload:
  //   - regular author -> status reverts to 'pending'
  //   - admin author or admin re-uploading someone else's -> stays/becomes 'published'
  // ---------------------------------------------------------------------------
  fastify.put(
    '/skills/:slug',
    { onRequest: [fastify.authenticate] },
    async (req, reply) => {
      const cur = db
        .prepare(
          `SELECT id, slug, author_user_id, status, file_path
           FROM skills WHERE slug = ?`,
        )
        .get(req.params.slug);
      if (!cur) throw notFound('SKILL_NOT_FOUND', 'Skill not found');

      const isAdmin = req.user.role === 'admin';
      if (!isAdmin && cur.author_user_id !== req.user.id) {
        throw forbidden('FORBIDDEN', 'Only the author or an admin can re-upload this skill');
      }

      if (!req.isMultipart()) {
        throw badRequest('INVALID_INPUT', 'Request must be multipart/form-data');
      }
      const { fields, file } = await readUpload(req, maxBytes);
      if (!file) throw badRequest('INVALID_INPUT', '`file` field is required');

      const validated = validateSkillZip(file.buffer);
      const newSlug = deriveSlugForSkill(validated.frontmatter, undefined);
      if (newSlug !== cur.slug) {
        throw badRequest(
          'SLUG_MISMATCH',
          `New ZIP defines a different slug ("${newSlug}"); upload it as a new skill instead`,
        );
      }

      // Optional metadata updates — must be sent by author/admin
      const newCategoryId =
        fields.categorySlug !== undefined
          ? resolveCategory(db, fields.categorySlug || null)
          : undefined;
      const newTagIds =
        fields.tagSlugs !== undefined
          ? resolveTags(db, parseTagSlugsField(fields.tagSlugs))
          : undefined;

      // Save the new ZIP atomically (overwrites the existing one)
      const stored = saveSkillZip(skillsDir, cur.slug, file.buffer);

      const newStatus = isAdmin ? 'published' : 'pending';
      const publishedAt =
        newStatus === 'published' ? new Date().toISOString() : null;

      const updateStmt = db.prepare(
        `UPDATE skills
         SET name = @name,
             description = @description,
             readme_excerpt = @readme_excerpt,
             version = @version,
             file_path = @file_path,
             file_size = @file_size,
             sha256 = @sha256,
             manifest_json = @manifest_json,
             skill_md_content = @skill_md_content,
             file_tree_json = @file_tree_json,
             status = @status,
             rejection_reason = NULL,
             published_at = COALESCE(@published_at, published_at),
             updated_at = datetime('now'),
             category_id = COALESCE(@category_id, category_id)
         WHERE id = @id`,
      );

      const trx = db.transaction(() => {
        updateStmt.run({
          id: cur.id,
          name: validated.frontmatter.name,
          description: validated.frontmatter.description,
          readme_excerpt: validated.readmeExcerpt,
          version:
            validated.manifest && typeof validated.manifest.version === 'string'
              ? validated.manifest.version
              : null,
          file_path: stored.relPath,
          file_size: stored.fileSize,
          sha256: stored.sha256,
          manifest_json: JSON.stringify({
            frontmatter: validated.frontmatter,
            manifest: validated.manifest,
          }),
          skill_md_content: validated.skillMdContent,
          file_tree_json: JSON.stringify(validated.fileTree),
          status: newStatus,
          published_at: publishedAt,
          category_id: newCategoryId === undefined ? null : newCategoryId,
        });
        if (newTagIds !== undefined) {
          db.prepare('DELETE FROM skill_tags WHERE skill_id = ?').run(cur.id);
          const ins = db.prepare('INSERT INTO skill_tags (skill_id, tag_id) VALUES (?, ?)');
          for (const tagId of newTagIds) ins.run(cur.id, tagId);
        }
        db.prepare(
          `INSERT INTO audit_logs (actor_user_id, action, target_skill_id, note)
           VALUES (?, ?, ?, ?)`,
        ).run(req.user.id, 'reupload_skill', cur.id, `new sha256=${stored.sha256}`);
      });
      trx();

      const skill = db
        .prepare(
          `SELECT id, slug, name, description, status, version,
                  file_size, sha256, download_count, subscriber_count,
                  created_at, updated_at, published_at
           FROM skills WHERE id = ?`,
        )
        .get(cur.id);
      return reply.code(200).send({ skill });
    },
  );

  // ---------------------------------------------------------------------------
  // DELETE /skills/:slug — remove a skill (author or admin).
  // ---------------------------------------------------------------------------
  fastify.delete(
    '/skills/:slug',
    { onRequest: [fastify.authenticate] },
    async (req, reply) => {
      const cur = db
        .prepare('SELECT id, slug, author_user_id FROM skills WHERE slug = ?')
        .get(req.params.slug);
      if (!cur) throw notFound('SKILL_NOT_FOUND', 'Skill not found');
      const isAdmin = req.user.role === 'admin';
      if (!isAdmin && cur.author_user_id !== req.user.id) {
        throw forbidden('FORBIDDEN', 'Only the author or an admin can delete this skill');
      }
      const trx = db.transaction(() => {
        db.prepare(
          `INSERT INTO audit_logs (actor_user_id, action, target_skill_id, note)
           VALUES (?, 'delete_skill', ?, ?)`,
        ).run(req.user.id, cur.id, cur.slug);
        db.prepare('DELETE FROM skills WHERE id = ?').run(cur.id);
      });
      trx();
      try {
        deleteSkillZip(skillsDir, cur.slug);
      } catch {
        /* file may already be missing */
      }
      return reply.code(204).send();
    },
  );

  /**
   * POST /skills — upload a new skill ZIP.
   *
   * Multipart fields:
   *   - file:           ZIP file (required)
   *   - slug:           override the slug (optional)
   *   - categorySlug:   assign to a category (optional)
   *   - tagSlugs:       JSON array of tag slugs OR comma-separated (optional)
   *
   * Behaviour:
   *   - admin uploader → status='published'
   *   - regular user   → status='pending'  (awaits review)
   */
  fastify.post('/skills', { onRequest: [fastify.authenticate] }, async (req, reply) => {
    if (!req.isMultipart()) {
      throw badRequest('INVALID_INPUT', 'Request must be multipart/form-data');
    }
    const { fields, file } = await readUpload(req, maxBytes);
    if (!file) throw badRequest('INVALID_INPUT', '`file` field is required');

    const validated = validateSkillZip(file.buffer);

    const customSlug = fields.slug
      ? slugSchema.parse(fields.slug.toLowerCase())
      : undefined;
    const slug = deriveSlugForSkill(validated.frontmatter, customSlug);

    // Reject if the slug is already taken (latest-version-only model)
    const existing = db.prepare('SELECT id FROM skills WHERE slug = ?').get(slug);
    if (existing) {
      throw conflict(
        'SKILL_EXISTS',
        `A skill with slug "${slug}" already exists. Use PUT /skills/${slug} to replace it (owner/admin only).`,
      );
    }

    const categoryId = resolveCategory(db, fields.categorySlug);
    const tagIds = resolveTags(db, parseTagSlugsField(fields.tagSlugs));

    // Persist the ZIP to disk
    const stored = saveSkillZip(skillsDir, slug, file.buffer);

    const isAdmin = req.user.role === 'admin';
    const status = isAdmin ? 'published' : 'pending';
    const publishedAt = isAdmin ? new Date().toISOString() : null;

    // DB insert in a transaction so we can also link tags
    const insertSkill = db.prepare(
      `INSERT INTO skills (
         slug, name, description, readme_excerpt,
         author_user_id, category_id,
         status, version, file_path, file_size, sha256,
         manifest_json, skill_md_content, file_tree_json,
         published_at
       ) VALUES (
         @slug, @name, @description, @readme_excerpt,
         @author_user_id, @category_id,
         @status, @version, @file_path, @file_size, @sha256,
         @manifest_json, @skill_md_content, @file_tree_json,
         @published_at
       )`,
    );
    const insertTag = db.prepare('INSERT INTO skill_tags (skill_id, tag_id) VALUES (?, ?)');
    const insertAudit = db.prepare(
      `INSERT INTO audit_logs (actor_user_id, action, target_skill_id, note)
       VALUES (?, ?, ?, ?)`,
    );

    let skillId;
    try {
      const trx = db.transaction(() => {
        const result = insertSkill.run({
          slug,
          name: validated.frontmatter.name,
          description: validated.frontmatter.description,
          readme_excerpt: validated.readmeExcerpt,
          author_user_id: req.user.id,
          category_id: categoryId,
          status,
          version:
            validated.manifest && typeof validated.manifest.version === 'string'
              ? validated.manifest.version
              : null,
          file_path: stored.relPath,
          file_size: stored.fileSize,
          sha256: stored.sha256,
          manifest_json: JSON.stringify({
            frontmatter: validated.frontmatter,
            manifest: validated.manifest,
          }),
          skill_md_content: validated.skillMdContent,
          file_tree_json: JSON.stringify(validated.fileTree),
          published_at: publishedAt,
        });
        skillId = result.lastInsertRowid;
        for (const tagId of tagIds) insertTag.run(skillId, tagId);
        insertAudit.run(
          req.user.id,
          isAdmin ? 'admin_publish_skill' : 'user_submit_skill',
          skillId,
          null,
        );
      });
      trx();
    } catch (err) {
      // Roll back the file we just wrote if the DB insert failed
      try {
        deleteSkillZip(skillsDir, slug);
      } catch {
        /* ignore */
      }
      throw err;
    }

    const skill = db
      .prepare(
        `SELECT id, slug, name, description, status, file_size, sha256,
                download_count, subscriber_count, created_at, published_at
         FROM skills WHERE id = ?`,
      )
      .get(skillId);
    return reply.code(201).send({ skill });
  });
}

module.exports = skillsRoutes;
