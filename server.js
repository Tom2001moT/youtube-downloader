const express = require('express');
const WebSocket = require('ws');
const ytdl = require('ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const port = process.env.PORT || 3000;

// Serve static files from the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// WebSocket server
const wss = new WebSocket.Server({ noServer: true });

// Store WebSocket clients by download ID
const clients = new Map();

// Download queue and concurrency control
const downloadQueue = [];
let activeDownloads = 0;
const MAX_CONCURRENT_DOWNLOADS = 2;

// Track download states
const downloadStates = new Map();
const playlistStates = new Map();

// Configuration
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR);
}

// Broadcast progress to clients
function broadcastProgress(downloadId, progress) {
    const wsClients = clients.get(downloadId) || [];
    wsClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(progress));
        }
    });
}

// WebSocket connection handling
wss.on('connection', (ws, req) => {
    const downloadId = req.url.split('/')[2];
    if (!clients.has(downloadId)) {
        clients.set(downloadId, []);
    }
    clients.get(downloadId).push(ws);

    ws.on('close', () => {
        const wsClients = clients.get(downloadId);
        const index = wsClients.indexOf(ws);
        if (index !== -1) {
            wsClients.splice(index, 1);
        }
        if (wsClients.length === 0) {
            clients.delete(downloadId);
        }
    });
});

// Default route to serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Route to get video or playlist info
app.get('/info', async (req, res) => {
    const { url } = req.query;
    try {
        const info = await ytdl.getInfo(url);
        if (info.videoDetails.isLiveContent) {
            return res.status(400).json({ error: 'Live content not supported' });
        }

        if (info.videoDetails.playlist) {
            const playlistId = uuidv4();
            const videos = info.related_videos.map(video => ({
                title: video.title || 'Unknown Title',
                id: video.id || 'unknown',
                url: `https://www.youtube.com/watch?v=${video.id}`
            }));
            playlistStates.set(playlistId, {
                total_videos: videos.length,
                completed_videos: 0
            });
            return res.json({
                is_playlist: true,
                playlist_id: playlistId,
                title: info.videoDetails.title,
                videos
            });
        } else {
            return res.json({
                is_playlist: false,
                title: info.videoDetails.title,
                id: info.videoDetails.videoId
            });
        }
    } catch (error) {
        res.status(400).json({ error: `Invalid URL or error: ${error.message}` });
    }
});

// Download function
async function downloadFile(url, type, quality, format, downloadId, playlistId = null) {
    const fileExt = type === 'audio' && format === 'mp3' ? 'mp3' : 'mp4';
    const filePath = path.join(DOWNLOADS_DIR, `${downloadId}.${fileExt}`);
    const filename = `${downloadId}.${fileExt}`;

    try {
        const info = await ytdl.getInfo(url);
        const totalSize = parseInt(info.formats[0].contentLength, 10) || 10_000_000;
        downloadStates.set(downloadId, {
            file_path: filePath,
            bytes_downloaded: 0,
            total_size: totalSize,
            start_time: Date.now(),
            last_update_time: Date.now(),
            bytes_since_last_update: 0,
            url,
            type,
            quality,
            format,
            playlist_id: playlistId,
            canceled: false
        });

        const videoStream = ytdl(url, {
            quality: type === 'audio' ? 'highestaudio' : quality,
            filter: type === 'audio' ? 'audioonly' : 'audioandvideo'
        });

        let outputStream;
        if (type === 'audio' && format === 'mp3') {
            outputStream = ffmpeg(videoStream)
                .audioCodec('mp3')
                .format('mp3')
                .on('error', (err) => {
                    throw new Error(`FFmpeg error: ${err.message}`);
                });
        } else {
            outputStream = videoStream;
        }

        const fileStream = fs.createWriteStream(filePath);
        let bytesDownloaded = 0;

        outputStream.on('data', (chunk) => {
            if (downloadStates.get(downloadId).canceled) {
                outputStream.destroy();
                fileStream.end();
                return;
            }
            bytesDownloaded += chunk.length;
            const state = downloadStates.get(downloadId);
            state.bytes_downloaded = bytesDownloaded;
            const currentTime = Date.now();

            if (currentTime - state.last_update_time >= 500) {
                const speed = state.bytes_since_last_update / ((currentTime - state.last_update_time) / 1000) / 1024 / 1024;
                const remainingBytes = state.total_size - bytesDownloaded;
                const eta = speed > 0 ? remainingBytes / (speed * 1024 * 1024) : 0;
                const percent = (bytesDownloaded / state.total_size) * 100;

                broadcastProgress(downloadId, {
                    status: 'downloading',
                    percent: Math.min(percent, 100),
                    speed: `${speed.toFixed(2)} MB/s`,
                    eta: `${Math.round(eta)}s`,
                    playlist_id: playlistId
                });
                state.last_update_time = currentTime;
                state.bytes_since_last_update = 0;
            }
            state.bytes_since_last_update += chunk.length;
        });

        await new Promise((resolve, reject) => {
            outputStream.pipe(fileStream)
                .on('finish', resolve)
                .on('error', reject);
        });

        if (downloadStates.get(downloadId).canceled) {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            throw new Error('Download canceled');
        }

        broadcastProgress(downloadId, {
            status: 'finished',
            percent: 100,
            playlist_id: playlistId
        });

        if (playlistId && playlistStates.has(playlistId)) {
            const playlist = playlistStates.get(playlistId);
            playlist.completed_videos += 1;
            broadcastProgress(playlistId, {
                status: 'playlist_progress',
                completed: playlist.completed_videos,
                total: playlist.total_videos
            });
            if (playlist.completed_videos === playlist.total_videos) {
                playlistStates.delete(playlistId);
            }
        }

        return { filePath, filename: `${info.videoDetails.title}.${fileExt}` };
    } catch (error) {
        broadcastProgress(downloadId, {
            status: 'error',
            message: `Download failed: ${error.message}`,
            playlist_id: playlistId
        });
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        throw error;
    }
}

// Process download queue
async function processQueue() {
    while (downloadQueue.length > 0 && activeDownloads < MAX_CONCURRENT_DOWNLOADS) {
        const { url, type, quality, format, downloadId, playlistId, res } = downloadQueue.shift();
        activeDownloads++;

        broadcastProgress(downloadId, { status: 'queued', position: downloadQueue.length + 1, playlist_id: playlistId });

        try {
            const { filePath, filename } = await downloadFile(url, type, quality, format, downloadId, playlistId);
            res.download(filePath, filename, (err) => {
                if (err) {
                    console.error('Error sending file:', err);
                }
                fs.unlinkSync(filePath);
                downloadStates.delete(downloadId);
                activeDownloads--;
                processQueue();
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
            activeDownloads--;
            processQueue();
        }
    }
}

// Route to enqueue download
app.get('/download', (req, res) => {
    const { url, type, quality, format, download_id: downloadId, playlist_id: playlistId } = req.query;
    if (!['video', 'audio'].includes(type) || !['mp4', 'mp3'].includes(format)) {
        return res.status(400).json({ error: 'Invalid parameters' });
    }

    downloadQueue.push({ url, type, quality, format, downloadId, playlistId, res });
    processQueue();

    res.json({ message: 'Download queued', download_id: downloadId, playlist_id: playlistId });
});

// Route to cancel download
app.get('/cancel/:downloadId', (req, res) => {
    const { downloadId } = req.params;
    if (downloadStates.has(downloadId)) {
        downloadStates.get(downloadId).canceled = true;
        const filePath = downloadStates.get(downloadId).file_path;
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        const playlistId = downloadStates.get(downloadId).playlist_id;
        downloadStates.delete(downloadId);
        broadcastProgress(downloadId, { status: 'canceled', message: 'Download canceled', playlist_id: playlistId });
        return res.json({ message: 'Active download canceled' });
    }

    const index = downloadQueue.findIndex(task => task.downloadId === downloadId);
    if (index !== -1) {
        const task = downloadQueue.splice(index, 1)[0];
        broadcastProgress(downloadId, { status: 'canceled', message: 'Download canceled from queue', playlist_id: task.playlistId });
        return res.json({ message: 'Queued download canceled' });
    }

    res.status(404).json({ error: 'Download not found' });
});

// Start server
const server = app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

// Upgrade HTTP server to WebSocket
server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});