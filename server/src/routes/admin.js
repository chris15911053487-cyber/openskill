'use strict';

/**
 * Admin-only routes that don't fit into the categories/tags/skills feature
 * modules. Currently: /admin/stats and /admin/users.
 */
async function adminRoutes(fastify) {
  const db = fastify.db;

  // ---------------------------------------------------------------------------
  // GET /admin/stats — high-level numbers for the dashboard.
  // ---------------------------------------------------------------------------
  fastify.get(
    '/admin/stats',
    { onRequest: [fastify.requireAdmin] },
    async () => {
      const totals = db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM users) AS users,
             (SELECT COUNT(*) FROM users WHERE role='admin') AS admins,
             (SELECT COUNT(*) FROM skills) AS skills_total,
             (SELECT COUNT(*) FROM skills WHERE status='published') AS skills_published,
             (SELECT COUNT(*) FROM skills WHERE status='pending') AS skills_pending,
             (SELECT COUNT(*) FROM skills WHERE status='rejected') AS skills_rejected,
             (SELECT COALESCE(SUM(download_count),0) FROM skills) AS total_downloads,
             (SELECT COALESCE(SUM(subscriber_count),0) FROM skills) AS total_subscriptions,
             (SELECT COUNT(*) FROM categories) AS categories,
             (SELECT COUNT(*) FROM tags) AS tags`,
        )
        .get();

      const topSubscribed = db
        .prepare(
          `SELECT slug, name, subscriber_count, download_count
           FROM skills WHERE status='published'
           ORDER BY subscriber_count DESC, download_count DESC
           LIMIT 10`,
        )
        .all();
      const topDownloaded = db
        .prepare(
          `SELECT slug, name, subscriber_count, download_count
           FROM skills WHERE status='published'
           ORDER BY download_count DESC, subscriber_count DESC
           LIMIT 10`,
        )
        .all();
      const recentUploads = db
        .prepare(
          `SELECT s.slug, s.name, s.status, s.created_at, u.username AS author_username
           FROM skills s
           LEFT JOIN users u ON u.id = s.author_user_id
           ORDER BY s.created_at DESC
           LIMIT 10`,
        )
        .all();

      return { totals, topSubscribed, topDownloaded, recentUploads };
    },
  );

  // ---------------------------------------------------------------------------
  // GET /admin/users — list users with their upload counts.
  // ---------------------------------------------------------------------------
  fastify.get(
    '/admin/users',
    { onRequest: [fastify.requireAdmin] },
    async () => {
      const rows = db
        .prepare(
          `SELECT u.id, u.username, u.email, u.role, u.created_at,
                  (SELECT COUNT(*) FROM skills WHERE author_user_id = u.id) AS skill_count
           FROM users u
           ORDER BY u.created_at DESC`,
        )
        .all();
      return { users: rows };
    },
  );
}

module.exports = adminRoutes;
