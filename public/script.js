let downloadId = null;
let playlistInfo = null;
const wsConnections = new Map();

async function processUrl() {
    const url = document.getElementById('youtubeUrl').value;
    const results = document.getElementById('results');
    const playlistResults = document.getElementById('playlistResults');
    const status = document.getElementById('status');

    if (!url || (!url.includes('youtube.com') && !url.includes('youtu.be'))) {
        status.innerHTML = '<span class="text-danger">Please enter a valid YouTube URL</span>';
        results.classList.add('hidden');
        playlistResults.classList.add('hidden');
        return;
    }

    status.innerHTML = '<span class="text-warning">Processing...</span>';
    results.classList.add('hidden');
    playlistResults.classList.add('hidden');

    try {
        const response = await fetch(`/info?url=${encodeURIComponent(url)}`);
        const data = await response.json();

        if (data.error) {
            status.innerHTML = `<span class="text-danger">${data.error}</span>`;
            return;
        }

        if (data.is_playlist) {
            playlistInfo = data;
            document.getElementById('playlistTitle').textContent = data.title;
            const playlistVideos = document.getElementById('playlistVideos');
            playlistVideos.innerHTML = data.videos.map(video => 
                `<p class="text-center">${video.title}</p>`
            ).join('');
            playlistResults.classList.remove('hidden');
            status.innerHTML = '<span class="text-success">Playlist ready to download!</span>';
        } else {
            document.getElementById('videoTitle').textContent = data.title;
            downloadId = data.id;
            results.classList.remove('hidden');
            status.innerHTML = '<span class="text-success">Video ready to download!</span>';
        }
    } catch (error) {
        status.innerHTML = '<span class="text-danger">Error processing URL</span>';
    }
}

function download(type) {
    if (!downloadId) {
        document.getElementById('status').innerHTML = '<span class="text-danger">No video selected</span>';
        return;
    }
    downloadSingle(type, downloadId, document.getElementById('youtubeUrl').value);
}

function downloadPlaylist(type) {
    if (!playlistInfo) {
        document.getElementById('status').innerHTML = '<span class="text-danger">No playlist selected</span>';
        return;
    }

    const quality = document.getElementById('qualitySelect').value;
    const fileType = document.getElementById('fileTypeSelect').value;
    const status = document.getElementById('status');
    const progressContainer = document.getElementById('progressContainer');
    const playlistId = playlistInfo.playlist_id;

    const progressSection = document.createElement('div');
    progressSection.classList.add('row', 'justify-content-center', 'mt-4');
    progressSection.id = `progress_${playlistId}`;
    progressSection.innerHTML = `
        <div class="col-md-8 col-lg-6">
            <div class="glass-effect p-3">
                <h4 class="text-center">Playlist: ${playlistInfo.title} (${type === 'video' ? 'Video' : 'Audio'})</h4>
                <div class="progress" style="height: 20px;">
                    <div id="progressBar_${playlistId}" class="progress-bar bg-success" role="progressbar" style="width: 0%;" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100"></div>
                </div>
                <p id="progressDetails_${playlistId}" class="text-center mt-2">Starting...</p>
                <div id="videoProgress_${playlistId}" class="mt-2"></div>
            </div>
        </div>
    `;
    progressContainer.appendChild(progressSection);

    const ws = new WebSocket(`ws://${window.location.host}/ws/${playlistId}`);
    wsConnections.set(playlistId, ws);

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        const progressBar = document.getElementById(`progressBar_${playlistId}`);
        const progressDetails = document.getElementById(`progressDetails_${playlistId}`);

        if (data.status === 'playlist_progress') {
            const percent = (data.completed / data.total) * 100;
            progressBar.style.width = `${percent}%`;
            progressBar.setAttribute('aria-valuenow', percent);
            progressDetails.textContent = `Progress: ${data.completed}/${data.total} videos completed`;
            if (data.completed === data.total) {
                status.innerHTML = '<span class="text-success">Playlist download finished!</span>';
                setTimeout(() => progressSection.remove(), 2000);
                ws.close();
                wsConnections.delete(playlistId);
            }
        }
    };

    playlistInfo.videos.forEach(video => {
        const uniqueDownloadId = `${video.id}_${Date.now()}`;
        downloadSingle(type, uniqueDownloadId, video.url, playlistId);
    });

    status.innerHTML = '<span class="text-warning">Playlist download started...</span>';
}

function downloadSingle(type, uniqueDownloadId, url, playlistId = null) {
    const quality = document.getElementById('qualitySelect').value;
    const fileType = document.getElementById('fileTypeSelect').value;
    const status = document.getElementById('status');
    const progressContainer = document.getElementById('progressContainer');

    const progressSection = playlistId ? 
        document.getElementById(`videoProgress_${playlistId}`) : 
        progressContainer;

    const videoDiv = document.createElement('div');
    videoDiv.id = `progress_${uniqueDownloadId}`;
    videoDiv.classList.add(playlistId ? 'mb-2' : 'row', playlistId ? '' : 'justify-content-center', 'mt-2');
    videoDiv.innerHTML = `
        ${playlistId ? '' : '<div class="col-md-8 col-lg-6">'}
        <div class="glass-effect p-2">
            <h5 class="text-center">${type === 'video' ? 'Video' : 'Audio'} (${quality})</h5>
            <div class="progress" style="height: 15px;">
                <div id="progressBar_${uniqueDownloadId}" class="progress-bar bg-success" role="progressbar" style="width: 0%;" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100"></div>
            </div>
            <p id="progressDetails_${uniqueDownloadId}" class="text-center mt-1">Queued...</p>
            <div class="d-flex justify-content-around gap-1 mt-1">
                <button id="cancel_${uniqueDownloadId}" class="neon-btn w-100" onclick="cancelDownload('${uniqueDownloadId}')">Cancel</button>
            </div>
        </div>
        ${playlistId ? '' : '</div>'}
    `;
    progressSection.appendChild(videoDiv);

    const ws = new WebSocket(`ws://${window.location.host}/ws/${uniqueDownloadId}`);
    wsConnections.set(uniqueDownloadId, ws);

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        const progressBar = document.getElementById(`progressBar_${uniqueDownloadId}`);
        const progressDetails = document.getElementById(`progressDetails_${uniqueDownloadId}`);
        const cancelButton = document.getElementById(`cancel_${uniqueDownloadId}`);

        if (data.status === 'queued') {
            progressDetails.textContent = `Queued (Position: ${data.position})`;
            if (!playlistId) status.innerHTML = '<span class="text-warning">Download queued</span>';
        } else if (data.status === 'downloading') {
            progressBar.style.width = `${data.percent}%`;
            progressBar.setAttribute('aria-valuenow', data.percent);
            progressDetails.textContent = `Progress: ${data.percent.toFixed(2)}% | Speed: ${data.speed} | ETA: ${data.eta}`;
            if (!playlistId) status.innerHTML = '<span class="text-warning">Downloading...</span>';
        } else if (data.status === 'finished') {
            progressBar.style.width = '100%';
            progressBar.setAttribute('aria-valuenow', 100);
            progressDetails.textContent = 'Download complete! Saving to your device...';
            if (!playlistId) status.innerHTML = '<span class="text-success">Download finished!</span>';
            cancelButton.style.display = 'none';
            if (!playlistId) setTimeout(() => videoDiv.remove(), 2000);
            ws.close();
            wsConnections.delete(uniqueDownloadId);
        } else if (data.status === 'error') {
            progressDetails.textContent = data.message;
            if (!playlistId) status.innerHTML = '<span class="text-danger">Download failed</span>';
            cancelButton.style.display = 'none';
        } else if (data.status === 'canceled') {
            progressDetails.textContent = 'Canceled';
            if (!playlistId) status.innerHTML = '<span class="text-warning">Download canceled</span>';
            cancelButton.style.display = 'none';
            if (!playlistId) setTimeout(() => videoDiv.remove(), 2000);
            ws.close();
            wsConnections.delete(uniqueDownloadId);
        }
    };

    ws.onerror = () => {
        if (!playlistId) status.innerHTML = '<span class="text-danger">WebSocket error</span>';
        videoDiv.remove();
        wsConnections.delete(uniqueDownloadId);
    };

    const effectiveType = quality === 'audio' ? 'audio' : type;

    fetch(`/download?url=${encodeURIComponent(url)}&type=${effectiveType}&quality=${quality}&format=${fileType}&download_id=${uniqueDownloadId}${playlistId ? `&playlist_id=${playlistId}` : ''}`)
        .then(response => response.json())
        .then(data => console.log(data.message))
        .catch(error => console.error('Error queuing download:', error));
}

function cancelDownload(downloadId) {
    fetch(`/cancel/${downloadId}`)
        .then(response => response.json())
        .then(data => console.log(data.message))
        .catch(error => console.error('Error canceling download:', error));
}

document.getElementById('results').classList.add('hidden');
document.getElementById('playlistResults').classList.add('hidden');