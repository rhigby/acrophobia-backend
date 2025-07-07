const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const cors = require('cors')

const app = express()
app.use(cors())

const server = http.createServer(app)
const io = new Server(server, {
  cors: {
    origin: '*'
  }
})

const rooms = {}

const PHASES = ['submit', 'vote', 'results', 'waiting']

function generateAcronym() {
  const length = Math.floor(Math.random() * 3) + 3
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let result = ''
  for (let i = 0; i < length; i++) {
    result += letters[Math.floor(Math.random() * letters.length)]
  }
  return result
}

function advancePhase(roomCode) {
  const room = rooms[roomCode]
  if (!room) return

  switch (room.phase) {
    case 'waiting':
    case 'results': {
      room.acronym = generateAcronym()
      room.entries = []
      room.votes = {}
      room.phase = 'submit'
      io.to(roomCode).emit('acronym', room.acronym)
      io.to(roomCode).emit('phase', 'submit')
      setTimeout(() => advancePhase(roomCode), 30000)
      break
    }
    case 'submit': {
      room.phase = 'vote'
      io.to(roomCode).emit('entries', room.entries)
      io.to(roomCode).emit('phase', 'vote')
      setTimeout(() => advancePhase(roomCode), 20000)
      break
    }
    case 'vote': {
      room.phase = 'results'
      const voteCount = {}
      for (const v of Object.values(room.votes)) {
        voteCount[v] = (voteCount[v] || 0) + 1
      }
      for (const [player, entry] of room.entries.map(e => [e.username, e.id])) {
        const votes = voteCount[entry] || 0
        room.scores[player] = (room.scores[player] || 0) + votes
      }
      io.to(roomCode).emit('votes', voteCount)
      io.to(roomCode).emit('scores', room.scores)
      io.to(roomCode).emit('phase', 'results')
      setTimeout(() => advancePhase(roomCode), 15000)
      break
    }
  }
}

io.on('connection', (socket) => {
  socket.on('join_room', ({ room, username }) => {
    socket.join(room)
    if (!rooms[room]) {
      rooms[room] = {
        players: {},
        entries: [],
        votes: {},
        scores: {},
        acronym: '',
        phase: 'waiting'
      }
    }
    rooms[room].players[socket.id] = username
    if (rooms[room].phase === 'waiting') {
      advancePhase(room)
    }
  })

  socket.on('submit_entry', ({ room, username, text }) => {
    const roomData = rooms[room]
    if (!roomData || roomData.phase !== 'submit') return
    roomData.entries.push({ id: socket.id + Date.now(), username, text })
  })

  socket.on('vote_entry', ({ room, entryId }) => {
    const roomData = rooms[room]
    if (!roomData || roomData.phase !== 'vote') return
    roomData.votes[socket.id] = entryId
  })

  socket.on('disconnect', () => {
    for (const roomCode in rooms) {
      const room = rooms[roomCode]
      if (room.players[socket.id]) {
        delete room.players[socket.id]
      }
    }
  })
})

server.listen(3001, () => {
  console.log('Acrophobia server running on http://localhost:3001')
})
