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

// =====================================
// 🔑 TOKEN DE SPOTIFY
// =====================================
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
        spotifyToken = { 
            access_token: response.data.access_token, 
            expires_at: Date.now() + response.data.expires_in * 1000, 
        };
        return spotifyToken.access_token;
    } catch (error) { 
        console.error("Error al obtener el token de Spotify:", error.response ? error.response.data : error.message); 
        return null; 
    }
}

// =====================================
// 🎧 FUNCIÓN PARA CARGAR PLAYLISTS DE SPOTIFY
// =====================================
async function getSpotifyPlaylistTracks(playlistUrl) {
    const playlistIdMatch = playlistUrl.match(/playlist\/([a-zA-Z0-9]+)/);
    if (!playlistIdMatch) throw new Error("URL de playlist de Spotify inválida.");
    const playlistId = playlistIdMatch[1];

    const token = await getSpotifyToken();
    if (!token) throw new Error("No se pudo autenticar con Spotify.");

    const tracks = [];
    let nextUrl = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100`;

    while (nextUrl) {
        const response = await axios.get(nextUrl, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        response.data.items.forEach(item => {
            if (item.track && item.track.name) {
                tracks.push({
                    name: item.track.name,
                    artist: item.track.artists.map(a => a.name).join(", ")
                });
            }
        });

        nextUrl = response.data.next;
    }

    console.log(`🎵 Playlist de Spotify cargada: ${tracks.length} canciones.`);
    return tracks;
}

// =====================================
// 🔍 BÚSQUEDA EN YOUTUBE
// =====================================
async function searchYouTubeVideo(query) {
    try {
        const youtubeResponse = await axios.get('https://www.googleapis.com/youtube/v3/search', {
            params: { part: 'snippet', q: query, key: YOUTUBE_API_KEY, type: 'video', maxResults: 1 }
        });
        const item = youtubeResponse.data.items[0];
        return item ? { videoId: item.id.videoId, title: item.snippet.title } : null;
    } catch (error) {
        console.error("Error al buscar en YouTube:", error.response?.data || error.message);
        return null;
    }
}

// =====================================
// 🎁 RUTAS Y ENDPOINTS
// =====================================
app.get('/surprise', (req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const todaysSurprise = surprises.find(s => s.date === today);
    if (todaysSurprise) { res.json(todaysSurprise); } else { res.json(null); }
});

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

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

// =====================================
// 🧩 SOCKET.IO
// =====================================
io.on('connection', (socket) => {
  console.log(`Alguien se ha conectado: ${socket.id}`);
  userColors[socket.id] = chatColors[Math.floor(Math.random() * chatColors.length)];
  if (!radioState.master) { radioState.master = socket.id; }
  socket.emit('sync-state', radioState);
  io.emit('user-count-update', io.sockets.adapter.sids.size);

  socket.on('url-submitted', async (data) => {
        const url = data.url;
        
        try {
            if (url.includes("open.spotify.com/playlist")) {
                // 🟢 PLAYLIST DE SPOTIFY
                console.log(`🎧 Detectada playlist de Spotify: ${url}`);
                const tracks = await getSpotifyPlaylistTracks(url);
                
                for (const track of tracks) {
                    const ytResult = await searchYouTubeVideo(`${track.name} ${track.artist}`);
                    if (ytResult) radioState.queue.push(ytResult);
                }
                
                io.emit('queue-update', radioState.queue);
                if (!radioState.currentVideo) { playNextSongInQueue(); }
                
                io.emit('new-message', {
                    sender: "Sistema 🎶",
                    text: `Playlist de Spotify añadida con ${tracks.length} canciones.`,
                    color: "#1DB954"
                });

            } else if (url.includes("list=")) {
                // 🔴 PLAYLIST DE YOUTUBE
                const playlistId = new URL(url).searchParams.get('list');
                const response = await axios.get('https://www.googleapis.com/youtube/v3/playlistItems', {
                    params: { part: 'snippet', playlistId: playlistId, key: YOUTUBE_API_KEY, maxResults: 50 }
                });
                const videos = response.data.items.map(item => ({
                    videoId: item.snippet.resourceId.videoId,
                    title: item.snippet.title
                }));
                radioState.queue.unshift(...videos);
                if (!radioState.currentVideo) { playNextSongInQueue(); }
                else { io.emit('queue-update', radioState.queue); }
                
            } else {
                // 🔵 VIDEO INDIVIDUAL
                const videoId = data.videoId;
                if (videoId) {
                    radioState.queue.unshift({ videoId, title: data.title });
                    if (!radioState.currentVideo) { playNextSongInQueue(); }
                    else { io.emit('queue-update', radioState.queue); }
                }
            }
        } catch (error) {
            console.error("Error procesando URL:", error.message);
            socket.emit('new-message', {
                sender: "Sistema ⚠️",
                text: "Ocurrió un error al procesar el enlace.",
                color: "#e74c3c"
            });
        }
    });

  socket.on('add-to-queue', (video) => {
      radioState.queue.unshift(video);
      if (!radioState.currentVideo && radioState.queue.length === 1) { playNextSongInQueue(); } 
      else { io.emit('queue-update', radioState.queue); }
  });

  socket.on('song-ended', () => {
      if (socket.id === radioState.master) { playNextSongInQueue(); }
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
    io.emit('user-count-update', io.sockets.adapter.sids.size);
  });
});

// =====================================
// 🔁 FUNCIÓN DE AUTOPLAY INTELIGENTE
// =====================================
async function playNextSongInQueue() {
    if (radioState.queue.length > 0) {
        // Hay canciones en la cola, reproducir la siguiente
        const nextVideo = radioState.queue.shift();
        radioState.currentVideo = nextVideo;
        radioState.isPlaying = true;
        radioState.currentTime = 0;
        console.log(`🎵 Reproduciendo siguiente de la cola: ${nextVideo.title}`);
        io.emit('state-update', radioState);
        
    } else if (radioState.currentVideo) {
        // No hay cola, pero había una canción actual - activar autoplay
        try {
            console.log(`🔍 Buscando recomendación para: ${radioState.currentVideo.videoId}`);
            const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
                params: {
                    part: 'snippet',
                    relatedToVideoId: radioState.currentVideo.videoId,
                    type: 'video',
                    key: YOUTUBE_API_KEY,
                    maxResults: 5,
                    q: ''
                }
            });

            const recommendations = response.data.items;
            if (recommendations.length > 0) {
                const randomIndex = Math.floor(Math.random() * recommendations.length);
                const recommendedVideo = recommendations[randomIndex];
                const nextVideo = {
                    videoId: recommendedVideo.id.videoId,
                    title: recommendedVideo.snippet.title
                };
                radioState.currentVideo = nextVideo;
                radioState.isPlaying = true;
                radioState.currentTime = 0;
                console.log(`🎶 Reproduciendo recomendación: ${nextVideo.title}`);
                io.emit('state-update', radioState);
                io.emit('new-message', {
                    sender: "Sistema 🎧",
                    text: `Reproduciendo automáticamente: ${nextVideo.title}`,
                    color: "#9b59b6"
                });
            } else {
                console.warn("⚠️ No se encontraron recomendaciones.");
                radioState.currentVideo = null;
                radioState.isPlaying = false;
                io.emit('state-update', radioState);
            }
        } catch (error) {
            console.error("❌ Error al buscar recomendación:", error.response?.data || error.message);
            
            // Fallback: buscar por título de la canción actual
            if (radioState.currentVideo?.title) {
                try {
                    const fallbackResponse = await axios.get('https://www.googleapis.com/youtube/v3/search', {
                        params: {
                            part: 'snippet',
                            q: radioState.currentVideo.title,
                            key: YOUTUBE_API_KEY,
                            type: 'video',
                            maxResults: 5
                        }
                    });
                    const fallbackVideos = fallbackResponse.data.items;
                    if (fallbackVideos.length > 0) {
                        const randomIndex = Math.floor(Math.random() * fallbackVideos.length);
                        const fallbackVideo = fallbackVideos[randomIndex];
                        const nextVideo = {
                            videoId: fallbackVideo.id.videoId,
                            title: fallbackVideo.snippet.title
                        };
                        radioState.currentVideo = nextVideo;
                        radioState.isPlaying = true;
                        radioState.currentTime = 0;
                        console.log(`🎶 Reproduciendo alternativa: ${nextVideo.title}`);
                        io.emit('state-update', radioState);
                        io.emit('new-message', {
                            sender: "Sistema 🎧",
                            text: `Reproduciendo automáticamente: ${nextVideo.title}`,
                            color: "#9b59b6"
                        });
                        return;
                    }
                } catch (fallbackError) {
                    console.error("❌ Error en fallback:", fallbackError.message);
                }
            }
            
            // Si todo falla, detener la reproducción
            radioState.currentVideo = null;
            radioState.isPlaying = false;
            io.emit('state-update', radioState);
        }
    } else {
        // No hay cola ni canción actual
        radioState.currentVideo = null;
        radioState.isPlaying = false;
        io.emit('state-update', radioState);
    }
}

// =====================================
// 🚀 INICIAR SERVIDOR
// =====================================
const PORT = 3000;
server.listen(PORT, () => { 
    console.log(`🎵 Radio Chocomenta sonando en http://localhost:${PORT}`); 
});