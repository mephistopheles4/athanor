FROM alpine:3.20
RUN apk add --no-cache busybox-extras && adduser -D app && mkdir -p /home/app/work && chown app /home/app/work
USER app
WORKDIR /home/app/work
RUN mkdir cache && echo from-image > cache/seed.txt
