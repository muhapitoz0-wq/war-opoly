const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static('public'));

const board = [
  { id: 0, name: 'Command HQ', type: 'special', icon: '🏛️', effect: 'Safe base' },
  { id: 1, name: 'Berlin', type: 'territory', icon: '🇩🇪', cost: 300, defense: 2, reward: 150, owner: null },
  { id: 2, name: 'Tokyo', type: 'territory', icon: '🇯🇵', cost: 350, defense: 2, reward: 180, owner: null },
  { id: 3, name: 'Supply Drop', type: 'special', icon: '📦', effect: 'Gain 250 credits', owner: null },
  { id: 4, name: 'Cairo', type: 'territory', icon: '🇪🇬', cost: 320, defense: 2, reward: 160, owner: null },
  { id: 5, name: 'Washington', type: 'territory', icon: '🇺🇸', cost: 400, defense: 3, reward: 200, owner: null },
  { id: 6, name: 'Neon Storm', type: 'special', icon: '⚡', effect: 'Advance 2 extra spaces', owner: null },
  { id: 7, name: 'Sydney', type: 'territory', icon: '🇦🇺', cost: 360, defense: 2, reward: 170, owner: null },
  { id: 8, name: 'Riyadh', type: 'territory', icon: '🇸🇦', cost: 380, defense: 3, reward: 190, owner: null },
  { id: 9, name: 'Cyber Siege', type: 'special', icon: '💻', effect: 'Drain 150 credits from enemy', owner: null },
  { id: 10, name: 'Moscow', type: 'territory', icon: '🇷🇺', cost: 450, defense: 3, reward: 220, owner: null },
  { id: 11, name: 'Cape Town', type: 'territory', icon: '🇿🇦', cost: 340, defense: 2, reward: 165, owner: null }
];

function createRoomState(roomId) {
  return {
    roomId,
    players: {},
    turnOrder: [],
    currentTurnIndex: 0,
    board: board.map((space) => ({ ...space })),
    winner: null,
    round: 1,
    status: 'lobby',
    hostId: null
  };
}

const powerUpsCatalog = {
  airstrike: { cost: 250, desc: 'Remove one enemy territory' },
  shield: { cost: 180, desc: 'Block next enemy capture' },
  doubleMove: { cost: 120, desc: 'Immediate extra move' },
  spy: { cost: 100, desc: 'Steal credits from an enemy' }
};

const rooms = new Map();

function getArmyPower(player) {
  return Math.max(1, 1 + (player.territories || []).length);
}

function syncPlayerStats(player) {
  player.armyPower = getArmyPower(player);
  return player;
}

function emitRoomState(room) {
  const leaderboard = Object.values(room.players).map((p) => ({
    id: p.id,
    name: p.armyName || p.name,
    money: p.money,
    territories: p.territories.length,
    score: p.money + (p.territories.length * 150)
  })).sort((a, b) => b.score - a.score);

  const snapshot = { ...room, leaderboard };
  io.to(room.roomId).emit('updateGameState', snapshot);
}

function checkWinner(room) {
  const winner = Object.values(room.players).find((player) => player.territories.length >= 5 || player.money >= 4000);
  if (winner) {
    room.winner = winner.id;
  }
  return room.winner;
}

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  socket.on('joinGame', (payload) => {
    const roomId = (payload.roomId || 'GLOBAL').trim().toUpperCase();
    const name = (payload.name || 'Commander').trim();
    const country = payload.country || 'Israel';
    const armyName = (payload.armyName || `${country} Army`).trim();

    let room = rooms.get(roomId);
    if (!room) {
      room = createRoomState(roomId);
      rooms.set(roomId, room);
    }

    if (room.status === 'playing') {
      socket.emit('error', 'This room has already started.');
      return;
    }

    if (Object.keys(room.players).length >= 2) {
      socket.emit('error', 'This war room is full.');
      return;
    }

    socket.join(roomId);

    const isHost = Object.keys(room.players).length === 0;
    room.players[socket.id] = {
      id: socket.id,
      name,
      country,
      armyName,
      money: 1500,
      position: 0,
      armyPower: 1,
      territories: [],
      powerUps: [],
      shieldActive: false,
      isHost
    };

    room.turnOrder.push(socket.id);
    room.hostId = room.hostId || socket.id;
    syncPlayerStats(room.players[socket.id]);

    emitRoomState(room);
    console.log(`${name} joined room ${roomId}.`);
  });

  socket.on('startGame', (roomId) => {
    const room = rooms.get(roomId);
    if (!room) return;

    if (socket.id !== room.hostId) {
      socket.emit('error', 'Only the host can start the match.');
      return;
    }

    if (Object.keys(room.players).length < 2) {
      socket.emit('error', 'You need a rival commander to start.');
      return;
    }

    room.status = 'playing';
    emitRoomState(room);
  });

  socket.on('rollDice', (roomId) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing') return;

    const currentTurnId = room.turnOrder[room.currentTurnIndex];
    if (!currentTurnId || socket.id !== currentTurnId || room.winner) return;

    const player = room.players[socket.id];
    const dice = Math.floor(Math.random() * 6) + 1;
    const previousPosition = player.position;

    player.position = (player.position + dice) % room.board.length;

    const currentSpace = room.board[player.position];
    let combatLog = `${player.armyName || player.name} rolled ${dice} and advanced from ${previousPosition} to ${currentSpace.icon} ${currentSpace.name}.`;
    syncPlayerStats(player);

    if (currentSpace.type === 'territory') {
      if (!currentSpace.owner) {
        if (player.money >= currentSpace.cost) {
          player.money -= currentSpace.cost;
          currentSpace.owner = socket.id;
          player.territories.push(currentSpace.id);
          syncPlayerStats(player);
          combatLog += ` They secured the region for ${currentSpace.cost} credits.`;
        } else {
          combatLog += ' They cannot afford the invasion yet.';
        }
      } else if (currentSpace.owner === socket.id) {
        player.money += currentSpace.reward;
        combatLog += ` Their garrison collected ${currentSpace.reward} credits from local support.`;
      } else {
        const enemy = room.players[currentSpace.owner];
        syncPlayerStats(enemy);
        const attackPower = player.armyPower + dice;
        const defensePower = enemy.armyPower + currentSpace.defense;

        if (enemy.shieldActive) {
          enemy.shieldActive = false;
          combatLog += ` The assault was halted by defensive shields.`;
        } else if (attackPower > defensePower) {
          currentSpace.owner = socket.id;
          enemy.territories = enemy.territories.filter((id) => id !== currentSpace.id);
          player.territories.push(currentSpace.id);
          player.money += currentSpace.reward;
          syncPlayerStats(player);
          syncPlayerStats(enemy);
          combatLog += ` ⚔️ Victory! ${player.armyName || player.name} captured ${currentSpace.name}.`;
        } else {
          player.money = Math.max(0, player.money - 120);
          combatLog += ` ⚠️ The assault failed and ${player.armyName || player.name} retreated after heavy losses.`;
        }
      }
    } else {
      switch (currentSpace.name) {
        case 'Supply Drop':
          player.money += 250;
          combatLog += ' A supply crate boosted morale and finances.';
          break;
        case 'Neon Storm':
          player.position = (player.position + 2) % room.board.length;
          combatLog += ' A blinding storm pushed the army two extra spaces.';
          break;
        case 'Cyber Siege':
          const enemy = Object.values(room.players).find((entry) => entry.id !== socket.id);
          if (enemy) {
            enemy.money = Math.max(0, enemy.money - 150);
            combatLog += ` An orbital cyber attack drained 150 credits from ${enemy.armyName || enemy.name}.`;
          }
          break;
        default:
          player.money += 180;
          combatLog += ' Headquarters issued a strategic bonus.';
          break;
      }
    }

    if (checkWinner(room)) {
      const winner = room.players[room.winner];
      combatLog += ` 🏆 ${winner.armyName || winner.name} has conquered enough territory to win the war!`;
    }

    room.currentTurnIndex = (room.currentTurnIndex + 1) % room.turnOrder.length;
    room.round += 1;

    emitRoomState(room);
    io.to(room.roomId).emit('gameAction', { roomId: room.roomId, log: combatLog });
  });

  socket.on('placeBet', (roomId, amount) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing') return;

    const currentTurnId = room.turnOrder[room.currentTurnIndex];
    if (!currentTurnId || socket.id !== currentTurnId || room.winner) return;

    const player = room.players[socket.id];
    if (!player || amount < 50 || amount > player.money) {
      socket.emit('error', 'Invalid bet amount.');
      return;
    }

    const winChance = 0.55;
    const win = Math.random() < winChance;
    let betLog = `${player.armyName || player.name} risked ${amount} credits in a war gamble.`;

    if (win) {
      player.money += amount;
      betLog += ` They won ${amount} credits!`;
    } else {
      player.money = Math.max(0, player.money - amount);
      betLog += ` They lost ${amount} credits and paid the battlefield toll.`;
    }

    syncPlayerStats(player);
    emitRoomState(room);
    io.to(room.roomId).emit('gameAction', { roomId: room.roomId, log: betLog });
  });

  socket.on('chatMessage', (roomId, text) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    io.to(roomId).emit('chatMessage', { from: player.armyName || player.name, country: player.country, text });
  });

  socket.on('buyPowerUp', (roomId, type) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    const spec = powerUpsCatalog[type];
    if (!spec) {
      socket.emit('error', 'Unknown power-up.');
      return;
    }
    if (player.money < spec.cost) {
      socket.emit('error', 'Not enough credits to buy this power-up.');
      return;
    }
    player.money -= spec.cost;
    player.powerUps.push(type);
    syncPlayerStats(player);
    emitRoomState(room);
    io.to(room.roomId).emit('gameAction', { roomId: room.roomId, log: `${player.armyName || player.name} bought ${type}.` });
  });

  socket.on('usePowerUp', (roomId, type, targetId) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing') return;
    const player = room.players[socket.id];
    if (!player) return;
    const idx = player.powerUps.indexOf(type);
    if (idx === -1) {
      socket.emit('error', 'You do not own this power-up.');
      return;
    }

    // consume
    player.powerUps.splice(idx, 1);

    let actionLog = `${player.armyName || player.name} used ${type}.`;
    if (type === 'airstrike') {
      // remove one territory from a random enemy that owns something
      const enemies = Object.values(room.players).filter((p) => p.id !== player.id && p.territories.length > 0);
      if (enemies.length) {
        const victim = enemies[Math.floor(Math.random() * enemies.length)];
        const tid = victim.territories.pop();
        const tile = room.board.find((s) => s.id === tid);
        if (tile) tile.owner = null;
        actionLog += ` An airstrike neutralized one territory from ${victim.armyName || victim.name}.`;
      } else {
        actionLog += ' But no enemy territory was available to strike.';
      }
    } else if (type === 'shield') {
      player.shieldActive = true;
      actionLog += ' Shields active for the next defense.';
    } else if (type === 'doubleMove') {
      // simulate a quick extra move (one dice)
      const extra = Math.floor(Math.random() * 6) + 1;
      player.position = (player.position + extra) % room.board.length;
      const space = room.board[player.position];
      actionLog += ` Extra move: rolled ${extra} and moved to ${space.name}.`;
    } else if (type === 'spy') {
      const enemies = Object.values(room.players).filter((p) => p.id !== player.id && p.money > 0);
      if (enemies.length) {
        const victim = enemies[Math.floor(Math.random() * enemies.length)];
        const stolen = Math.min(100, victim.money);
        victim.money = Math.max(0, victim.money - stolen);
        player.money += stolen;
        actionLog += ` Spied and stole ${stolen} credits from ${victim.armyName || victim.name}.`;
      } else {
        actionLog += ' But there was no money to steal.';
      }
    }

    syncPlayerStats(player);
    emitRoomState(room);
    io.to(room.roomId).emit('gameAction', { roomId: room.roomId, log: actionLog });
  });

  socket.on('disconnect', () => {
    for (const [roomId, room] of rooms.entries()) {
      if (!room.players[socket.id]) continue;

      room.board.forEach((space) => {
        if (space.owner === socket.id) {
          space.owner = null;
        }
      });

      delete room.players[socket.id];
      room.turnOrder = room.turnOrder.filter((id) => id !== socket.id);
      if (room.hostId === socket.id) {
        room.hostId = room.turnOrder[0] || null;
      }
      if (room.currentTurnIndex >= room.turnOrder.length) {
        room.currentTurnIndex = 0;
      }
      if (room.turnOrder.length === 0) {
        rooms.delete(roomId);
      } else {
        emitRoomState(room);
      }
      break;
    }
  });
});

const preferredPort = Number(process.env.PORT) || 3001;
const fallbackPorts = [preferredPort, preferredPort + 1, preferredPort + 2, 3000, 3002, 3003];

function listenOnPort(port, index) {
  server.listen(port, () => {
    console.log(`War-opoly server running on http://localhost:${port}`);
  });

  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && index + 1 < fallbackPorts.length) {
      console.log(`Port ${port} is busy. Trying ${fallbackPorts[index + 1]}...`);
      server.removeAllListeners('error');
      listenOnPort(fallbackPorts[index + 1], index + 1);
    } else {
      throw err;
    }
  });
}

listenOnPort(fallbackPorts[0], 0);