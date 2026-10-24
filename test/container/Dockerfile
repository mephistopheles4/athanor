# The image athanor runs this repo's own tests in (athanor.json, ADR 0024).
# The build has network: it installs the compiler from the lockfile, with
# install scripts off, into the folder the snapshot later unpacks over.
FROM node:24-alpine
RUN apk add --no-cache git
USER node
WORKDIR /home/node/work
COPY --chown=node:node package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts && rm package.json package-lock.json .npmrc
