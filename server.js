// Basic Express + Socket.io game backend logic
import express from 'express'
import http from 'http'
import { Server } from 'socket.io'
import cors from 'cors'

const app = express()
app.use(cors())
const server = http.createServer(app)
const io = new Server(server, {
  cors: {
    origin: '*',
  }
})

const rooms = {} // { [roomCode]: { users: {}, entries: [], votes: {}, scores: {}, round: 1, phase: 'waiting' } }

function generateAcronym(length) {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  return Array.from({ length }, () => letters[Math.floor(Math.random() * letters.length)]).join('')
}

function startRound(roomCode) {
  const room = rooms[roomCode]
  if (!room || room.round > 5) return

  const acronymLength = 2 + room.round
  const acronym = generateAcronym(acronymLength)
  room.acronym = acronym
  room.entries = []
  room.votes = {}
  room.phase = 'submit'

  io.to(roomCode).emit('round_number', room.round)
  io.to(roomCode).emit('acronym', acronym)
  io.to(roomCode).emit('phase', 'submit')

  setTimeout(() => {
    room.phase = 'vote'
    io.to(roomCode).emit('entries', room.entries) // Ensure entries sent BEFORE phase update
    io.to(roomCode).emit('phase', 'vote')

    setTimeout(() => {
      room.phase = 'results'

      const voteCounts = {}
      Object.values(room.votes).forEach((id) => {
        voteCounts[id] = (voteCounts[id] || 0) + 1
      })

      room.entries.forEach((entry) => {
        const votes = voteCounts[entry.id] || 0
        room.scores[entry.username] = (room.scores[entry.username] || 0) + votes
      })

      io.to(roomCode).emit('votes', voteCounts)
      io.to(roomCode).emit('scores', room.scores)
      io.to(roomCode).emit('entries', room.entries)
      io.to(roomCode).emit('phase', 'results')

      if (room.round >= 5) {
        io.to(roomCode).emit('game_over', {
          scores: room.scores,
          winner: Object.entries(room.scores).sort((a, b) => b[1] - a[1])[0][0]
        })
        room.phase = 'waiting'
        room.round = 1
        room.entries = []
        room.votes = {}
        room.scores = {}
      } else {
        room.round++
        setTimeout(() => startRound(roomCode), 5000)
      }
    }, 30000)
  }, 60000)
}

io.on('connection', (socket) => {
  socket.on('join_room', ({ room, username }) => {
    socket.join(room)
    if (!rooms[room]) {
      rooms[room] = {
        users: {},
        entries: [],
        votes: {},
        scores: {},
        round: 1,
        phase: 'waiting',
      }
    }
    rooms[room].users[socket.id] = username
    if (rooms[room].phase === 'waiting') {
      startRound(room)
    }
  })

  socket.on('submit_entry', ({ room, username, text }) => {
    const entry = {
      id: socket.id + '-' + Date.now(),
      username,
      text,
    }
    if (rooms[room] && rooms[room].phase === 'submit') {
      rooms[room].entries.push(entry)
    }
  })

  socket.on('vote_entry', ({ room, entryId }) => {
    if (rooms[room] && rooms[room].phase === 'vote') {
      rooms[room].votes[socket.id] = entryId
    }
  })
})

server.listen(3001, () => {
  console.log('Server running on http://localhost:3001')
})


  

