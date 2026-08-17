# Use Node.js 18 LTS as base image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy dependency definitions
COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev

# Copy application source files
COPY . .

# Expose port (default Node port or custom)
EXPOSE 7000

# Set environment variable for port
ENV PORT=7000

# Start the application
CMD ["node", "server.js"]
