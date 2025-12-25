// server.js
// Jeopardy WebSocket Server (Socket.IO) - Render-ready

import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, methods: ["GET", "POST"] },
});

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// ------- Game defaults -------
function makeDefaultBoard() {
  const categories = ["Kategorie A", "Kategorie B", "Kategorie C", "Kategorie D", "Kategorie E"];
  const values = [100, 200, 300, 400, 500];

  return categories.map((cat, cIdx) => ({
    id: `cat_${cIdx}`,
    title: cat,
    clues: values.map((v, rIdx) => ({
      id: `q_${cIdx}_${rIdx}`,
      value: v,
      question: `Frage ${cat} (${v})`,
      answer: `Antwort zu ${cat} (${v})`,
      used: false,
    })),
  }));
}

function defaultState() {
  return {
    version: 1,
    players: [],
    board: makeDefaultBoard(),
    overlay: { open: false, clueId: null },
    answeringPlayerId: null,
    buzz: { active: false, queue: [], selectedPlayerId: null },
    lastUpdateAt: Date.now(),
  };
}

function findClue(state, clueId) {
  for (const cat of state.board) {
    for (const clue of cat.clues) {
      if (clue.id === clueId) return { cat, clue };
    }
  }
  return null;
}

// ------- Rooms storage (in-memory) -------
/**
 * rooms[roomId] = {
 *   hostSocketId: string | null,
 *   state: GameState,
 *   clients: Map(socketId -> { role, displayName, playerId|null })
 * }
 */
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      hostSocketId: null,
      state: defaultState(),
      clients: new Map(),
    });
  }
  return rooms.get(roomId);
}

function broadcastState(roomId) {
  const room = getRoom(roomId);
  room.state.lastUpdateAt = Date.now();
  io.to(roomId).emit("state", sanitizeStateForAudience(room.state)); // full state is fine; client hides answer in UI
}

function sanitizeStateForAudience(state) {
  // Wir schicken bewusst den vollen State (inkl. Answers) – die UI blendet Antworten nur beim Host ein.
  // Wenn du *wirklich* verhindern willst, dass Zuschauer Antworten bekommen, müssten wir getrennte payloads senden.
  return state;
}

function isHost(room, socketId) {
  return room.hostSocketId === socketId;
}

function ensureHost(room, socket) {
  if (!isHost(room, socket.id)) {
    socket.emit("error_msg", "Nur der Host darf diese Aktion ausführen.");
    return false;
  }
  return true;
}

// ------- Socket.IO -------
io.on("connection", (socket) => {
  socket.on("join", ({ roomId, role, displayName }) => {
    roomId = String(roomId || "").trim().toUpperCase();
    if (!roomId) roomId = "DEFAULT";

    const room = getRoom(roomId);

    // Host "claim" (mit Takeover, falls alter Host nicht mehr online ist)
if (role === "host") {
  // wenn ein hostSocketId gespeichert ist, aber der Socket nicht mehr existiert -> freigeben
  if (room.hostSocketId && !io.sockets.sockets.has(room.hostSocketId)) {
    room.hostSocketId = null;
  }

  if (!room.hostSocketId) {
    room.hostSocketId = socket.id;
  } else if (room.hostSocketId !== socket.id) {
    socket.emit("error_msg", "Es gibt bereits einen Host in diesem Raum.");
    role = "audience";
  }
}

    room.clients.set(socket.id, { role, displayName: displayName || "Client", playerId: null });

    socket.join(roomId);
    socket.data.roomId = roomId;

    socket.emit("joined", {
      roomId,
      role: room.clients.get(socket.id).role,
      isHost: isHost(room, socket.id),
      hostPresent: !!room.hostSocketId,
    });

    // initial state
    socket.emit("state", sanitizeStateForAudience(room.state));
  });

  socket.on("set_player", ({ playerId }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = getRoom(roomId);
    const client = room.clients.get(socket.id);
    if (!client) return;

    // allow only existing player ids
    const exists = room.state.players.some((p) => p.id === playerId);
    if (!exists) {
      socket.emit("error_msg", "Ungültiger Spieler.");
      return;
    }

    client.playerId = playerId;
    room.clients.set(socket.id, client);
    socket.emit("info_msg", "Spieler verknüpft.");
  });

  // -------- Host actions --------
  socket.on("host_add_player", ({ name }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!ensureHost(room, socket)) return;

    const trimmed = String(name || "").trim();
    if (!trimmed) return;

    const id = crypto.randomUUID();
    room.state.players.push({ id, name: trimmed, score: 0 });

    // set default answering player
    if (!room.state.answeringPlayerId) room.state.answeringPlayerId = id;

    broadcastState(roomId);
  });

  socket.on("host_remove_player", ({ playerId }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!ensureHost(room, socket)) return;

    room.state.players = room.state.players.filter((p) => p.id !== playerId);

    if (room.state.answeringPlayerId === playerId) room.state.answeringPlayerId = null;
    if (room.state.buzz.selectedPlayerId === playerId) room.state.buzz.selectedPlayerId = null;
    room.state.buzz.queue = room.state.buzz.queue.filter((x) => x.playerId !== playerId);

    // unlink from clients
    for (const [sid, c] of room.clients.entries()) {
      if (c.playerId === playerId) c.playerId = null;
      room.clients.set(sid, c);
    }

    broadcastState(roomId);
  });

  socket.on("host_set_answering", ({ playerId }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!ensureHost(room, socket)) return;

    const exists = room.state.players.some((p) => p.id === playerId);
    if (!exists) return;

    room.state.answeringPlayerId = playerId;
    broadcastState(roomId);
  });

  socket.on("host_open_clue", ({ clueId }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!ensureHost(room, socket)) return;

    const found = findClue(room.state, clueId);
    if (!found || found.clue.used) return;

    room.state.overlay.open = true;
    room.state.overlay.clueId = clueId;

    // reset buzz
    room.state.buzz.active = false;
    room.state.buzz.queue = [];
    room.state.buzz.selectedPlayerId = null;

    // default answering
    if (!room.state.answeringPlayerId && room.state.players[0]) {
      room.state.answeringPlayerId = room.state.players[0].id;
    }

    broadcastState(roomId);
  });

  socket.on("host_close_overlay", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!ensureHost(room, socket)) return;

    room.state.overlay.open = false;
    room.state.overlay.clueId = null;
    broadcastState(roomId);
  });

  socket.on("host_mark_correct", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!ensureHost(room, socket)) return;

    const clueId = room.state.overlay.clueId;
    if (!room.state.overlay.open || !clueId) return;

    const found = findClue(room.state, clueId);
    if (!found) return;

    const pid = room.state.buzz.active ? room.state.buzz.selectedPlayerId : room.state.answeringPlayerId;
    if (!pid) return;

    const player = room.state.players.find((p) => p.id === pid);
    if (!player) return;

    player.score += found.clue.value;
    found.clue.used = true;

    // close overlay + reset buzz
    room.state.overlay.open = false;
    room.state.overlay.clueId = null;
    room.state.buzz.active = false;
    room.state.buzz.queue = [];
    room.state.buzz.selectedPlayerId = null;

    broadcastState(roomId);
  });

  socket.on("host_mark_wrong", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!ensureHost(room, socket)) return;

    const clueId = room.state.overlay.clueId;
    if (!room.state.overlay.open || !clueId) return;

    const found = findClue(room.state, clueId);
    if (!found) return;

    const pid = room.state.buzz.active ? room.state.buzz.selectedPlayerId : room.state.answeringPlayerId;
    if (!pid) return;

    const player = room.state.players.find((p) => p.id === pid);
    if (!player) return;

    const penalty = Math.floor(found.clue.value / 2);
    player.score -= penalty;

    // start buzz
    room.state.buzz.active = true;
    room.state.buzz.queue = [];
    room.state.buzz.selectedPlayerId = null;

    broadcastState(roomId);
  });

  socket.on("host_select_buzzed_first", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!ensureHost(room, socket)) return;

    if (!room.state.buzz.queue.length) return;

    const sorted = room.state.buzz.queue.slice().sort((a, b) => a.at - b.at);
    room.state.buzz.selectedPlayerId = sorted[0].playerId;
    room.state.answeringPlayerId = room.state.buzz.selectedPlayerId;

    broadcastState(roomId);
  });

  socket.on("host_clear_buzz", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = getRoom(roomId);
    if (!ensureHost(room, socket)) return;

    room.state.buzz.queue = [];
    room.state.buzz.selectedPlayerId = null;
    broadcastState(roomId);
  });

  // -------- Audience/Player actions --------
  socket.on("buzz", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = getRoom(roomId);

    if (!room.state.buzz.active) return;

    const client = room.clients.get(socket.id);
    const pid = client?.playerId;
    if (!pid) {
      socket.emit("error_msg", "Du musst erst einen Spieler auswählen (rechts im Overlay/Panel).");
      return;
    }

    // no duplicates
    if (room.state.buzz.queue.some((x) => x.playerId === pid)) return;

    room.state.buzz.queue.push({ playerId: pid, at: Date.now() });
    broadcastState(roomId);
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = getRoom(roomId);

    room.clients.delete(socket.id);

    // release host if host disconnected
    if (room.hostSocketId === socket.id) {
      room.hostSocketId = null;
      // (Optional) auto-promote: first client that calls join as host will become host.
      io.to(roomId).emit("info_msg", "Host hat den Raum verlassen. Ein neuer Host kann beitreten.");
    }

    // cleanup room if empty
    if (room.clients.size === 0) {
      rooms.delete(roomId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});