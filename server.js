import { createServer } from 'http'
import { Server } from 'socket.io'
import express from 'express'
import cors from 'cors'

const app = express()
app.use(cors())

const server = createServer(app)
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
})

const MAX_USERS_PER_ROOM = 10
const rooms = {}

// Predefine 10 rooms
const predefinedRooms = Array.from({ length: 10 }, (_, i) => `room${i + 1}`)
predefinedRooms.forEach(room => {
  rooms[room] = createRoomState()
})

function generateAcronym(length) {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let result = ''
  for (let i = 0; i < length; i++) {
    result += letters.charAt(Math.floor(Math.random() * letters.length))
  }
  return result
}

function countdownPhase(roomCode, duration, phase, onEnd) {
  let secondsLeft = duration
  const interval = setInterval(() => {
    io.to(roomCode).emit('countdown', secondsLeft)
    if (secondsLeft <= 10) {
      io.to(roomCode).emit('beep')
    }
    if (secondsLeft <= 0) {
      clearInterval(interval)
      onEnd()
    }
    secondsLeft--
  }, 1000)
}

function startRound(roomCode) {
  const room = rooms[roomCode]
  if (!room) return

  room.state.phase = 'submit'
  room.state.entries = []
  room.state.votes = {}
  room.state.round++
  room.state.acronym = generateAcronym(room.state.round + 2)
  io.to(roomCode).emit('round_number', room.state.round)
  io.to(roomCode).emit('acronym', room.state.acronym)
  io.to(roomCode).emit('phase', 'submit')

  countdownPhase(roomCode, 60, 'submit', () => {
    room.state.phase = 'vote'
    io.to(roomCode).emit('phase', 'vote')
    io.to(roomCode).emit('entries', room.state.entries)

    countdownPhase(roomCode, 30, 'vote', () => {
      room.state.phase = 'results'

      const scores = room.state.scores
      for (const entry of room.state.entries) {
        const voteCount = Object.values(room.state.votes).filter(v => v === entry.id).length
        scores[entry.username] = (scores[entry.username] || 0) + voteCount
      }

      io.to(roomCode).emit('votes', room.state.votes)
      io.to(roomCode).emit('scores', scores)
      io.to(roomCode).emit('phase', 'results')

      if (room.state.round >= 5) {
        const winner = Object.entries(scores).sort((a, b) => b[1] - a[1])[0]
        io.to(roomCode).emit('game_over', {
          scores,
          winner: winner ? winner[0] : null,
        })
        room.state = createRoomState()
      } else {
        setTimeout(() => startRound(roomCode), 5000)
      }
    })
  })
}

function createRoomState() {
  return {
    users: [],
    state: {
      round: 0,
      acronym: '',
      phase: 'waiting',
      entries: [],
      votes: {},
      scores: {},
    },
  }
}

io.on('connection', (socket) => {
  socket.on('join_room', ({ room, username }) => {
    if (!predefinedRooms.includes(room)) {
      socket.emit('invalid_room')
      return
    }

    const roomData = rooms[room]

    if (roomData.users.length >= MAX_USERS_PER_ROOM) {
      socket.emit('room_full')
      return
    }

    roomData.users.push({ id: socket.id, username })
    socket.join(room)

    console.log(`${username} joined ${room}`)

    // Start game immediately if not already started
    if (roomData.state.phase === 'waiting' && roomData.users.length >= 2) {
      startRound(room)
    }
  })

  socket.on('submit_entry', ({ room, username, text }) => {
    const roomData = rooms[room]
    if (!roomData || roomData.state.phase !== 'submit') return
    const id = socket.id + '-' + Date.now()
    roomData.state.entries.push({ id, username, text })
  })

  socket.on('vote_entry', ({ room, username, entryId }) => {
    const roomData = rooms[room]
    if (!roomData || roomData.state.phase !== 'vote') return
    roomData.state.votes[username] = entryId
  })

  socket.on('disconnect', () => {
    for (const room of predefinedRooms) {
      const roomData = rooms[room]
      roomData.users = roomData.users.filter(u => u.id !== socket.id)
    }
  })
})

server.listen(3001, () => {
  console.log('Socket.io server running on port 3001')
})






  

