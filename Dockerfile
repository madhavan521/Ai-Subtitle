FROM node:20

# 1. Install System Dependencies (FFmpeg, Python, Pip)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# 2. Install OpenAI Whisper
RUN pip3 install openai-whisper --break-system-packages

# Set Working Directory
WORKDIR /app

# 3. Install Node Dependencies
COPY package*.json ./
RUN npm install

# 4. Copy Server Code
COPY server.js ./

# 5. Create necessary folders
RUN mkdir uploads outputs

# 6. Start Server
EXPOSE 5000
CMD ["node", "server.js"]
