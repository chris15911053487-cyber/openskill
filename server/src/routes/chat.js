'use strict';

const { streamChat } = require('../llm');

const DEFAULT_SYSTEM_PROMPT = 'You are a helpful AI assistant.';

async function chatRoutes(app) {
  // List all conversations for current user (LEFT JOIN skills so skill is optional)
  app.get('/chat/conversations', { preHandler: [app.authenticate] }, async (req) => {
    const rows = app.db
      .prepare(
        `SELECT c.*, s.name as skill_name, s.slug as skill_slug
         FROM conversations c
         LEFT JOIN skills s ON s.id = c.skill_id
         WHERE c.user_id = ? ORDER BY c.updated_at DESC`,
      )
      .all(req.user.id);
    return { items: rows };
  });

  // Create a new conversation. skill_id is optional.
  app.post('/chat/conversations', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { skill_id } = req.body || {};

    let title = 'New chat';
    let resolvedSkillId = null;

    if (skill_id) {
      const skill = app.db
        .prepare('SELECT id, name FROM skills WHERE id = ? AND status = ?')
        .get(skill_id, 'published');
      if (!skill) return reply.code(404).send({ error: 'Skill not found', code: 'NOT_FOUND' });
      resolvedSkillId = skill.id;
      title = `Chat with ${skill.name}`;
    }

    const result = app.db
      .prepare('INSERT INTO conversations (user_id, skill_id, title) VALUES (?, ?, ?)')
      .run(req.user.id, resolvedSkillId, title);

    const conv = app.db
      .prepare(
        `SELECT c.*, s.name as skill_name, s.slug as skill_slug
         FROM conversations c
         LEFT JOIN skills s ON s.id = c.skill_id
         WHERE c.id = ?`,
      )
      .get(result.lastInsertRowid);
    return reply.code(201).send(conv);
  });

  // Update a conversation: change skill (set or clear) and/or title
  app.patch('/chat/conversations/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const conv = app.db
      .prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id);
    if (!conv) return reply.code(404).send({ error: 'Conversation not found', code: 'NOT_FOUND' });

    const body = req.body || {};
    const updates = [];
    const params = [];

    if ('skill_id' in body) {
      if (body.skill_id === null) {
        updates.push('skill_id = NULL');
      } else {
        const skill = app.db
          .prepare('SELECT id FROM skills WHERE id = ? AND status = ?')
          .get(body.skill_id, 'published');
        if (!skill) return reply.code(404).send({ error: 'Skill not found', code: 'NOT_FOUND' });
        updates.push('skill_id = ?');
        params.push(skill.id);
      }
    }

    if (typeof body.title === 'string' && body.title.trim()) {
      updates.push('title = ?');
      params.push(body.title.trim());
    }

    if (updates.length === 0) {
      return reply.code(400).send({ error: 'No updates provided', code: 'INVALID_INPUT' });
    }

    updates.push("updated_at = datetime('now')");
    params.push(conv.id);
    app.db
      .prepare(`UPDATE conversations SET ${updates.join(', ')} WHERE id = ?`)
      .run(...params);

    const updated = app.db
      .prepare(
        `SELECT c.*, s.name as skill_name, s.slug as skill_slug
         FROM conversations c
         LEFT JOIN skills s ON s.id = c.skill_id
         WHERE c.id = ?`,
      )
      .get(conv.id);
    return updated;
  });

  // Get messages for a conversation
  app.get('/chat/conversations/:id/messages', { preHandler: [app.authenticate] }, async (req, reply) => {
    const conv = app.db
      .prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id);
    if (!conv) return reply.code(404).send({ error: 'Conversation not found', code: 'NOT_FOUND' });

    const messages = app.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
      .all(conv.id);
    return { items: messages };
  });

  // Send a message and stream AI response
  app.post('/chat/conversations/:id/messages', { preHandler: [app.authenticate] }, async (req, reply) => {
    const conv = app.db
      .prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id);
    if (!conv) return reply.code(404).send({ error: 'Conversation not found', code: 'NOT_FOUND' });

    const { content } = req.body || {};
    if (!content) return reply.code(400).send({ error: 'content required', code: 'INVALID_INPUT' });

    // Save user message
    app.db
      .prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)')
      .run(conv.id, 'user', content);
    app.db
      .prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?")
      .run(conv.id);

    // Resolve system prompt: from skill if set, else default
    let systemPrompt = DEFAULT_SYSTEM_PROMPT;
    if (conv.skill_id) {
      const skill = app.db
        .prepare('SELECT skill_md_content FROM skills WHERE id = ?')
        .get(conv.skill_id);
      if (skill?.skill_md_content) systemPrompt = skill.skill_md_content;
    }

    // Conversation history (now includes the user message we just inserted)
    const history = app.db
      .prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
      .all(conv.id);

    // Stream response from LLM
    let stream;
    try {
      stream = await streamChat({ systemPrompt, messages: history });
    } catch (err) {
      return reply.code(502).send({ error: err.message, code: 'LLM_ERROR' });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    let fullResponse = '';
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              fullResponse += delta;
              reply.raw.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
            }
          } catch {
            // skip malformed chunks
          }
        }
      }
    } catch (err) {
      reply.raw.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    }

    if (fullResponse) {
      app.db
        .prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)')
        .run(conv.id, 'assistant', fullResponse);
    }

    reply.raw.write('data: [DONE]\n\n');
    reply.raw.end();
  });

  // Delete a conversation
  app.delete('/chat/conversations/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const conv = app.db
      .prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id);
    if (!conv) return reply.code(404).send({ error: 'Conversation not found', code: 'NOT_FOUND' });

    app.db.prepare('DELETE FROM conversations WHERE id = ?').run(conv.id);
    return reply.code(204).send();
  });
}

module.exports = { chatRoutes };
