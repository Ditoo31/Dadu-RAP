const socket = io();
let me = { id: null, name: null, room: null };

const $ = (sel) => document.querySelector(sel);
const playersEl = $('#players');
const codeEl = $('#room-code');
const turnEl = $('#turn-name');
const historyEl = $('#history');
const cube = $('#cube');
const rollBtn = $('#roll');

// Join
$('#btn-join').addEventListener('click', () => {
  const name = ($('#join-name').value || '').trim();
  const code = ($('#join-code').value || '').trim().toUpperCase();
  if (!name || !code) return alert('Isi nama dan kode room');
  me.name = name;
  socket.emit('room:join', { code, name }, (res) => {
    if (!res?.ok) return alert(res?.error || 'Gagal join');
    onJoined(res.code, res.state);
  });
});

$('#leave').addEventListener('click', () => {
  socket.emit('room:leave');
  restoreAuth();
});

function restoreAuth(){
  document.getElementById('auth').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  me = { id: socket.id, name: me.name, room: null };
}

function onJoined(code, state){
  me.id = socket.id;
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
    li.innerHTML = `<span>${p.name}${p.id===socket.id?' (kamu)':''} <span class="role ${p.role==='admin'?'admin':''}">• ${p.role}</span></span>` +
                   `<span class="badge ${state.turn===p.id?'warn':''}">${state.turn===p.id?'Giliran':''}</span>`;
    playersEl.appendChild(li);
  });

  const turnPlayer = state.players.find(p => p.id === state.turn);
  turnEl.textContent = turnPlayer ? turnPlayer.name : '—';

  // riwayat
  historyEl.innerHTML = '';
  state.history.forEach(h => addHistory(h.name, h.value, h.time));

  // tombol roll aktif hanya saat giliran user ini
  rollBtn.disabled = (state.turn !== socket.id);
}

function addHistory(name, value, time){
  const li = document.createElement('li');
  const t = new Date(time).toLocaleTimeString();
  li.innerHTML = `<span><strong>${name}</strong> melempar → <strong>${value}</strong></span><span class="muted">${t}</span>`;
  historyEl.appendChild(li);
}

// Animasi dadu
const faces = ['show-1','show-2','show-3','show-4','show-5','show-6'];
function animateTo(value){
  cube.classList.add('rolling');
  rollBtn.disabled = true;
  setTimeout(() => {
    cube.classList.remove('rolling');
    faces.forEach(c => cube.classList.remove(c));
    cube.classList.add(`show-${value}`);
  }, 820);
}

rollBtn.addEventListener('click', () => {
  rollBtn.disabled = true;
  socket.emit('roll', null, (res) => {
    if (!res?.ok) {
      alert(res?.error || 'Gagal roll');
      rollBtn.disabled = false;
    }
  });
});

// Socket
socket.on('connect', () => { me.id = socket.id; });

socket.on('room:update', (state) => updateRoom(state));

socket.on('rolled', ({ value, name, time, turn }) => {
  animateTo(value);
  addHistory(name, value, time);
  if (turn === socket.id) rollBtn.disabled = false;
});

// Jika di-kick oleh admin
socket.on('kicked', ({ code, by }) => {
  alert('Anda di-kick oleh Admin ' );
  restoreAuth();
});