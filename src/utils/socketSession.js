// src/utils/socketSession.js
//
// Socket.IO authentication. A socket used to be bound to whatever userId the
// browser sent in "register_session", so anyone could subscribe to another
// user's live events (XP awards, notifications, progress). Now:
//  • the handshake must carry the JWT (socket.io-client `auth: { token }`)
//    and the browser's orbit_bind cookie (sent with `withCredentials: true`)
//    — the same two factors, and the same checks, as every HTTP request
//    (middleware/auth.js resolveSession);
//  • the socket is bound to the user from the database at connection time;
//  • "register_session" is accepted for old clients but its payload is
//    ignored — it can never switch the socket to a different user.
const { resolveSession } = require('../middleware/auth');

// Reads one cookie from a raw Cookie header (no extra dependency).
function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { return part.slice(i + 1).trim(); }
    }
  }
  return undefined;
}

function socketAuthMiddleware() {
  return async (socket, next) => {
    try {
      const handshake = socket.handshake || {};
      const token = handshake.auth?.token || handshake.headers?.authorization;
      const result = await resolveSession({ token, bindingSecret: readCookie(handshake.headers?.cookie, 'orbit_bind') });
      if (!result.user) return next(new Error('unauthorized'));
      socket.data.userId = result.user.id.toString();
      return next();
    } catch (err) {
      return next(new Error('unauthorized'));
    }
  };
}

function bindSocket(socket, activeUserSockets) {
  const userId = socket.data.userId;
  if (!userId) return;
  if (!activeUserSockets.has(userId)) activeUserSockets.set(userId, []);
  if (!activeUserSockets.get(userId).includes(socket.id)) activeUserSockets.get(userId).push(socket.id);
  socket.userId = userId;
}

function unbindSocket(socket, activeUserSockets) {
  const userId = socket.userId;
  if (!userId || !activeUserSockets.has(userId)) return;
  const remaining = activeUserSockets.get(userId).filter((id) => id !== socket.id);
  if (remaining.length) activeUserSockets.set(userId, remaining);
  else activeUserSockets.delete(userId);
}

// Wires authentication + per-user socket tracking onto an io server.
function attachSocketSessions(io, activeUserSockets) {
  io.use(socketAuthMiddleware());
  io.on('connection', (socket) => {
    bindSocket(socket, activeUserSockets);
    // Old clients still emit this; the claimed id is ignored on purpose.
    socket.on('register_session', () => bindSocket(socket, activeUserSockets));
    socket.on('disconnect', () => unbindSocket(socket, activeUserSockets));
  });
}

module.exports = { attachSocketSessions, socketAuthMiddleware, bindSocket, unbindSocket, readCookie };
