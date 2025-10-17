const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

let surprises = [];
try {
    const surprisesData = fs.readFileSync('surprises.json', 'utf8');
    surprises = JSON.parse(surprisesData);
    console.log("Archivo de sorpresas cargado correctamente.");
} catch (error) { console.error("No se pudo leer el archivo surprises.json:", error); }

// --- ZONA DE CLAVES SECRETAS ---
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

app.use(express.static('public'));

let radioState = { queue: [], currentVideo: null, isPlaying: false, currentTime: 0, master: null };
const chatColors = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#e67e22', '#1abc9c'];
const userColors = {};
let spotifyToken = null;

// ----------------------------------------------------------
// TOKEN DE SPOTIFY
// ----------------------------------------------------------
async function getSpotifyToken() {
    if (spotifyToken && spotifyToken.expires_at > Date.now()) { return spotifyToken.access_token; }
    try {
        const response = await axios({
            method: 'post', url: 'https://accounts.spotify.com/api/token',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': 'Basic ' + (Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64'))
            },
            data: 'grant_type=client_credentials'
        });
        spotifyToken = { access_token: response.data.access_token, expires_at: Date.now() + response.data.expires_in * 1000 };
        return spotifyToken.access_token;
    } catch (error) {
        console.error("Error al obtener el token de Spotify:", error.response ? error.response.data : error.message);
        return null;
    }
}

// ----------------------------------------------------------
// ENDPOINT DE SORPRESA
// ----------------------------------------------------------
app.get('/surprise', (req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const todaysSurprise = surprises.find(s => s.date === today);
    if (todaysSurprise) { res.json(todaysSurprise); } else { res.json(null); }
});

// ----------------------------------------------------------
// BÚSQUEDA EN SPOTIFY + YOUTUBE
// ----------------------------------------------------------
app.get('/search', async (req, res) => {
    const query = req.query.q;
    if (!query) { return res.status(400).json({ error: 'Debes especificar una búsqueda.' }); }
    try {
        const token = await getSpotifyToken();
        if (!token) throw new Error("No se pudo autenticar con Spotify.");
        
        const spotifyResponse = await axios.get('https://api.spotify.com/v1/search', {
            headers: { 'Authorization': `Bearer ${token}` },
            params: { q: query, type: 'track', limit: 1 }
        });

        const track = spotifyResponse.data.tracks.items[0];
        if (!track) { return res.json({ results: [] }); }

        const youtubeQuery = `${track.name} ${track.artists[0].name}`;
        const youtubeResponse = await axios.get('https://www.googleapis.com/youtube/v3/search', {
            params: { part: 'snippet', q: youtubeQuery, key: YOUTUBE_API_KEY, type: 'video', maxResults: 5 }
        });

        const results = youtubeResponse.data.items.map(item => ({
            videoId: item.id.videoId, title: item.snippet.title
        }));
        
        res.json({ results });
    } catch (error) {
        console.error("Error en la búsqueda:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "Ocurrió un error en el servidor al buscar." });
    }
});

// ----------------------------------------------------------
// IMPORTAR PLAYLIST DE SPOTIFY
// ----------------------------------------------------------
app.get('/spotify-playlist', async (req, res) => {
    const playlistUrl = req.query.url;
    if (!playlistUrl) return res.status(400).json({ error: 'Falta el enlace de la playlist de Spotify.' });

    try {
        const token = await getSpotifyToken();
        const playlistId = playlistUrl.split('/playlist/')[1].split('?')[0];
        const spotifyResponse = await axios.get(`https://api.spotify.com/v1/playlists/${playlistId}/tracks`, {
            headers: { Authorization: `Bearer ${token}` },
            params: { limit: 30 }
        });

        const tracks = spotifyResponse.data.items.map(item => {
            const t = item.track;
            return `${t.name} ${t.artists.map(a => a.name).join(", ")}`;
        });

        const results = [];
        for (const query of tracks) {
            const yt = await axios.get('https://www.googleapis.com/youtube/v3/search', {
                params: { part: 'snippet', q: query, key: YOUTUBE_API_KEY, type: 'video', maxResults: 1 }
            });
            if (yt.data.items.length > 0) {
                results.push({
                    videoId: yt.data.items[0].id.videoId,
                    title: yt.data.items[0].snippet.title
                });
            }
        }

        radioState.queue.unshift(...results);
        io.emit('queue-update', radioState.queue);

        if (!radioState.currentVideo) playNextSongInQueue();

        res.json({ added: results.length, results });
    } catch (error) {
        console.error("Error al importar la playlist de Spotify:", error.message);
        res.status(500).json({ error: "Error al procesar la playlist." });
    }
});

// ----------------------------------------------------------
// SISTEMA DE SOCKETS
// ----------------------------------------------------------
app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

io.on('connection', (socket) => {
  console.log(`Alguien se ha conectado: ${socket.id}`);
  userColors[socket.id] = chatColors[Math.floor(Math.random() * chatColors.length)];
  if (!radioState.master) { radioState.master = socket.id; }
  socket.emit('sync-state', radioState);
  io.emit('user-count-update', io.sockets.sockets.size);

  socket.on('url-submitted', async (data) => {
        const url = data.url;
        if (url && url.includes("list=")) {
            try {
                const playlistId = new URL(url).searchParams.get('list');
                const response = await axios.get('https://www.googleapis.com/youtube/v3/playlistItems', {
                    params: { part: 'snippet', playlistId, key: YOUTUBE_API_KEY, maxResults: 50 }
                });
                const videos = response.data.items.map(item => ({
                    videoId: item.snippet.resourceId.videoId,
                    title: item.snippet.title
                }));
                radioState.queue.unshift(...videos);
                if (!radioState.currentVideo) { playNextSongInQueue(); }
                else { io.emit('queue-update', radioState.queue); }
            } catch (error) { console.error("Error al procesar la playlist de YouTube:", error); }
        } else {
            const videoId = data.videoId;
            if (videoId) {
                radioState.queue.unshift({ videoId, title: data.title });
                if (!radioState.currentVideo) { playNextSongInQueue(); }
                else { io.emit('queue-update', radioState.queue); }
            }
        }
    });

  socket.on('add-to-queue', (video) => {
      radioState.queue.unshift(video);
      if (!radioState.currentVideo && radioState.queue.length === 1) { playNextSongInQueue(); } 
      else { io.emit('queue-update', radioState.queue); }
  });

  socket.on('song-ended', async () => {
      if (socket.id === radioState.master) { await playNextSongInQueue(true); }
  });

  socket.on('skip-to-song', (data) => {
      if (socket.id === radioState.master && data.index < radioState.queue.length) {
          radioState.queue = radioState.queue.slice(data.index);
          playNextSongInQueue();
      }
  });
  
  socket.on('reorder-queue', (newQueue) => {
      if (socket.id === radioState.master) {
          radioState.queue = newQueue;
          io.emit('queue-update', radioState.queue);
      }
  });

  socket.on('clear-queue', () => {
      if (socket.id === radioState.master) {
          radioState.queue = [];
          io.emit('queue-update', radioState.queue);
      }
  });

  socket.on('state-change', (newState) => {
      radioState = { ...radioState, ...newState, master: socket.id };
      socket.broadcast.emit('state-update', radioState);
  });

  socket.on('chat-message', (data) => {
      const senderName = data.name ? data.name : `Usuario ${socket.id.substring(0, 4)}`;
      io.emit('new-message', { sender: senderName, text: data.text, color: userColors[socket.id] });
  });

  socket.on('disconnect', () => {
    console.log(`Alguien se ha desconectado: ${socket.id}`);
    delete userColors[socket.id];
    if (radioState.master === socket.id) { radioState.master = null; }
    io.emit('user-count-update', io.sockets.sockets.size);
  });
});

// ----------------------------------------------------------
// FUNCIÓN PARA REPRODUCIR LA SIGUIENTE CANCIÓN + AUTOPLAY
// ----------------------------------------------------------
async function playNextSongInQueue(auto = false) {
    if (radioState.queue.length > 0) {
        const nextVideo = radioState.queue.shift();
        radioState.currentVideo = nextVideo;
        radioState.isPlaying = true;
        radioState.currentTime = 0;
        io.emit('state-update', radioState);
    } else if (auto && radioState.currentVideo) {
        // --- AUTOPLAY INTELIGENTE ---
        try {
            const query = radioState.currentVideo.title.split('-')[0];
            const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
                params: {
                    part: 'snippet',
                    relatedToVideoId: radioState.currentVideo.videoId,
                    type: 'video',
                    key: YOUTUBE_API_KEY,
                    maxResults: 5
                }
            });
            if (response.data.items.length > 0) {
                const nextRelated = response.data.items[0];
                radioState.queue.push({
                    videoId: nextRelated.id.videoId,
                    title: nextRelated.snippet.title
                });
                console.log(`Autoplay: agregada canción relacionada: ${nextRelated.snippet.title}`);
                playNextSongInQueue();
            } else {
                console.log("No se encontraron videos relacionados para autoplay.");
                radioState.currentVideo = null;
                radioState.isPlaying = false;
                io.emit('state-update', radioState);
            }
        } catch (err) {
            console.error("Error en autoplay:", err.message);
        }
    } else {
        radioState.currentVideo = null;
        radioState.isPlaying = false;
        io.emit('state-update', radioState);
    }
}

// ----------------------------------------------------------
const PORT = 3000;
server.listen(PORT, () => {
    console.log(`🎧 Radio Chocomenta sonando en http://localhost:${PORT}`);
});
