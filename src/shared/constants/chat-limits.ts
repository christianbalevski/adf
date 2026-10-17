/**
 * The largest chat message (text plus inline attachments, base64 in JSON)
 * the daemon's POST /agents/:id/chat accepts. Embedded Studio takes a chat
 * over IPC with no cap of its own: each native attachment is held to the
 * agent's media limits (defaults 5 MB image, 10 MB audio, 20 MB video), so
 * this leaves room for several attachments at those limits. Studio names it
 * when a message is larger (daemon-mode AGENT_INVOKE).
 */
export const CHAT_BODY_LIMIT_BYTES = 128 * 1024 * 1024
