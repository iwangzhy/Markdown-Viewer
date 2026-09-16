# Use nginx as the base image for serving static files
FROM nginx:alpine

# Copy the static files to the nginx html directory
COPY . /usr/share/nginx/html/

# Create a custom nginx configuration for SPA routing
RUN echo 'server { \
    listen 80; \
    server_name localhost; \
    root /usr/share/nginx/html; \
    index index.html; \
    \
    # Handle client-side routing for SPA \
    location / { \
    expires -1; \
    try_files $uri $uri/ /index.html; \
    } \
    \
    # JS/CSS 文件名固定，每次加载都需校验版本，避免更新后继续运行旧的导出逻辑 \
    location ~* \.(js|css)$ { \
    expires -1; \
    } \
    \
    # Cache image assets \
    location ~* \.(png|jpg|jpeg|gif|ico|svg)$ { \
    expires 1y; \
    add_header Cache-Control "public, immutable"; \
    } \
    \
    # Security headers \
    add_header X-Frame-Options "SAMEORIGIN" always; \
    add_header X-Content-Type-Options "nosniff" always; \
    add_header X-XSS-Protection "1; mode=block" always; \
    add_header Referrer-Policy "strict-origin-when-cross-origin" always; \
    }' > /etc/nginx/conf.d/default.conf

# Expose port 80
EXPOSE 80

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
