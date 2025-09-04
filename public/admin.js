const socket = io();
let me = { id: null, name: null, room: null };

const $ = (sel) => document.querySelector(sel);
const playersEl = $('#players');
const adminPlayersEl = $('#admin-players');
const codeEl = $('#room-code');
const turnEl = $('#turn-name');
const historyEl = $('#history');
const cube = $('#cube');

// Auth
$('#btn-create').addEventListener('click', () => {
  const name = ($('#create-name').value || '').trim();
  if (!name) return alert('Isi nama admin');
  me.name = name;
  socket.emit('room:create', { name }, (res) => {
    if (!res?.ok) return alert(res?.error || 'Gagal membuat room');
    onJoined(res.code, res.state);
  });
});

$('#copy-code').addEventListener('click', async () => {
  if (!me.room) return;
  await navigator.clipboard.writeText(me.room);
  const btn = document.getElementById('copy-code');
  btn.textContent = 'Disalin!';
  setTimeout(() => (btn.textContent = 'Salin'), 1000);
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
  // daftar pemain (publik)
  playersEl.innerHTML = '';
  state.players.forEach(p => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${p.name} <span class="role ${p.role==='admin'?'admin':''}">• ${p.role}</span></span>` +
                   `<span class="badge ${state.turn===p.id?'warn':''}">${state.turn===p.id?'Giliran':''}</span>`;
    playersEl.appendChild(li);
  });

  // kontrol admin (set turn + kick)
  adminPlayersEl.innerHTML = '';
  state.players.forEach(p => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${p.name}${p.id===socket.id?' (kamu)':''}</span>`;

    const setBtn = document.createElement('button');
    setBtn.textContent = state.turn===p.id ? 'Sedang Giliran' : 'Jadikan Giliran';
    setBtn.disabled = state.turn===p.id || p.role !== 'user';
    setBtn.title = p.role !== 'user' ? 'Hanya user yang bisa diberi giliran' : '';
    setBtn.addEventListener('click', () => {
      socket.emit('admin:setTurn', { playerId: p.id }, (res) => {
        if (!res?.ok) alert(res?.error || 'Gagal set giliran');
      });
    });
    li.appendChild(setBtn);

    if (p.role !== 'admin') {
      const kickBtn = document.createElement('button');
      kickBtn.textContent = 'Kick';
      kickBtn.style.marginLeft = '8px';
      kickBtn.addEventListener('click', () => {
        if (!confirm(`Kick ${p.name}?`)) return;
        socket.emit('admin:kick', { playerId: p.id }, (res) => {
          if (!res?.ok) alert(res?.error || 'Gagal kick');
        });
      });
      li.appendChild(kickBtn);
    }

    adminPlayersEl.appendChild(li);
  });

  const turnPlayer = state.players.find(p => p.id === state.turn);
  turnEl.textContent = turnPlayer ? turnPlayer.name : '—';

  // riwayat
  historyEl.innerHTML = '';
  state.history.forEach(h => addHistory(h.name, h.value, h.time));
}

function addHistory(name, value, time){
  const li = document.createElement('li');
  const t = new Date(time).toLocaleTimeString();
  li.innerHTML = `<span><strong>${name}</strong> melempar → <strong>${value}</strong></span><span class="muted">${t}</span>`;
  historyEl.appendChild(li);
}

// Animasi dadu (untuk visualisasi saat user me-roll)
const faces = ['show-1','show-2','show-3','show-4','show-5','show-6'];
function animateTo(value){
  cube.classList.add('rolling');
  setTimeout(() => {
    cube.classList.remove('rolling');
    faces.forEach(c => cube.classList.remove(c));
    cube.classList.add(`show-${value}`);
  }, 820);
}

// Socket
socket.on('connect', () => { me.id = socket.id; });

socket.on('room:update', (state) => updateRoom(state));

socket.on('rolled', ({ value, name, time }) => {
  animateTo(value);
  addHistory(name, value, time);
});