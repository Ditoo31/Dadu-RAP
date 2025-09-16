const socket = io();
let me = { room: null };

const $ = (s) => document.querySelector(s);
const codeEl = $('#room-code');
const turnEl = $('#turn-name');
const playersEl = $('#players');
const historyEl = $('#history');
const cube = $('#cube');
const banner = $('#now-rolling');

$('#btn-view').addEventListener('click', () => {
  const code = ($('#view-code').value || '').trim().toUpperCase();
  if (!code) return alert('Isi kode room');
  socket.emit('room:view', { code }, (res) => {
    if (!res?.ok) return alert(res?.error || 'Gagal join sebagai viewer');
    onJoined(res.code, res.state);
  });
});

$('#leave').addEventListener('click', () => {
  socket.emit('room:leave'); // aman: viewer bukan player, server akan mengabaikan penghapusan player
  restoreAuth();
});

function restoreAuth(){
  document.getElementById('auth').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  me = { room: null };
  banner.classList.remove('show');
  banner.textContent = 'Sedang melempar: —';
}

function onJoined(code, state){
  me.room = code;
  document.getElementById('auth').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  codeEl.textContent = code;
  updateRoom(state);
}

function updateRoom(state){
  // daftar pemain
  playersEl.innerHTML = '';
  state.players.forEach(p => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${p.name} <span class="role ${p.role==='admin'?'admin':''}">• ${p.role}</span></span>` +
                   `<span class="badge ${state.turn===p.id?'warn':''}">${state.turn===p.id?'Giliran':''}</span>`;
    playersEl.appendChild(li);
  });

  const turnPlayer = state.players.find(p => p.id === state.turn);
  turnEl.textContent = turnPlayer ? turnPlayer.name : '—';

  // riwayat terkini
  historyEl.innerHTML = '';
  (state.history || []).forEach(h => addHistory(h.name, h.value, h.time));
}

function addHistory(name, value, time){
  const li = document.createElement('li');
  const t = new Date(time).toLocaleTimeString();
  li.innerHTML = `<span><strong>${name}</strong> melempar → <strong>${value}</strong></span><span class="muted">${t}</span>`;
  historyEl.appendChild(li);
}

// animasi cube
const faces = ['show-1','show-2','show-3','show-4','show-5','show-6'];
function animateTo(value){
  cube.classList.add('rolling');
  setTimeout(() => {
    cube.classList.remove('rolling');
    faces.forEach(c => cube.classList.remove(c));
    cube.classList.add(`show-${value}`);
  }, 820);
}

// socket updates
socket.on('room:update', (state) => updateRoom(state));

// Saat ada hasil roll, tampilkan banner “Sedang melempar: {nama}”
socket.on('rolled', ({ value, name, time, turn }) => {
  banner.textContent = `Sedang melempar: ${name}`;
  banner.classList.add('show');

  animateTo(value);
  addHistory(name, value, time);

  // Sembunyikan banner setelah animasi selesai (~1s)
  setTimeout(() => {
    banner.classList.remove('show');
  }, 1000);

  // turn selanjutnya akan tampil via room:update berikutnya
});
