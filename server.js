const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Allow all origins for now (dev mode)
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(cors());
app.use(express.json());

// Ensure directories exist
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'outputs');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

// Serve static files (outputs)
app.use('/download', express.static(OUTPUT_DIR));

// 🚀 SERVE FRONTEND (Production)
// In production, we assume frontend is built to ../frontend/dist
const FRONTEND_DIST = path.join(__dirname, '../frontend/dist');
if (fs.existsSync(FRONTEND_DIST)) {
    app.use(express.static(FRONTEND_DIST));
    app.get('*', (req, res) => {
        // Exclude /download and /upload/ (API)
        if (req.path.startsWith('/download') || req.path.startsWith('/upload')) return;
        res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
    });
}

// Multer setup for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOADS_DIR);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage });

// FFmpeg Path: Check environment or default to system 'ffmpeg'
const isWin = process.platform === "win32";
// If on local windows, use the known path, otherwise (Render/Linux) use 'ffmpeg'
const ffmpegPath = isWin 
    ? "C:\\Users\\aatmi\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.0.1-full_build\\bin\\ffmpeg.exe"
    : "ffmpeg";

// Socket.io connection
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

// Helper: Run Command
function runCommand(command, socket) {
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                if (socket) socket.emit('log', `❌ Error: ${error.message}`);
                reject(error);
            } else {
                resolve(stdout);
            }
        });
    });
}

// Processing Logic
async function processVideo(filePath, originalName, socket) {
    const jobId = path.basename(filePath, path.extname(filePath));
    const audioFile = path.join(UPLOADS_DIR, `${jobId}.wav`);
    
    // Use path.join for cross-platform compatibility
    const finalVideoName = `subtitled_${jobId}.mp4`; // Safer name
    const finalVideo = path.join(OUTPUT_DIR, finalVideoName);
    
    const cleanup = () => {
        if (fs.existsSync(audioFile)) fs.unlinkSync(audioFile);
    };

    try {
        // Step 1: Extract Audio
        socket.emit('log', '🎵 Step 1: Extracting audio...');
        socket.emit('progress', 10);
        await runCommand(`"${ffmpegPath}" -y -i "${filePath}" -ar 16000 -ac 1 -c:a pcm_s16le "${audioFile}"`, socket);
        socket.emit('log', '✅ Audio extracted.');

        // Step 2: Transcribe (Whisper)
        socket.emit('log', '🧠 Step 2: Generating subtitles (Whisper)...');
        socket.emit('progress', 30);
        
        // Ensure Whisper finds ffmpeg (Windows Hack, not needed on Linux usually)
        if (isWin) {
            const ffmpegDir = path.dirname(ffmpegPath);
            process.env.PATH = `${ffmpegDir};${process.env.PATH}`;
        }

        const whisperCmd = `whisper "${audioFile}" --model base --output_format srt --output_dir "${OUTPUT_DIR}"`;
        await runCommand(whisperCmd, socket);
        socket.emit('log', '✅ Subtitles generated.');
        
        const generatedSrt = path.join(OUTPUT_DIR, `${jobId}.srt`);

        // Step 3: Burn Subtitles
        socket.emit('log', '🎥 Step 3: Burning subtitles into video...');
        socket.emit('progress', 60);

        // Copy SRT to local temp (Workaround for FFmpeg escaping on Windows/Linux)
        const localSrtName = `temp_${jobId}.srt`;
        const localSrt = path.join(__dirname, localSrtName);
        
        if (fs.existsSync(generatedSrt)) {
             fs.copyFileSync(generatedSrt, localSrt);
        } else {
            throw new Error("SRT file was not generated.");
        }

        // Style
        const style = "Fontname=Arial,Fontsize=10,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=1,Shadow=0,Bold=0,MarginV=10,Alignment=2";
        
        // Important: escape helper for paths in ffmpeg filters
        // Using relative path 'localSrtName' is safest if CWD is correct.
        const burnCmd = `"${ffmpegPath}" -y -i "${filePath}" -vf "subtitles='${localSrtName}':force_style='${style}'" "${finalVideo}"`;
        
        await runCommand(burnCmd, socket);
        
        // Cleanup temp srt
        if (fs.existsSync(localSrt)) fs.unlinkSync(localSrt);

        socket.emit('log', '✅ Video processing complete!');
        socket.emit('progress', 100);
        
        // Return relative path for download
        const downloadUrl = `/download/${finalVideoName}`;
        socket.emit('complete', { downloadUrl });
        
        cleanup();

    } catch (err) {
        console.error(err);
        socket.emit('error', err.message);
        socket.emit('log', `❌ Error: ${err.message}`);
    }
}

// Upload Endpoint
app.post('/upload', upload.single('video'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    const socketId = req.body.socketId;
    const socket = io.sockets.sockets.get(socketId);

    if (!socket) {
        console.log("Socket not found for ID:", socketId);
    } else {
        socket.emit('log', '🚀 Received file. Starting process...');
    }

    // Start processing in background
    processVideo(req.file.path, req.file.originalname, socket);

    res.json({ message: 'Upload successful, processing started', jobId: req.file.filename });
});

const PORT = 5000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
