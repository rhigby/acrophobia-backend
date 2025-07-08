import { createServer } from 'http'
import { Server } from 'socket.io'
import express from 'express'

const app = express()
const server = createServer(app)
const io = new Server(server, {
  cors: {
    origin: '*',
  },
})

const MAX_USERS_PER_ROOM = 10
const rooms = {}

function generateAcronym(length) {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let result = ''
  for (let i = 0; i < length; i++) {
    result += letters.charAt(Math.floor(Math.random() * letters.length))
  }
  return result
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

  setTimeout(() => {
    room.state.phase = 'vote'
    io.to(roomCode).emit('phase', 'vote')
    io.to(roomCode).emit('entries', room.state.entries)

    setTimeout(() => {
      room.state.phase = 'results'

      // Tally votes
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
    }, 30000)
  }, 60000)
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
    if (!rooms[room]) rooms[room] = createRoomState()

    if (rooms[room].users.length >= MAX_USERS_PER_ROOM) {
      socket.emit('room_full')
      return
    }

    rooms[room].users.push({ id: socket.id, username })
    socket.join(room)

    console.log(`${username} joined ${room}`)

    if (rooms[room].users.length >= 2 && rooms[room].state.phase === 'waiting') {
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
    for (const room in rooms) {
      rooms[room].users = rooms[room].users.filter(u => u.id !== socket.id)
      if (rooms[room].users.length === 0) {
        delete rooms[room]
      }
    }
  })
})

server.listen(3001, () => {
  console.log('Socket.io server running on port 3001')
})



  

