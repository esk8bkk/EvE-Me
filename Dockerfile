# EvE Me + Tesla signing proxy in one Render service (free tier).
FROM golang:1.23-bookworm AS proxy
RUN go install github.com/teslamotors/vehicle-command/cmd/tesla-http-proxy@latest

FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=proxy /go/bin/tesla-http-proxy /usr/local/bin/tesla-http-proxy
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN chmod +x start.sh
ENV TESLA_PROXY_URL=https://localhost:4443 TESLA_PROXY_CA=/tmp/proxy-tls-cert.pem
CMD ["./start.sh"]
