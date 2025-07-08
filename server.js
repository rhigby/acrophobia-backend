// This is a full backend update for correct vote ID tracking
const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const cors = require('cors')

const app = express()
app.use(cors())
const server = http.createServer(app)
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
})

const PORT = process.env.PORT || 3001

const rooms = {}

function createRoomState() {
  return {
    users: [],
    scores: {},
    phase: 'waiting',
    entries: [],
    votes: {},
    round: 0,
    acronym: '',
    countdown: null,
    roundTimeout: null
  }
}

function generateAcronym(length) {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  return Array.from({ length }, () => letters[Math.floor(Math.random() * 26)]).join('')
}

function broadcastRoomState(room) {
  const state = rooms[room]
  if (!state) return
  io.to(room).emit('phase', state.phase)
  io.to(room).emit('acronym', state.acronym)
  io.to(room).emit('round_number', state.round)
  io.to(room).emit('entries', state.entries)
  io.to(room).emit('votes', state.votes)
  io.to(room).emit('scores', state.scores)
}

function advancePhase(room) {
  const state = rooms[room]
  if (!state) return

  clearTimeout(state.roundTimeout)

  if (state.phase === 'waiting' || state.phase === 'results') {
    state.round += 1
    const length = 2 + state.round
    state.acronym = generateAcronym(length)
    state.entries = []
    state.votes = {}
    state.phase = 'submit'
    broadcastRoomState(room)
    startCountdown(room, 60, () => advancePhase(room))
  } else if (state.phase === 'submit') {
    state.phase = 'vote'
    broadcastRoomState(room)
    startCountdown(room, 30, () => advancePhase(room))
  } else if (state.phase === 'vote') {
    state.phase = 'results'
    const voteCounts = {}
    state.entries.forEach(e => voteCounts[e.id] = 0)
    Object.values(state.votes).forEach(id => {
      if (voteCounts[id] !== undefined) voteCounts[id]++
    })
    io.to(room).emit('votes', voteCounts)
    for (const e of state.entries) {
      const player = e.username
      if (!state.scores[player]) state.scores[player] = 0
      state.scores[player] += voteCounts[e.id] || 0
    }
    broadcastRoomState(room)
    startCountdown(room, 8, () => {
      if (state.round >= 5) {
        state.phase = 'game_over'
        const maxScore = Math.max(...Object.values(state.scores))
        const winner = Object.entries(state.scores).find(([_, score]) => score === maxScore)[0]
        io.to(room).emit('game_over', { scores: state.scores, winner })
      } else {
        advancePhase(room)
      }
    })
  }
}

function startCountdown(room, duration, onEnd) {
  let counter = duration
  const interval = setInterval(() => {
    rooms[room].countdown = counter
    io.to(room).emit('countdown', counter)
    if (counter <= 10) io.to(room).emit('beep')
    counter--
    if (counter < 0) {
      clearInterval(interval)
      rooms[room].countdown = null
      io.to(room).emit('countdown', null)
      onEnd()
    }
  }, 1000)
  rooms[room].roundTimeout = interval
}

io.on('connection', (socket) => {
  socket.on('join_room', ({ room, username }) => {
    if (!rooms[room]) rooms[room] = createRoomState()
    if (rooms[room].users.length >= 10) return socket.emit('room_full')
    if (!rooms[room].users.includes(username)) rooms[room].users.push(username)
    rooms[room].scores[username] = 0
    socket.join(room)
    io.to(room).emit('player_joined', rooms[room].users)
    if (rooms[room].users.length >= 2 && rooms[room].phase === 'waiting') {
      advancePhase(room)
    }
  })

  socket.on('submit_entry', ({ room, username, text }) => {
    const state = rooms[room]
    if (!state) return
    const id = `${username}-${Date.now()}`
    state.entries.push({ id, username, text })
    io.to(room).emit('entries', state.entries)
  })

  socket.on('vote_entry', ({ room, username, entryId }) => {
    const state = rooms[room]
    if (!state) return
    state.votes[username] = entryId
  })
})

server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`))














  

