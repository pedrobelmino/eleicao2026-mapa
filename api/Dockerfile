FROM golang:alpine AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /bin/api .

FROM alpine:3.20
# wget é do healthcheck do compose; ca-certificates, do GeoIP/API externa.
RUN apk add --no-cache ca-certificates wget
COPY --from=build /bin/api /bin/api
EXPOSE 8080
CMD ["/bin/api"]
