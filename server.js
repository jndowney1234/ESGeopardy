const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3001;
const ROOM_CODE_LENGTH = 4;
const SLOT_IDS = ['contestant-1', 'contestant-2', 'contestant-3'];
const SLOT_KEYS = {
  'contestant-1': '1',
  'contestant-2': '2',
  'contestant-3': '3',
};

const server = http.createServer();
const wss = new WebSocket.Server({ server });

const rooms = new Map();

function sanitizeRoomCode(value) {
  if (!value) return '';
  const digits = String(value).replace(/[^0-9]/g, '');
  if (digits.length < ROOM_CODE_LENGTH) return '';
  return digits.slice(0, ROOM_CODE_LENGTH);
}

function sanitizeName(value) {
  if (!value) return '';
  return String(value).replace(/[\r\n]+/g, ' ').trim().slice(0, 40);
}

function generateRoomCode() {
  const min = Math.pow(10, ROOM_CODE_LENGTH - 1);
  const max = Math.pow(10, ROOM_CODE_LENGTH) - 1;
  return String(Math.floor(Math.random() * (max - min + 1)) + min);
}

function generateClientId() {
  return Math.random().toString(36).slice(2, 10);
}

function createRoom(code) {
  const room = {
    code,
    host: null,
    contestants: new Map(), // clientId -> { ws, name, slotId }
    slots: new Map(),
    buzzersOpen: false,
    activeResponder: null,
    pendingJoins: new Map(), // requestId -> { ws, name }
  };
  SLOT_IDS.forEach(slotId => room.slots.set(slotId, null));
  rooms.set(code, room);
  return room;
}

function getRoom(code) {
  return rooms.get(code);
}

function ensureRoom(code) {
  return rooms.get(code) || createRoom(code);
}

function send(ws, data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(data));
  } catch (err) {
    console.warn('Failed to send message', err);
  }
}

function broadcastToContestants(room, payload) {
  if (!room) return;
  room.contestants.forEach(entry => {
    send(entry.ws, payload);
  });
}

function notifyJoinRequestRemoval(room, requestId, reason) {
  if (!room || !room.host || room.host.readyState !== WebSocket.OPEN) return;
  send(room.host, { type: 'contestant-request-removed', requestId, reason });
}

function clearPendingRequests(room, reason) {
  if (!room) return;
  room.pendingJoins.forEach(({ ws: clientWs }) => {
    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
      clientWs.pendingRequestId = null;
      send(clientWs, {
        type: 'join-denied',
        message: reason || 'Host disconnected. Try joining again soon.',
      });
      try { clientWs.close(); } catch (err) { /* ignore */ }
    }
  });
  room.pendingJoins.clear();
}

function assignSlot(room, name, ws) {
  for (const slotId of SLOT_IDS) {
    if (!room.slots.get(slotId)) {
      const clientId = generateClientId();
      room.slots.set(slotId, { clientId, name });
      room.contestants.set(clientId, { ws, name, slotId });
      return { slotId, clientId };
    }
  }
  return null;
}

function resetRoomState(room) {
  if (!room) return;
  room.buzzersOpen = false;
  room.activeResponder = null;
  room.slots.forEach((value, slotId) => {
    if (!value) room.slots.set(slotId, null);
  });
}

function handleRegisterHost(ws, message) {
  const providedCode = sanitizeRoomCode(message.roomCode) || generateRoomCode();
  const room = ensureRoom(providedCode);

  if (room.host && room.host !== ws) {
    try {
      send(room.host, { type: 'room-closed', message: 'Host replaced.' });
      room.host.close();
    } catch (err) {
      /* ignore */
    }
  }

  room.host = ws;
  resetRoomState(room);

  // Notify existing contestants that the host has restarted
  room.contestants.forEach(({ ws: clientWs }) => {
    send(clientWs, { type: 'room-closed', message: 'Host reconnected. Please rejoin.' });
    try { clientWs.close(); } catch (err) { /* ignore */ }
  });
  room.contestants.clear();
  room.slots.forEach((_, slotId) => room.slots.set(slotId, null));
  clearPendingRequests(room, 'Host restarted the room. Please request to join again.');

  ws.isHost = true;
  ws.roomCode = room.code;

  send(ws, { type: 'host-registered', roomCode: room.code });
}

function handleBroadcast(ws, message) {
  const room = getRoom(ws.roomCode);
  if (!room || room.host !== ws || !message.payload) return;
  broadcastToContestants(room, { type: 'sync', payload: message.payload });
}

function handleBuzzersState(ws, message) {
  const room = getRoom(ws.roomCode);
  if (!room || room.host !== ws || !message.payload) return;
  room.buzzersOpen = !!message.payload.open;
  if (room.buzzersOpen) {
    room.activeResponder = null;
  }
  broadcastToContestants(room, { type: 'buzzers-state', payload: { open: room.buzzersOpen, message: message.payload.message || '' } });
}

function handleBuzzResult(ws, message) {
  const room = getRoom(ws.roomCode);
  if (!room || room.host !== ws || !message.payload) return;
  room.activeResponder = message.payload.contestantId || null;
  const payload = {
    contestantId: message.payload.contestantId,
    name: message.payload.name,
  };
  broadcastToContestants(room, { type: 'buzz-result', payload });
}

function handleJoinContestant(ws, message) {
  const code = sanitizeRoomCode(message.roomCode);
  const room = getRoom(code);
  const name = sanitizeName(message.payload && message.payload.name);
  if (!room || !room.host || room.host.readyState !== WebSocket.OPEN) {
    send(ws, { type: 'join-denied', message: 'Room not found. Ask the host for a new code.' });
    return;
  }
  ws.roomCode = room.code;
  const existingRequest = ws.pendingRequestId && room.pendingJoins.get(ws.pendingRequestId);
  if (existingRequest) {
    // update name if changed
    existingRequest.name = name || existingRequest.name;
    room.pendingJoins.set(ws.pendingRequestId, existingRequest);
    return;
  }
  const requestId = generateClientId();
  room.pendingJoins.set(requestId, {
    ws,
    name: name || 'Contestant',
  });
  ws.pendingRequestId = requestId;
  send(ws, { type: 'join-pending', requestId });
  if (room.host && room.host.readyState === WebSocket.OPEN) {
    send(room.host, {
      type: 'contestant-requested',
      requestId,
      name: name || 'Contestant',
      requestedAt: Date.now(),
    });
  }
}

function handleApproveContestant(ws, message) {
  const room = getRoom(ws.roomCode);
  if (!room || room.host !== ws || !message || typeof message !== 'object') return;
  const payload = message.payload || {};
  const requestId = payload.requestId || message.requestId;
  if (!requestId) return;
  const request = room.pendingJoins.get(requestId);
  if (!request) {
    send(ws, { type: 'contestant-request-error', requestId, message: 'Request no longer available.' });
    return;
  }
  room.pendingJoins.delete(requestId);
  const contestantWs = request.ws;
  const name = request.name || 'Contestant';
  if (!contestantWs || contestantWs.readyState !== WebSocket.OPEN) {
    notifyJoinRequestRemoval(room, requestId, 'left');
    return;
  }
  const assignment = assignSlot(room, name, contestantWs);
  if (!assignment) {
    contestantWs.pendingRequestId = null;
    send(contestantWs, { type: 'join-denied', message: 'All contestant slots are full. Ask the host to free a slot and try again.' });
    notifyJoinRequestRemoval(room, requestId, 'full');
    return;
  }

  contestantWs.isContestant = true;
  contestantWs.roomCode = room.code;
  contestantWs.clientId = assignment.clientId;
  contestantWs.pendingRequestId = null;

  send(contestantWs, {
    type: 'join-accepted',
    slotId: assignment.slotId,
    clientId: assignment.clientId,
    key: SLOT_KEYS[assignment.slotId] || '',
    name,
  });

  notifyJoinRequestRemoval(room, requestId, 'approved');

  if (room.host && room.host.readyState === WebSocket.OPEN) {
    send(room.host, {
      type: 'contestant-joined',
      slotId: assignment.slotId,
      clientId: assignment.clientId,
      name,
    });
  }
}

function handleDenyContestant(ws, message) {
  const room = getRoom(ws.roomCode);
  if (!room || room.host !== ws || !message || typeof message !== 'object') return;
  const payload = message.payload || {};
  const requestId = payload.requestId || message.requestId;
  if (!requestId) return;
  const request = room.pendingJoins.get(requestId);
  if (!request) {
    send(ws, { type: 'contestant-request-error', requestId, message: 'Request no longer available.' });
    return;
  }
  room.pendingJoins.delete(requestId);
  const contestantWs = request.ws;
  if (contestantWs && contestantWs.readyState === WebSocket.OPEN) {
    contestantWs.pendingRequestId = null;
    send(contestantWs, { type: 'join-denied', message: 'Host declined your request.' });
  }
  notifyJoinRequestRemoval(room, requestId, 'denied');
}

function handleContestantBuzz(ws, message) {
  const room = getRoom(ws.roomCode);
  if (!room || !message.payload) return;
  const { slotId, clientId, name } = message.payload;
  if (!slotId || !clientId) return;
  const slot = room.slots.get(slotId);
  if (!slot || slot.clientId !== clientId) return;
  if (!room.buzzersOpen || !room.host || room.host.readyState !== WebSocket.OPEN) {
    send(ws, { type: 'buzzers-state', payload: { open: false, message: 'Buzzers locked.' } });
    return;
  }
  if (room.activeResponder) {
    send(ws, { type: 'buzz-result', payload: { contestantId: room.activeResponder } });
    return;
  }
  send(room.host, { type: 'contestant-buzz', slotId, clientId, name });
}

function handleMessage(ws, raw) {
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return;
  }
  if (!data || typeof data !== 'object') return;
  const action = data.action;
  if (action === 'register-host') {
    handleRegisterHost(ws, data);
    return;
  }
  if (action === 'join-contestant') {
    handleJoinContestant(ws, data);
    return;
  }
  if (!ws.roomCode) return;
  switch (action) {
    case 'broadcast':
      handleBroadcast(ws, data);
      break;
    case 'buzzers-state':
      handleBuzzersState(ws, data);
      break;
    case 'buzz-result':
      handleBuzzResult(ws, data);
      break;
    case 'contestant-buzz':
      handleContestantBuzz(ws, data);
      break;
    case 'approve-contestant':
      handleApproveContestant(ws, data);
      break;
    case 'deny-contestant':
      handleDenyContestant(ws, data);
      break;
    default:
      break;
  }
}

wss.on('connection', (ws) => {
  ws.isHost = false;
  ws.isContestant = false;
  ws.roomCode = null;
  ws.clientId = null;
  ws.pendingRequestId = null;

  ws.on('message', (message) => handleMessage(ws, message));

  ws.on('close', () => {
    if (ws.isHost && ws.roomCode) {
      const room = getRoom(ws.roomCode);
      if (room && room.host === ws) {
        broadcastToContestants(room, { type: 'room-closed', message: 'Host disconnected. Please wait.' });
        room.contestants.forEach(({ ws: clientWs }) => {
          try { clientWs.close(); } catch (err) { /* ignore */ }
        });
        room.contestants.clear();
        room.slots.forEach((_, slotId) => room.slots.set(slotId, null));
        room.host = null;
        room.buzzersOpen = false;
        room.activeResponder = null;
        clearPendingRequests(room, 'Host disconnected. Try joining again soon.');
      }
    } else if (ws.roomCode) {
      const room = getRoom(ws.roomCode);
      if (!room) return;
      if (ws.pendingRequestId && room.pendingJoins.has(ws.pendingRequestId)) {
        room.pendingJoins.delete(ws.pendingRequestId);
        notifyJoinRequestRemoval(room, ws.pendingRequestId, 'left');
      }
      if (ws.isContestant && ws.clientId && room.contestants.has(ws.clientId)) {
        const entry = room.contestants.get(ws.clientId);
        room.contestants.delete(ws.clientId);
        const slotId = entry && entry.slotId ? entry.slotId : null;
        if (slotId && room.slots.get(slotId) && room.slots.get(slotId).clientId === ws.clientId) {
          room.slots.set(slotId, null);
        } else {
          room.slots.forEach((value, id) => {
            if (value && value.clientId === ws.clientId) {
              room.slots.set(id, null);
            }
          });
        }
        if (room.host && room.host.readyState === WebSocket.OPEN) {
          send(room.host, { type: 'contestant-left', slotId, clientId: ws.clientId });
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Realtime buzzer server listening on ws://0.0.0.0:${PORT}`);
});
