# Game server for Cloud Run: one small static binary plus the event/geo JSON.
FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
# agent talk's config and question bank are embedded (go:embed talkdata/*.json)
COPY talkdata/*.json ./talkdata/
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /server .

FROM gcr.io/distroless/static-debian12
WORKDIR /app
COPY --from=build /server /app/server
COPY event.json geo.json /app/
# Cloud Run sends PORT=8080; the client is served by Vercel, so no static dir here.
ENTRYPOINT ["/app/server", "-addr", ":8080", "-static", "/nonexistent", "-samples", "/tmp/geo_samples.jsonl"]
