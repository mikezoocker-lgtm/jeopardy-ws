// public/app.js
// Jeopardy WS Client (Host/Audience) - Socket.IO

console.log("APP STARTED");

let socket = null;
let state = null;
let roomId = null;
let role = "audience";
let isHost = false;

const connInfo = document.getElementById("connInfo");

// Join UI
const joinOverlay = document.getElementById("joinOverlay");
const roomInput = document.getElementById("roomInput");
const roleSelect = document.getElementById("roleSelect");
const nameInput = document.getElementById("nameInput");
const joinBtn = document.getElementById("joinBtn");
const joinMsg = document.getElementById("joinMsg");

// Player UI
const hostPlayerControls = document.getElementById("hostPlayerControls");
const newPlayerName = document.getElementById("newPlayerName");
const addPlayerBtn = document.getElementById("addPlayerBtn");
const playersList = document.getElementById("playersList");

// My player mapping
const myPlayerSelect = document.getElementById("myPlayerSelect");
const saveMyPlayerBtn = document.getElementById("saveMyPlayerBtn");

// Board UI
const boardEl = document.getElementById("board");

// Buzzer UI
const buzzBtn = document.getElementById("buzzBtn");
const buzzStatus = document.getElementById("buzzStatus");
const hostBuzzControls = document.getElementById("hostBuzzControls");
const buzzQueueEl = document.getElementById("buzzQueue");
const selectBuzzedBtn = document.getElementById("selectBuzzedBtn");
const clearBuzzBtn = document.getElementById("clearBuzzBtn");

// QA overlay UI
const qaOverlay = document.getElementById("qaOverlay");
const closeOverlayBtn = document.getElementById("closeOverlayBtn");
const overlayMeta = document.getElementById("overlayMeta");
const overlayQuestion = document.getElementById("overlayQuestion");
const hostAnswerBlock = document.getElementById("hostAnswerBlock");
const overlayAnswer = document.getElementById("overlayAnswer");

const answeringPlayerSelect = document.getElementById("answeringPlayerSelect");
const answeringNote = document.getElementById("answeringNote");
const hostJudgeControls = document.getElementById("hostJudgeControls");
const markCorrectBtn = document.getElementById("markCorrectBtn");
const markWrongBtn = document.getElementById("markWrongBtn");

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setHostUI() {
  document.querySelectorAll(".hostOnly").forEach((el) => {
    el.style.display = isHost ? "" : "none";
  });
  document.querySelectorAll(".audienceOnly").forEach((el) => {
    el.style.display = isHost ? "none" : "";
  });
}

function findClueById(clueId) {
  for (const cat of state.board) {
    for (const clue of cat.clues) {
      if (clue.id === clueId) return { cat, clue };
    }
  }
  return null;
}

function renderPlayers() {
  playersList.innerHTML = "";
  for (const p of state.players) {
    const li = document.createElement("li");
    li.className = "player";

    const left = document.createElement("div");
    left.innerHTML = `<div class="name">${escapeHtml(p.name)}</div>
                      <div class="muted small">ID: ${p.id.slice(0,6)}…</div>`;

    const right = document.createElement("div");
    right.className = "right";
    right.innerHTML = `<div class="score"><strong>${p.score}</strong></div>`;

    if (isHost) {
      const del = document.createElement("button");
      del.textContent = "Löschen";
      del.addEventListener("click", () => {
        socket.emit("host_remove_player", { playerId: p.id });
      });
      right.appendChild(del);
    }

    li.appendChild(left);
    li.appendChild(right);
    playersList.appendChild(li);
  }
}

function renderMyPlayerSelect() {
  myPlayerSelect.innerHTML = "";
  const opt = document.createElement("option");
  opt.value = "";
  opt.textContent = "— ich bin —";
  myPlayerSelect.appendChild(opt);

  for (const p of state.players) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name;
    myPlayerSelect.appendChild(o);
  }
}

function renderAnsweringSelect() {
  if (!isHost) return;

  answeringPlayerSelect.innerHTML = "";
  const optNone = document.createElement("option");
  optNone.value = "";
  optNone.textContent = "— wählen —";
  answeringPlayerSelect.appendChild(optNone);

  for (const p of state.players) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name;
    answeringPlayerSelect.appendChild(o);
  }

  answeringPlayerSelect.value = state.answeringPlayerId || "";

  const buzzSelectedName = state.players.find(p => p.id === state.buzz.selectedPlayerId)?.name;
  const selectedName = state.players.find(p => p.id === state.answeringPlayerId)?.name;

  if (state.buzz.active) {
    answeringNote.textContent = buzzSelectedName
      ? `Buzzer aktiv. Ausgewählt: ${buzzSelectedName}`
      : "Buzzer aktiv. Host wählt aus Queue.";
  } else {
    answeringNote.textContent = selectedName ? `Aktuell: ${selectedName}` : "";
  }
}

function renderBoard() {
  boardEl.innerHTML = "";
  for (const cat of state.board) {
    const catEl = document.createElement("div");
    catEl.className = "cat";

    const header = document.createElement("div");
    header.className = "catHeader";
    header.textContent = cat.title;

    const grid = document.createElement("div");
    grid.className = "cellGrid";

    for (const clue of cat.clues) {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.textContent = clue.value;

      if (clue.used) cell.classList.add("used");
      if (isHost && !clue.used) cell.classList.add("clickable");

      if (isHost && !clue.used) {
        cell.addEventListener("click", () => {
          socket.emit("host_open_clue", { clueId: clue.id });
        });
      }

      grid.appendChild(cell);
    }

    catEl.appendChild(header);
    catEl.appendChild(grid);
    boardEl.appendChild(catEl);
  }
}

function renderBuzz() {
  buzzBtn.disabled = !state.buzz.active;
  buzzStatus.textContent = state.buzz.active ? "Buzzer AKTIV!" : "Buzzer inaktiv.";

  buzzQueueEl.innerHTML = "";
  state.buzz.queue
    .slice()
    .sort((a, b) => a.at - b.at)
    .forEach((entry, idx) => {
      const li = document.createElement("li");
      const name = state.players.find(p => p.id === entry.playerId)?.name || "Unbekannt";
      const selected = state.buzz.selectedPlayerId === entry.playerId ? " (ausgewählt)" : "";
      li.textContent = `${idx + 1}. ${name}${selected}`;
      buzzQueueEl.appendChild(li);
    });
}

function renderOverlay() {
  if (!state.overlay.open || !state.overlay.clueId) {
    qaOverlay.classList.add("hidden");
    return;
  }

  const found = findClueById(state.overlay.clueId);
  if (!found) {
    qaOverlay.classList.add("hidden");
    return;
  }

  const { cat, clue } = found;
  qaOverlay.classList.remove("hidden");

  overlayMeta.textContent = `${cat.title} • ${clue.value} Punkte`;
  overlayQuestion.textContent = clue.question;

  // Antwort nur beim Host einblenden
  overlayAnswer.textContent = clue.answer;
  hostAnswerBlock.style.display = isHost ? "" : "none";

  renderAnsweringSelect();
  renderBuzz();
}

function renderAll() {
  if (!state) return;
  setHostUI();
  renderPlayers();
  renderMyPlayerSelect();
  renderBoard();
  renderBuzz();
  renderOverlay();
}

// -------- events --------
joinBtn.addEventListener("click", () => {
  roomId = String(roomInput.value || "").trim().toUpperCase();
  role = roleSelect.value;
  const displayName = String(nameInput.value || "").trim();

  joinMsg.textContent = "";
  connect(roomId, role, displayName);
});

addPlayerBtn.addEventListener("click", () => {
  socket.emit("host_add_player", { name: newPlayerName.value });
  newPlayerName.value = "";
});

newPlayerName.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addPlayerBtn.click();
});

saveMyPlayerBtn.addEventListener("click", () => {
  const pid = myPlayerSelect.value;
  if (!pid) return;
  socket.emit("set_player", { playerId: pid });
});

buzzBtn.addEventListener("click", () => {
  socket.emit("buzz");
});

selectBuzzedBtn.addEventListener("click", () => {
  socket.emit("host_select_buzzed_first");
});

clearBuzzBtn.addEventListener("click", () => {
  socket.emit("host_clear_buzz");
});

closeOverlayBtn.addEventListener("click", () => {
  if (isHost) socket.emit("host_close_overlay");
  else qaOverlay.classList.add("hidden"); // Zuschauer können nur lokal schließen
});

answeringPlayerSelect.addEventListener("change", () => {
  if (!isHost) return;
  const pid = answeringPlayerSelect.value || null;
  if (pid) socket.emit("host_set_answering", { playerId: pid });
});

markCorrectBtn.addEventListener("click", () => {
  if (!isHost) return;
  socket.emit("host_mark_correct");
});

markWrongBtn.addEventListener("click", () => {
  if (!isHost) return;
  socket.emit("host_mark_wrong");
});

// -------- socket connect --------
function connect(roomId, role, displayName) {
  if (socket) socket.disconnect();

  socket = io(); // same origin
  connInfo.textContent = "verbinde…";

  socket.on("connect", () => {
    connInfo.textContent = `verbunden (${socket.id.slice(0, 6)}…)`;
    socket.emit("join", { roomId, role, displayName });
  });

socket.on("joined", (payload) => {
  console.log("JOINED PAYLOAD:", payload);

  isHost = payload.isHost;
  role = payload.role;

  console.log("IS HOST?", isHost);

  joinOverlay.classList.add("hidden");
  connInfo.textContent =
    `Raum ${payload.roomId} • ${isHost ? "HOST" : "ZUSCHAUER"}`;

  setHostUI();
});

  socket.on("state", (newState) => {
    state = newState;
    renderAll();
  });

  socket.on("error_msg", (msg) => {
    joinMsg.textContent = msg;
    // wenn man schon drin ist: oben anzeigen
    console.warn(msg);
  });

  socket.on("info_msg", (msg) => {
    console.log(msg);
  });

  socket.on("disconnect", () => {
    connInfo.textContent = "getrennt";
    joinOverlay.classList.remove("hidden");
  });
}