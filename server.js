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
 *   history: Array<{ id: string, by: string, name: string, value: 1|2|3|4|5|6, time: number }>,
 *   turn: socketId|null, // SELALU mengarah ke USER atau null
 * }
 */
const rooms = new Map();

const genCode = () => Math.random().toString(36).slice(2, 6).toUpperCase();
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

const publicRoomState = (room) => ({
  code: room.code,
  players: [...room.players.entries()].map(([id, p]) => ({ id, name: p.name, role: p.role })),
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

// Helper: daftar USER saja (berdasarkan urutan join)
function userIds(room){
  return [...room.players.entries()].filter(([,p]) => p.role === 'user').map(([id]) => id);
}
function firstUser(room){
  const ids = userIds(room);
  return ids[0] || null;
}
function nextUserAfter(room, currentId){
  const ids = userIds(room);
  if (ids.length === 0) return null;
  const idx = ids.indexOf(currentId);
  if (idx === -1) return ids[0];
  return ids[(idx + 1) % ids.length];
}

io.on('connection', (socket) => {
  // ADMIN: Buat room (hanya tersedia di UI admin.html)
  socket.on('room:create', ({ name }, cb) => {
    const clean = (name||'').trim();
    if (!clean) return cb?.({ ok:false, error:'Nama wajib diisi' });

    let code; do { code = genCode(); } while (rooms.has(code));
    const room = { code, players: new Map(), history: [], turn: null };
    rooms.set(code, room);

    socket.join(code);
    room.players.set(socket.id, { name: clean, role: 'admin', joinedAt: Date.now() });
    // ⛔ turn awal = null (admin tidak pernah memegang turn)

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
    if (!room.turn) room.turn = socket.id; // user pertama otomatis dapat giliran

    cb?.({ ok:true, code, state: publicRoomState(room) });
    io.to(code).emit('room:update', publicRoomState(room));
  });

  // ROLL: hanya boleh oleh USER dan jika saat ini adalah gilirannya
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

    // ➡️ Giliran pindah ke USER berikutnya (admin SKIP)
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

    room.turn = playerId;
    io.to(room.code).emit('room:update', publicRoomState(room));
    cb?.({ ok:true });
  });

  // ADMIN: kick user dari room
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

    // jika yang di-kick adalah pemegang giliran → alihkan ke user berikutnya
    if (room.turn === playerId) room.turn = nextUserAfter(room, playerId);

    if (room.players.size === 0) rooms.delete(room.code);
    else io.to(room.code).emit('room:update', publicRoomState(room));

    cb?.({ ok:true });
  });

  // Keluar room (manual)
  socket.on('room:leave', () => {
    const room = getRoomOf(socket);
    if (!room) return;

    const leavingInfo = room.players.get(socket.id);
    socket.leave(room.code);
    room.players.delete(socket.id);

    // Jika yang keluar memegang turn → alihkan ke user berikutnya
    if (room.turn === socket.id) room.turn = nextUserAfter(room, socket.id);

    // Jika admin keluar dan tidak ada turn (mis. belum ada user) → tetap null
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

      if (wasTurn) room.turn = nextUserAfter(room, socket.id);

      // Jika setelah perubahan tidak ada turn tapi masih ada user → beri ke user pertama
      if (!room.turn) room.turn = firstUser(room);

      if (room.players.size === 0) rooms.delete(code);
      else io.to(code).emit('room:update', publicRoomState(room));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server jalan di http://localhost:${PORT}`));