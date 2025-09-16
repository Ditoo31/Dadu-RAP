const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

/**
 * Struktur room (in-memory):
 * room: {
 *   code: string,
 *   players: Map<socketId, { name: string, role: 'admin'|'user', joinedAt: number }>,
 *   userOrder: string[], // urutan lempar untuk USER saja (array socketId)
 *   history: Array<{ id: string, by: string, name: string, value: 1|2|3|4|5|6, time: number }>,
 *   turn: socketId|null, // SELALU menunjuk ke USER atau null
 * }
 */
const rooms = new Map();

const genCode = () => Math.random().toString(36).slice(2, 6).toUpperCase();
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

const publicRoomState = (room) => ({
  code: room.code,
  players: [...room.players.entries()].map(([id, p]) => ({ id, name: p.name, role: p.role })),
  userOrder: room.userOrder.slice(),
  turn: room.turn,
  history: room.history.slice(0, 20)
});

const getRoomOf = (socket) => {
  for (const code of socket.rooms) {
    if (code === socket.id) continue;
    if (rooms.has(code)) return rooms.get(code);
  }
  return null;
};

// Helper urutan user
function cleanupUserOrder(room){
  // Jaga agar userOrder hanya berisi id yg masih ada & role user, tanpa duplikat
  const set = new Set();
  room.userOrder = room.userOrder.filter((id) => {
    if (!room.players.has(id)) return false;
    if (room.players.get(id).role !== 'user') return false;
    if (set.has(id)) return false;
    set.add(id);
    return true;
  });
}
function firstUser(room){
  cleanupUserOrder(room);
  return room.userOrder[0] || null;
}
function nextUserAfter(room, currentId){
  cleanupUserOrder(room);
  const ids = room.userOrder;
  if (ids.length === 0) return null;
  const idx = ids.indexOf(currentId);
  if (idx === -1) return ids[0];
  return ids[(idx + 1) % ids.length];
}
function removeFromUserOrder(room, id){
  room.userOrder = room.userOrder.filter((x) => x !== id);
}
function moveUser(room, playerId, direction){
  cleanupUserOrder(room);
  const idx = room.userOrder.indexOf(playerId);
  if (idx === -1) return false;
  if (direction === 'up' && idx > 0){
    [room.userOrder[idx - 1], room.userOrder[idx]] = [room.userOrder[idx], room.userOrder[idx - 1]];
    return true;
  }
  if (direction === 'down' && idx < room.userOrder.length - 1){
    [room.userOrder[idx + 1], room.userOrder[idx]] = [room.userOrder[idx], room.userOrder[idx + 1]];
    return true;
  }
  return false;
}

io.on('connection', (socket) => {
  // ADMIN: Buat room
  socket.on('room:create', ({ name }, cb) => {
    const clean = (name||'').trim();
    if (!clean) return cb?.({ ok:false, error:'Nama wajib diisi' });

    let code; do { code = genCode(); } while (rooms.has(code));
    const room = { code, players: new Map(), userOrder: [], history: [], turn: null };
    rooms.set(code, room);

    socket.join(code);
    room.players.set(socket.id, { name: clean, role: 'admin', joinedAt: Date.now() });
    // turn awal null (admin tidak pernah memegang turn)

    cb?.({ ok:true, code, state: publicRoomState(room) });
    io.to(code).emit('room:update', publicRoomState(room));
  });

  // USER: Join room
  socket.on('room:join', ({ code, name }, cb) => {
    code = (code||'').toUpperCase();
    const clean = (name||'').trim();
    const room = rooms.get(code);
    if (!room) return cb?.({ ok:false, error:'Room tidak ditemukan' });
    if (!clean) return cb?.({ ok:false, error:'Nama wajib diisi' });

    socket.join(code);
    room.players.set(socket.id, { name: clean, role: 'user', joinedAt: Date.now() });
    room.userOrder.push(socket.id);
    if (!room.turn) room.turn = socket.id; // user pertama otomatis dapat giliran

    cb?.({ ok:true, code, state: publicRoomState(room) });
    io.to(code).emit('room:update', publicRoomState(room));
  });

  // ROLL: hanya USER dan jika saat ini gilirannya
  socket.on('roll', (_, cb) => {
    const room = getRoomOf(socket);
    if (!room) return cb?.({ ok:false, error:'Anda belum berada di room' });
    const me = room.players.get(socket.id);
    if (!me || me.role !== 'user') return cb?.({ ok:false, error:'Hanya user yang boleh melempar dadu' });
    if (room.turn !== socket.id) return cb?.({ ok:false, error:'Belum giliran Anda' });

    const value = 1 + Math.floor(Math.random() * 6);
    const byName = me.name || 'Pemain';
    const entry = { id: uid(), by: socket.id, name: byName, value, time: Date.now() };
    room.history.unshift(entry);

    // pindah ke USER berikutnya berdasarkan userOrder
    room.turn = nextUserAfter(room, socket.id);

    io.to(room.code).emit('rolled', { value, by: socket.id, name: byName, time: entry.time, turn: room.turn });
    io.to(room.code).emit('room:update', publicRoomState(room));
    cb?.({ ok:true, value });
  });

  // ADMIN: pilih siapa yang dapat melempar (set giliran)
  socket.on('admin:setTurn', ({ playerId }, cb) => {
    const room = getRoomOf(socket);
    if (!room) return cb?.({ ok:false, error:'Tidak di room' });
    const me = room.players.get(socket.id);
    if (!me || me.role !== 'admin') return cb?.({ ok:false, error:'Hanya admin' });

    const target = room.players.get(playerId);
    if (!target) return cb?.({ ok:false, error:'Pemain tidak ditemukan' });
    if (target.role !== 'user') return cb?.({ ok:false, error:'Hanya user yang bisa diberi giliran' });

    // pastikan target ada di userOrder
    if (!room.userOrder.includes(playerId)) room.userOrder.push(playerId);

    room.turn = playerId;
    io.to(room.code).emit('room:update', publicRoomState(room));
    cb?.({ ok:true });
  });

  // ✅ ADMIN: pindahkan posisi user (atur urutan lempar)
  socket.on('admin:moveUser', ({ playerId, direction }, cb) => {
    const room = getRoomOf(socket);
    if (!room) return cb?.({ ok:false, error:'Tidak di room' });
    const me = room.players.get(socket.id);
    if (!me || me.role !== 'admin') return cb?.({ ok:false, error:'Hanya admin' });

    const target = room.players.get(playerId);
    if (!target || target.role !== 'user') return cb?.({ ok:false, error:'Hanya user yang bisa dipindah' });

    const ok = moveUser(room, playerId, direction);
    if (!ok) return cb?.({ ok:false, error:'Tidak bisa dipindah (batas atas/bawah?)' });

    io.to(room.code).emit('room:update', publicRoomState(room));
    cb?.({ ok:true });
  });

  // ADMIN: kick user
  socket.on('admin:kick', ({ playerId }, cb) => {
    const room = getRoomOf(socket);
    if (!room) return cb?.({ ok:false, error:'Tidak di room' });
    const me = room.players.get(socket.id);
    if (!me || me.role !== 'admin') return cb?.({ ok:false, error:'Hanya admin' });
    if (!room.players.has(playerId)) return cb?.({ ok:false, error:'Pemain tidak ditemukan' });
    if (playerId === socket.id) return cb?.({ ok:false, error:'Admin tidak bisa kick dirinya sendiri' });
    if (room.players.get(playerId)?.role === 'admin') return cb?.({ ok:false, error:'Tidak bisa kick admin' });

    const target = io.sockets.sockets.get(playerId);
    if (target) {
      target.leave(room.code);
      target.emit('kicked', { code: room.code, by: socket.id });
    }
    room.players.delete(playerId);
    removeFromUserOrder(room, playerId);

    // jika yang di-kick memegang giliran → alihkan ke user berikutnya
    if (room.turn === playerId) room.turn = nextUserAfter(room, playerId);

    if (room.players.size === 0) rooms.delete(room.code);
    else io.to(room.code).emit('room:update', publicRoomState(room));

    cb?.({ ok:true });
  });

  // Keluar room (manual)
  socket.on('room:leave', () => {
    const room = getRoomOf(socket);
    if (!room) return;

    const leaving = room.players.get(socket.id);
    socket.leave(room.code);
    room.players.delete(socket.id);
    if (leaving?.role === 'user') removeFromUserOrder(room, socket.id);

    if (room.turn === socket.id) room.turn = nextUserAfter(room, socket.id);

    if (!room.turn) room.turn = firstUser(room);

    if (room.players.size === 0) rooms.delete(room.code);
    else io.to(room.code).emit('room:update', publicRoomState(room));
  });

  // Putus koneksi
  socket.on('disconnecting', () => {
    for (const code of socket.rooms) {
      if (code === socket.id) continue;
      const room = rooms.get(code);
      if (!room) continue;

      const wasTurn = room.turn === socket.id;
      const leaving = room.players.get(socket.id);
      room.players.delete(socket.id);
      if (leaving?.role === 'user') removeFromUserOrder(room, socket.id);

      if (wasTurn) room.turn = nextUserAfter(room, socket.id);
      if (!room.turn) room.turn = firstUser(room);

      if (room.players.size === 0) rooms.delete(code);
      else io.to(code).emit('room:update', publicRoomState(room));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server jalan di http://localhost:${PORT}`));