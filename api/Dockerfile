FROM golang:alpine AS build

WORKDIR /src
COPY go.mod ./
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -o /bin/api .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=build /bin/api /bin/api
EXPOSE 8080
CMD ["/bin/api"]
